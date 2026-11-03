-- The database decides, browsers show.
-- 1. hq.shelf_alloc(): which open order line gets which shelf piece (soonest ship date, express first on a tie, then first
--    listed), and each line's kind (enc / stock / print). read_orders returns kind + alloc per line; inventory_rows returns
--    owed per item. Browsers no longer compute allocation.
-- 2. hq.plan_apply(plan): derives every open line's print status (printing / printed / automatic) from the saved Print Plan.
--    Runs inside set_app_state for the plan key, and again (statement trigger) whenever orders or lines change. The browser
--    sync (binDesired / syncBin / memo) is gone: a stale tab cannot push anything, and nothing can drift.
-- 3. complete_order takes stock from the server's own allocation; the browser's move list is no longer trusted.

create or replace function hq.is_custom(t text) returns boolean language sql immutable set search_path to '' as $$
  select coalesce(t, '') ~* '(custom|[0-9]+(\.[0-9]+)?\s*(cm|mm|in\M|inch|"|”|″)|[0-9]\s*[x×]\s*[0-9])'
$$;

-- enc: an enclosure line; stock: a bought/assembled thing that is never printed; print: a printed piece
create or replace function hq.line_kind(p_text text, p_match text, p_product text, p_category text) returns text language sql stable set search_path to '' as $$
  select case
    when p_product = 'enclosure' or hq.is_enc_line(p_text) then 'enc'
    when p_match = 'untracked' then 'stock'
    when p_category in ('Add-on', 'Supply', 'Kit', 'Set') then 'stock'
    when coalesce(p_text, '') ~* '(starter\s*kit|c[ao]+c+o+n|\mplants?\M|substrate|moss|mystery|magnetic background|figurine|add[- ]?on\M)'
         and not (regexp_replace(coalesce(p_text, ''), 'starter\s*kit', '', 'gi') ~* '\m(hide|ledge|climb|floor|insert|cauldron|bowl|feeder)\M') then 'stock'
    else 'print' end
$$;

-- shelf allocation for every line of every open order (same rule as the old browser recompute())
create or replace function hq.shelf_alloc()
 returns table(seq integer, uid uuid, order_id text, line_no integer, kind text, alloc integer, needs integer, variant_id bigint, notion_id text)
 language plpgsql stable set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare r record; v_left integer; v_take integer; v_shelf jsonb; v_key text;
begin
  select coalesce(jsonb_object_agg(s.variant_id::text, greatest(coalesce(s.on_hand, 0), 0)), '{}'::jsonb) into v_shelf from hq.stock_on_hand s where not s.archived;
  seq := 0;
  for r in
    select l.uid, l.order_id, l.line_no, l.qty, l.text, l.match, l.print_state, l.packed, l.packed_from, l.variant_id, v.notion_inventory_id,
           hq.line_kind(l.text, l.match, v.product_id, p.category) kind, (s.variant_id is not null) tracked
    from hq.orders o
    join hq.order_lines l on l.order_id = o.id
    left join hq.variants v on v.id = l.variant_id
    left join hq.products p on p.id = v.product_id
    left join hq.stock_on_hand s on s.variant_id = v.id
    where o.status <> 'Done' and o.deleted_at is null
    order by o.ship_by nulls last, (o.ship_type = 'Express') desc, o.created_at, o.id, l.line_no
  loop
    seq := seq + 1; uid := r.uid; order_id := r.order_id; line_no := r.line_no; kind := r.kind; alloc := 0; needs := 0; variant_id := r.variant_id; notion_id := r.notion_inventory_id;
    if r.tracked and not (r.kind = 'print' and (r.print_state <> '' or (r.packed and coalesce(r.packed_from, 'print') = 'print') or hq.is_custom(r.text))) then
      needs := r.qty; v_key := r.variant_id::text;
      v_left := coalesce((v_shelf->>v_key)::integer, 0);
      v_take := least(v_left, r.qty);
      if v_take > 0 then alloc := v_take; v_shelf := jsonb_set(v_shelf, array[v_key], to_jsonb(v_left - v_take)); end if;
    end if;
    return next;
  end loop;
end $function$;

drop function if exists hq.order_json(text);   -- replaced by the two-argument form below (a default keeps the one-argument calls working)
create or replace function hq.order_json(p_id text, p_alloc jsonb default null)
 returns jsonb language sql stable set search_path to ''
as $function$
  select to_jsonb(o) || jsonb_build_object('lines', coalesce((
           select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'text', l.text, 'note', l.note, 'qty', l.qty, 'match', l.match, 'tag', l.tag,
                    'variant_id', l.variant_id, 'sku', v.sku, 'notion_inventory_id', v.notion_inventory_id,
                    'uid', l.uid, 'group_uid', l.group_uid, 'print_state', l.print_state, 'print_at', l.print_at, 'print_src', l.print_src,
                    'packed', l.packed, 'packed_at', l.packed_at, 'packed_from', l.packed_from, 'state_by', l.state_by,
                    'kind', coalesce(p_alloc->(l.uid::text)->>'kind', hq.line_kind(l.text, l.match, v.product_id, p.category)),
                    'alloc', coalesce((p_alloc->(l.uid::text)->>'alloc')::integer, 0)) order by l.line_no)
           from hq.order_lines l left join hq.variants v on v.id = l.variant_id left join hq.products p on p.id = v.product_id
           where l.order_id = o.id), '[]'::jsonb))
       || coalesce((
           select jsonb_build_object('done_at', h.at, 'done_by', h.by_user, 'done_prev', h.before->>'status')
           from hq.order_history h
           where o.status = 'Done' and h.order_id = o.id and h.source = 'hq'
             and h.after->>'status' = 'Done' and coalesce(h.before->>'status', '') <> 'Done'
           order by h.at desc limit 1), '{}'::jsonb)
  from hq.orders o where o.id = p_id
$function$;

create or replace function hq.read_orders(p_status text default 'open', p_id text default null)
 returns jsonb language sql stable security definer set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
  with a as (select coalesce(jsonb_object_agg(x.uid::text, jsonb_build_object('kind', x.kind, 'alloc', x.alloc)), '{}'::jsonb) j from hq.shelf_alloc() x)
  select coalesce(jsonb_agg(hq.order_json(o.id, a.j) order by o.ship_by nulls last, o.created_at, o.id), '[]'::jsonb)
  from hq.orders o, a
  where o.deleted_at is null
    and ((p_id is not null and o.id = lower(p_id))
     or (p_id is null and (p_status = 'all' or (p_status = 'open' and o.status <> 'Done') or (p_status = 'done' and o.status = 'Done'))))
$function$;

drop function if exists hq.inventory_rows();
create function hq.inventory_rows()
 returns table(id text, item text, collection text, in_stock integer, tracked boolean, note text, sku text, updated_at timestamp with time zone, owed integer)
 language sql stable security definer set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
  with w as (select x.variant_id, sum(x.needs)::integer n from hq.shelf_alloc() x group by 1)
  select v.notion_inventory_id, coalesce(v.inventory_name, v.sku), k.collection,
         case when p.tracked and p.fulfillment_type = 'individual' then coalesce(s.on_hand, 0) end,
         p.tracked and p.fulfillment_type = 'individual', v.note, v.sku, v.updated_at, coalesce(w.n, 0)
  from hq.variants v
  join hq.products p on p.id = v.product_id
  join hq.catalog k on k.variant_id = v.id
  left join hq.stock_on_hand s on s.variant_id = v.id
  left join w on w.variant_id = v.id
  where v.notion_inventory_id is not null and not v.archived
  order by k.collection nulls last, coalesce(v.inventory_name, v.sku)
$function$;
grant execute on function hq.inventory_rows() to authenticated;

-- the Print Plan -> every open line's print status, in one place
create or replace function hq.plan_apply(p_plan jsonb, p_by text default null)
 returns integer language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare b jsonb; it jsonb; d text; v_uid uuid; v_state text; r record; n integer := 0; v_cur text; v_src text; v_want text;
        v_pc integer; v_pd integer; v_inv text; v_need integer; k integer;
begin
  perform set_config('hq.applying', '1', true);
  create temp table if not exists _want (uid uuid primary key, printing integer default 0, printed integer default 0) on commit drop;
  create temp table if not exists _stock (inv text primary key, printing integer default 0, printed integer default 0) on commit drop;
  create temp table if not exists _inbatch (uid uuid primary key) on commit drop;
  delete from _want; delete from _stock; delete from _inbatch;

  for b in select value from jsonb_path_query(coalesce(p_plan, '{}'::jsonb), '$.lanes.*[*]') loop
    v_state := b->>'state';
    for it in select value from jsonb_array_elements(coalesce(b->'items', '[]'::jsonb)) loop
      if nullif(it->>'pieceId', '') is not null then
        -- a piece for an order line: printing while its batch prints, printed once the batch is in review / done and it goes to that order
        begin v_uid := split_part(it->>'pieceId', '#', 1)::uuid; exception when others then continue; end;
        insert into _inbatch values (v_uid) on conflict do nothing;
        if v_state = 'printing' then
          insert into _want (uid, printing) values (v_uid, 1) on conflict (uid) do update set printing = _want.printing + 1;
        elsif v_state = 'review' then
          d := coalesce(it->>'dest', 'piece:' || (it->>'pieceId'));
          if d like 'piece:%' then
            begin v_uid := split_part(substr(d, 7), '#', 1)::uuid; exception when others then continue; end;
            insert into _inbatch values (v_uid) on conflict do nothing;
            insert into _want (uid, printed) values (v_uid, 1) on conflict (uid) do update set printed = _want.printed + 1;
          end if;
        elsif v_state = 'done' and it->'outcome'->>'to' = 'piece' then
          begin v_uid := split_part(it->'outcome'->>'pieceId', '#', 1)::uuid; exception when others then continue; end;
          insert into _inbatch values (v_uid) on conflict do nothing;
          insert into _want (uid, printed) values (v_uid, 1) on conflict (uid) do update set printed = _want.printed + 1;
        end if;
      else
        -- a stock piece: while it prints (or sits printed, awaiting finalize) it counts for the open lines that still need that item
        v_inv := lower(replace(coalesce(it->'spec'->>'inv', ''), '-', ''));
        if v_inv = '' then continue; end if;
        if v_state = 'printing' then
          insert into _stock (inv, printing) values (v_inv, 1) on conflict (inv) do update set printing = _stock.printing + 1;
        elsif v_state = 'review' and coalesce(it->>'dest', 'stock') = 'stock' then
          insert into _stock (inv, printed) values (v_inv, 1) on conflict (inv) do update set printed = _stock.printed + 1;
        end if;
      end if;
    end loop;
  end loop;

  -- stock pieces -> lines needing that item, soonest ship date first, skipping pieces the shelf already covers
  if exists (select 1 from _stock) then
    for r in
      select a.uid, a.alloc, l.qty, l.print_state, l.print_src, a.notion_id
      from hq.shelf_alloc() a join hq.order_lines l on l.uid = a.uid
      join _stock s on s.inv = a.notion_id
      where a.kind = 'print' and not l.packed and not exists (select 1 from _inbatch i where i.uid = a.uid)
        and (l.print_state in ('', 'print', 'nostock') or l.print_src = 'plan')
      order by a.seq   -- ship order: soonest first, express first on a tie, then first listed
    loop
      v_need := r.qty - r.alloc;
      for k in 1..greatest(v_need, 0) loop
        select printing, printed into v_pc, v_pd from _stock where inv = r.notion_id;
        if coalesce(v_pd, 0) > 0 then
          update _stock set printed = printed - 1 where inv = r.notion_id;
          insert into _want (uid, printed) values (r.uid, 1) on conflict (uid) do update set printed = _want.printed + 1;
        elsif coalesce(v_pc, 0) > 0 then
          update _stock set printing = printing - 1 where inv = r.notion_id;
          insert into _want (uid, printing) values (r.uid, 1) on conflict (uid) do update set printing = _want.printing + 1;
        else exit; end if;
      end loop;
    end loop;
  end if;

  -- apply: never downgrade a state a person set in Bin View; a state the plan set follows the plan; no plan -> automatic
  for r in
    select l.uid, l.qty, l.print_state, l.print_src, w.printing, w.printed
    from hq.orders o join hq.order_lines l on l.order_id = o.id left join _want w on w.uid = l.uid
    where o.status <> 'Done' and o.deleted_at is null and not l.packed
      and (w.uid is not null or (l.print_src = 'plan' and l.print_state in ('printing', 'printed')))
  loop
    v_want := case when coalesce(r.printed, 0) >= r.qty then 'printed' when coalesce(r.printed, 0) + coalesce(r.printing, 0) > 0 then 'printing' end;
    v_cur := r.print_state; v_src := r.print_src;
    if v_want is not null then
      if v_cur <> v_want and ((case v_cur when 'printing' then 1 when 'printed' then 2 else 0 end) < (case v_want when 'printing' then 1 else 2 end) or v_src = 'plan') then
        update hq.order_lines set print_state = v_want, print_src = 'plan', print_at = now(), state_by = p_by where uid = r.uid; n := n + 1;
      end if;
    elsif v_src = 'plan' and v_cur in ('printing', 'printed') then
      update hq.order_lines set print_state = '', print_src = null, print_at = now(), state_by = p_by where uid = r.uid; n := n + 1;
    end if;
  end loop;
  perform set_config('hq.applying', '0', true);
  return n;
end $function$;

create or replace function hq.plan_apply_current(p_by text default null) returns integer
 language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare v jsonb;
begin
  select value into v from hq.app_state where key = 'printplan2/main';
  if v is null then return 0; end if;
  return hq.plan_apply(v, p_by);
end $function$;
grant execute on function hq.plan_apply_current(text) to authenticated;

-- orders or lines changed (status, packed, item, done, undo, delete): re-derive from the saved plan
create or replace function hq.plan_lines_changed() returns trigger language plpgsql set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
begin
  if coalesce(current_setting('hq.applying', true), '0') = '1' then return null; end if;
  perform hq.plan_apply_current(null);
  return null;
end $function$;
drop trigger if exists plan_follow_lines on hq.order_lines;
create trigger plan_follow_lines after insert or update of print_state, print_src, packed, variant_id, qty or delete on hq.order_lines
  for each statement execute function hq.plan_lines_changed();
drop trigger if exists plan_follow_orders on hq.orders;
create trigger plan_follow_orders after update of status, deleted_at, ship_by, ship_type on hq.orders
  for each statement execute function hq.plan_lines_changed();

create or replace function hq.set_app_state(p jsonb, p_by text default null::text)
 returns jsonb language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare
  v_op  text := nullif(trim(p->>'op_id'), '');
  v_key text := nullif(trim(p->>'key'), '');
  v_old hq.app_ops; v_cur integer; v_new integer; v_res jsonb; v_given integer; n integer; v_applied integer := 0;
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
      raise exception 'stale: % changed since it was read (now version %); read it again and save again', v_key, v_cur using errcode = '40001';
    end if;
    v_new := v_cur + 1;
    update hq.app_state set value = p->'value', version = v_new, updated_at = now(), updated_by = p_by where key = v_key;
  else
    if coalesce(v_given, 0) <> 0 then
      raise exception 'stale: % no longer exists; read it again and save again', v_key using errcode = '40001';
    end if;
    v_new := 1;
    insert into hq.app_state (key, value, version, updated_by) values (v_key, p->'value', 1, p_by) on conflict (key) do nothing;
    get diagnostics n = row_count;
    if n = 0 then raise exception 'stale: % was just created by someone else; read it again and save again', v_key using errcode = '40001'; end if;
  end if;
  -- the plan decides print status, in this same transaction
  if v_key = 'printplan2/main' then v_applied := hq.plan_apply(p->'value', p_by); end if;
  v_res := jsonb_build_object('key', v_key, 'version', v_new, 'lines_updated', v_applied);
  insert into hq.app_ops (op_id, key, payload, result, by_user) values (v_op, v_key, p, v_res, p_by);
  return v_res;
end $function$;

-- Mark Done: stock comes off the shelf by the server's own allocation (the browser's list is ignored)
create or replace function hq.complete_order(p jsonb, p_moves jsonb default '[]'::jsonb, p_by text default null::text)
 returns jsonb language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare
  v_op text := nullif(trim(p->>'op_id'), ''); v_id text := lower(nullif(trim(p->>'id'), ''));
  v_status text; v_res jsonb; v_epoch integer; v_list jsonb; v_apply jsonb; v_stock jsonb := '[]'::jsonb; v_back jsonb; v_open boolean;
  v_short jsonb := '[]'::jsonb; v_want jsonb;
begin
  if v_op is null then raise exception 'complete_order: op_id is required'; end if;
  if v_id is null then raise exception 'complete_order: which order?'; end if;
  if replace(trim(coalesce(p->>'status', '')), '*', '') <> 'Done' then raise exception 'complete_order: status must be Done'; end if;
  if exists (select 1 from hq.saved_ops where op_id = v_op) then return hq.save_order(p, p_by); end if;

  select status into v_status from hq.orders where id = v_id and deleted_at is null for update;
  v_open := exists (select 1 from hq.order_stock_moves where order_id = v_id and undone_at is null);
  if v_open and v_status = 'Done' then raise exception 'already Done: this order''s stock was already taken'; end if;

  -- what this order holds on the shelf right now, by the shared allocation rule (before it leaves the open list)
  select coalesce(jsonb_agg(jsonb_build_object('notion_id', x.notion_id, 'qty', x.q)), '[]'::jsonb) into v_want
    from (select a.notion_id, sum(a.alloc)::integer q from hq.shelf_alloc() a where a.order_id = v_id and a.alloc > 0 and a.notion_id is not null group by 1) x;

  v_res := hq.save_order(p, p_by);
  if v_open then v_back := hq.return_order_stock(v_id, p_by); end if;
  v_epoch := coalesce((select max(epoch) from hq.order_stock_moves where order_id = v_id), 0) + 1;

  with want as (select m->>'notion_id' k, (m->>'qty')::integer q from jsonb_array_elements(v_want) m),
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
  return v_res || jsonb_build_object('epoch', v_epoch, 'stock', v_stock, 'short', v_short, 'taken', v_list);
end $function$;
