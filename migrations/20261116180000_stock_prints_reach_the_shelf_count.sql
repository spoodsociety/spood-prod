-- One shelf count on every page (Nov 16, 2026).
--
-- 1. Stock prints reach the count when the batch is finalized. Before this, a piece finalized "to stock" in the Print Plan
--    sat in a pending list until a person tapped "Add to Inventory" (never used: 0 movements with ref 'printplan'), so the
--    Print Plan showed shelf + pending while Inventory and Bin View showed the shelf alone, and a line the plan had shown
--    as Printed fell back to Needs printing at finalize. Now the plan save that finalizes the batch records the movement
--    in the same transaction (hq.plan_stock_sync, called from set_app_state). hq.plan_stock remembers what each batch has
--    put on the shelf, so a save is safe to repeat, and reopening or undoing a finalize takes the pieces back off.
--    Only items the new app marks (outcome.auto) are handled; older finalized pieces stay in the plan's pending list for
--    a person to add or dismiss.
-- 2. A shelf count typed against an old number is not saved over a newer one. apply_moves takes an optional `expect` on a
--    count; if the shelf changed since the person saw it (an order went Done, a batch was finalized), that count comes
--    back with status 'changed' and nothing is recorded.

create table if not exists hq.plan_stock (
  batch_id   text    not null,
  variant_id bigint  not null references hq.variants(id),
  qty        integer not null check (qty > 0),
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (batch_id, variant_id)
);
alter table hq.plan_stock enable row level security;
revoke all on table hq.plan_stock from public, anon, authenticated;

create or replace function hq.plan_stock_sync(p_plan jsonb, p_op text, p_by text default null) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
declare r record; v_have integer; v_take integer; v_added jsonb := '[]'::jsonb; v_back jsonb := '[]'::jsonb; v_short jsonb := '[]'::jsonb;
begin
  for r in
    with batches as (
      select b from jsonb_path_query(coalesce(p_plan, '{}'::jsonb), '$.lanes.*[*]') b where nullif(b->>'id', '') is not null),
    present as (select b->>'id' batch_id, max(b->>'name') batch_name from batches group by 1),
    want as (
      select b->>'id' batch_id, v.id variant_id, count(*)::integer qty
      from batches
      cross join lateral jsonb_array_elements(case when jsonb_typeof(b->'items') = 'array' then b->'items' else '[]'::jsonb end) it
      join hq.variants v on v.notion_inventory_id = lower(replace(coalesce(it->'spec'->>'inv', ''), '-', ''))
      join hq.stock_on_hand s on s.variant_id = v.id          -- tracked pieces only
      where b->>'state' = 'done' and it->'outcome'->>'to' = 'stock' and it->'outcome'->>'auto' = 'true'
      group by 1, 2)
    select x.batch_id, p.batch_name, x.variant_id, x.want, x.have, vv.sku, coalesce(vv.inventory_name, vv.sku) item, vv.notion_inventory_id notion_id
    from (select coalesce(w.batch_id, a.batch_id) batch_id, coalesce(w.variant_id, a.variant_id) variant_id, coalesce(w.qty, 0) want, coalesce(a.qty, 0) have
          from want w full join hq.plan_stock a on a.batch_id = w.batch_id and a.variant_id = w.variant_id) x
    join present p on p.batch_id = x.batch_id                  -- a batch no longer in the plan is history: its stock stays
    join hq.variants vv on vv.id = x.variant_id
    where x.want <> x.have
    order by x.batch_id, x.variant_id
  loop
    if r.want > r.have then
      perform hq.record_move(p_op || ':' || r.batch_id || ':' || r.variant_id, r.sku, 'print', r.want - r.have,
                             'printplan', 'Printed for stock: ' || coalesce(r.batch_name, r.batch_id), p_by, 'hq');
      v_added := v_added || jsonb_build_object('notion_id', r.notion_id, 'item', r.item, 'qty', r.want - r.have, 'batch', r.batch_name);
    else
      select greatest(coalesce(s.on_hand, 0), 0) into v_have from hq.stock_on_hand s where s.variant_id = r.variant_id;
      v_take := least(r.have - r.want, coalesce(v_have, 0));   -- a count never goes below zero
      if v_take > 0 then
        perform hq.record_move(p_op || ':' || r.batch_id || ':' || r.variant_id, r.sku, 'adjust', -v_take,
                               'printplan', 'Stock batch reopened: ' || coalesce(r.batch_name, r.batch_id), p_by, 'hq');
        v_back := v_back || jsonb_build_object('notion_id', r.notion_id, 'item', r.item, 'qty', v_take, 'batch', r.batch_name);
      end if;
      if v_take < r.have - r.want then
        v_short := v_short || jsonb_build_object('notion_id', r.notion_id, 'item', r.item, 'wanted', r.have - r.want, 'taken', v_take, 'batch', r.batch_name);
      end if;
    end if;
    if r.want > 0 then
      insert into hq.plan_stock (batch_id, variant_id, qty, updated_by) values (r.batch_id, r.variant_id, r.want, p_by)
      on conflict (batch_id, variant_id) do update set qty = excluded.qty, updated_at = now(), updated_by = excluded.updated_by;
    else
      delete from hq.plan_stock where batch_id = r.batch_id and variant_id = r.variant_id;
    end if;
  end loop;

  if jsonb_array_length(v_added) + jsonb_array_length(v_back) + jsonb_array_length(v_short) > 0 then
    insert into hq.app_log (op_id, kind, data, by_user)
    values (p_op || ':stock', 'plan_stock', jsonb_build_object('added', v_added, 'taken_back', v_back, 'short', v_short), p_by);
  end if;
  return jsonb_build_object('added', v_added, 'taken_back', v_back, 'short', v_short);
end $function$;
revoke all on function hq.plan_stock_sync(jsonb, text, text) from public, anon, authenticated;

create or replace function hq.set_app_state(p jsonb, p_by text default null) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
declare
  v_op  text := nullif(trim(p->>'op_id'), '');
  v_key text := nullif(trim(p->>'key'), '');
  v_old hq.app_ops; v_cur integer; v_new integer; v_res jsonb; v_given integer; n integer; v_applied integer := 0; v_stock jsonb;
begin
  if v_op is null then raise exception 'set_app_state: op_id is required'; end if;
  select * into v_old from hq.app_ops where op_id = v_op;
  if found then
    if v_old.payload = p then return v_old.result || '{"duplicate":true}'; end if;
    raise exception 'op_id % was already used for a different save', v_op;
  end if;
  if v_key is null then raise exception 'set_app_state: key is required'; end if;
  if jsonb_typeof(p->'value') is distinct from 'object' then raise exception 'set_app_state: value must be an object'; end if;
  v_given := case when jsonb_typeof(p->'version') = 'number' then (p->>'version')::integer else null end;

  select version into v_cur from hq.app_state where key = v_key for update;
  if found then
    if v_given is distinct from v_cur then
      raise exception 'stale: % changed since it was read (now version %); read it again and save again', v_key, v_cur using errcode = 'P0001';
    end if;
    v_new := v_cur + 1;
    update hq.app_state set value = p->'value', version = v_new, updated_at = now(), updated_by = p_by where key = v_key;
  else
    if coalesce(v_given, 0) <> 0 then
      raise exception 'stale: % no longer exists; read it again and save again', v_key using errcode = 'P0001';
    end if;
    v_new := 1;
    insert into hq.app_state (key, value, version, updated_by) values (v_key, p->'value', 1, p_by) on conflict (key) do nothing;
    get diagnostics n = row_count;
    if n = 0 then raise exception 'stale: % was just created by someone else; read it again and save again', v_key using errcode = 'P0001'; end if;
  end if;
  -- the plan decides print status and puts finalized stock prints on the shelf, in this same transaction (stock first, so status sees the new count)
  if v_key = 'printplan2/main' then
    v_stock := hq.plan_stock_sync(p->'value', v_op, p_by);
    v_applied := hq.plan_apply(p->'value', p_by);
  end if;
  v_res := jsonb_build_object('key', v_key, 'version', v_new, 'lines_updated', v_applied) || case when v_stock is null then '{}'::jsonb else jsonb_build_object('stock', v_stock) end;
  insert into hq.app_ops (op_id, key, payload, result, by_user) values (v_op, v_key, p, v_res, p_by);
  return v_res;
end $function$;

create or replace function hq.apply_moves(p_moves jsonb, p_by text default null, p_source text default 'hq')
returns table(op_id text, notion_id text, status text, on_hand integer)
language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
declare m jsonb; v_sku text; r record; v_now integer;
begin
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then
    raise exception 'apply_moves needs a non-empty list of moves';
  end if;
  for m in select value from jsonb_array_elements(p_moves) loop
    v_sku := null;
    select v.sku into v_sku from hq.variants v where v.notion_inventory_id = m->>'notion_id';
    if v_sku is null then raise exception 'Not in the Supabase catalog: Notion row %', m->>'notion_id'; end if;
    -- a count typed against a number that has since changed is handed back, not saved over the newer number
    if m->>'kind' = 'count' and nullif(m->>'expect', '') is not null
       and not exists (select 1 from hq.inventory_movements im where im.op_id = m->>'op_id') then
      select coalesce(s.on_hand, 0) into v_now from hq.stock_on_hand s where s.sku = v_sku;
      if coalesce(v_now, 0) <> (m->>'expect')::integer then
        op_id := m->>'op_id'; notion_id := m->>'notion_id'; status := 'changed'; on_hand := coalesce(v_now, 0);
        return next; continue;
      end if;
    end if;
    select * into r from hq.record_move(m->>'op_id', v_sku, m->>'kind', (m->>'qty')::integer,
                                         m->>'ref', m->>'reason', p_by, p_source);
    op_id := m->>'op_id'; notion_id := m->>'notion_id'; status := r.status;
    select s.on_hand into on_hand from hq.stock_on_hand s where s.sku = v_sku;
    return next;
  end loop;
end $function$;
