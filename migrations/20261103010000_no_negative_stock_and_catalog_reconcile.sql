-- 1. No shelf count can go below zero: every stock movement is checked at insert time, whatever wrote it.
-- 2. Mark Done takes only what the shelf has and reports the shortfall ('short' in the result) instead of
--    going negative or refusing the shipment; Undo puts back exactly what was taken.
-- 3. inventory_rows: a kit (complete enclosure) has no shelf count of its own -> in_stock null, not a fake 0.
-- 4. archive_variant refuses while open orders still use the item.
-- 5. Reconcile: the three variants made by hand without an HQ id get one, so Inventory and Bin View can see them.

create or replace function hq.check_movement()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare f text; t boolean; v_have integer; v_name text;
begin
  select p.fulfillment_type, p.tracked, coalesce(v.inventory_name, v.sku) into f, t, v_name
    from hq.variants v join hq.products p on p.id = v.product_id where v.id = new.variant_id;
  if f <> 'individual' then raise exception 'Stock moves go on the pieces, not the set (variant %)', new.variant_id; end if;
  if not t then raise exception 'Variant % belongs to an untracked product', new.variant_id; end if;
  if new.kind <> 'count' and coalesce(new.qty_change, 0) < 0 then
    select coalesce(s.on_hand, 0) into v_have from hq.stock_on_hand s where s.variant_id = new.variant_id;
    if coalesce(v_have, 0) + new.qty_change < 0 then
      raise exception 'Only % on the shelf for "%"; can''t take %', coalesce(v_have, 0), v_name, -new.qty_change;
    end if;
  end if;
  return new;
end $function$;

create or replace function hq.complete_order(p jsonb, p_moves jsonb default '[]'::jsonb, p_by text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare
  v_op text := nullif(trim(p->>'op_id'), ''); v_id text := lower(nullif(trim(p->>'id'), ''));
  v_status text; v_res jsonb; v_epoch integer; v_list jsonb; v_apply jsonb; v_stock jsonb := '[]'::jsonb; v_back jsonb; v_open boolean; m jsonb;
  v_short jsonb := '[]'::jsonb;
begin
  if v_op is null then raise exception 'complete_order: op_id is required'; end if;
  if v_id is null then raise exception 'complete_order: which order?'; end if;
  if replace(trim(coalesce(p->>'status', '')), '*', '') <> 'Done' then raise exception 'complete_order: status must be Done'; end if;
  if jsonb_typeof(coalesce(p_moves, '[]'::jsonb)) <> 'array' then raise exception 'complete_order: moves must be a list'; end if;
  if exists (select 1 from hq.saved_ops where op_id = v_op) then return hq.save_order(p, p_by); end if;

  for m in select value from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) loop
    if lower(replace(coalesce(m->>'notion_id', ''), '-', '')) !~ '^[0-9a-f]{32}$' then raise exception 'complete_order: bad item id %', m->>'notion_id'; end if;
    if coalesce(m->>'qty', '') !~ '^[0-9]+$' or (m->>'qty')::integer < 1 then raise exception 'complete_order: quantity must be a whole number above 0'; end if;
    if not exists (select 1 from hq.variants v where v.notion_inventory_id = lower(replace(m->>'notion_id', '-', ''))) then
      raise exception 'Not in the Supabase catalog: item %', m->>'notion_id';
    end if;
  end loop;

  select status into v_status from hq.orders where id = v_id and deleted_at is null for update;
  v_open := exists (select 1 from hq.order_stock_moves where order_id = v_id and undone_at is null);
  if v_open and v_status = 'Done' then raise exception 'already Done: this order''s stock was already taken'; end if;

  v_res := hq.save_order(p, p_by);
  if v_open then v_back := hq.return_order_stock(v_id, p_by); end if;
  v_epoch := coalesce((select max(epoch) from hq.order_stock_moves where order_id = v_id), 0) + 1;

  -- what the browser wants to take, per item, capped at what the shelf has right now (never below zero)
  with want as (
    select lower(replace(m2->>'notion_id', '-', '')) k, sum((m2->>'qty')::integer)::integer q
    from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) m2 group by 1),
  have as (
    select w.k, w.q, greatest(coalesce(s.on_hand, 0), 0) h, coalesce(v.inventory_name, v.sku) nm
    from want w join hq.variants v on v.notion_inventory_id = w.k left join hq.stock_on_hand s on s.variant_id = v.id)
  select coalesce(jsonb_agg(jsonb_build_object('op_id', 'done:' || v_id || ':' || v_epoch || ':' || k, 'notion_id', k, 'qty', least(q, h)) order by k) filter (where least(q, h) > 0), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('notion_id', k, 'item', nm, 'wanted', q, 'taken', least(q, h)) order by k) filter (where q > h), '[]'::jsonb)
    into v_list, v_short from have;

  if jsonb_array_length(v_list) > 0 then
    select jsonb_agg(jsonb_build_object('op_id', e->>'op_id', 'notion_id', e->>'notion_id', 'kind', 'sale', 'qty', -(e->>'qty')::integer,
                                        'ref', v_id, 'reason', 'Order done: ' || coalesce(p->>'customer', '')))
      into v_apply from jsonb_array_elements(v_list) e;
    select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_stock from hq.apply_moves(v_apply, p_by) a;
  end if;
  insert into hq.order_stock_moves (order_id, epoch, moves, done_by) values (v_id, v_epoch, v_list, p_by);
  if jsonb_array_length(v_short) > 0 then
    insert into hq.app_log (op_id, kind, data, by_user)
    values ('short-' || v_op, 'done_stock_short', jsonb_build_object('order_id', v_id, 'customer', p->>'customer', 'short', v_short), p_by);
  end if;
  return v_res || jsonb_build_object('epoch', v_epoch, 'stock', v_stock, 'short', v_short);
end $function$;

create or replace function hq.inventory_rows()
 returns table(id text, item text, collection text, in_stock integer, tracked boolean, note text, sku text, updated_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
  select v.notion_inventory_id, coalesce(v.inventory_name, v.sku), k.collection,
         case when p.tracked and p.fulfillment_type = 'individual' then coalesce(s.on_hand, 0) end,
         p.tracked and p.fulfillment_type = 'individual', v.note, v.sku, v.updated_at
  from hq.variants v
  join hq.products p on p.id = v.product_id
  join hq.catalog k on k.variant_id = v.id
  left join hq.stock_on_hand s on s.variant_id = v.id
  where v.notion_inventory_id is not null and not v.archived
  order by k.collection nulls last, coalesce(v.inventory_name, v.sku)
$function$;

create or replace function hq.archive_variant(p_id text)
 returns text
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare v hq.variants; n integer;
begin
  select * into v from hq.variants x where x.notion_inventory_id = lower(replace(coalesce(p_id, ''), '-', '')) for update;
  if not found then raise exception 'Not in the catalog: item %', p_id; end if;
  if v.archived then return 'already'; end if;
  select s.on_hand into n from hq.stock_on_hand s where s.variant_id = v.id;
  if coalesce(n, 0) <> 0 then raise exception '"%" still has % in stock; count it to 0 first', coalesce(v.inventory_name, v.sku), n; end if;
  select count(*) into n from hq.order_lines l join hq.orders o on o.id = l.order_id
   where l.variant_id = v.id and o.status <> 'Done' and o.deleted_at is null;
  if n > 0 then raise exception '"%" is on % open order line%; change those lines first', coalesce(v.inventory_name, v.sku), n, case when n = 1 then '' else 's' end; end if;
  update hq.variants x set archived = true where x.id = v.id;
  return 'archived';
end $function$;

-- reconcile: HQ ids for the variants made without one
update hq.variants set notion_inventory_id = replace(gen_random_uuid()::text, '-', '')
 where notion_inventory_id is null and id in (121, 122, 123);
