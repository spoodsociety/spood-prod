-- packed_takes_shelf_piece (Nov 23, 2026)
-- A line ticked packed takes its shelf pieces off the count right then (before: only when the order was marked Done).
-- Unticking puts them back. Mark Done takes only what unpacked lines still hold, so nothing is taken twice.

alter table hq.order_lines add column if not exists shelf_taken integer not null default 0 check (shelf_taken >= 0);
comment on column hq.order_lines.shelf_taken is 'Pieces this line took off the shelf when it was ticked packed. The trigger line_shelf_follow keeps inventory_movements in step with it.';

-- One place writes the movement: whenever a line's shelf_taken changes, the line stops being packed, changes item, or is removed.
create or replace function hq.line_shelf_follow() returns trigger language plpgsql set search_path to '' as $f$
declare v_back integer := 0; v_var bigint; v_cust text; v_status text; v_swap boolean := false;
begin
  if tg_op = 'DELETE' then
    v_back := old.shelf_taken; v_var := old.variant_id; v_swap := true;
  else
    v_swap := new.variant_id is distinct from old.variant_id;
    if not new.packed or v_swap then new.shelf_taken := 0; end if;
    v_back := old.shelf_taken - new.shelf_taken;                      -- above zero: back to the shelf; below: off the shelf
    v_var := case when v_back > 0 then old.variant_id else new.variant_id end;
  end if;
  if v_back <> 0 and v_var is not null then
    select o.status, o.customer into v_status, v_cust from hq.orders o where o.id = old.order_id;
    -- a shipped order being corrected afterwards: the piece left with it, the shelf is not touched
    if not (v_swap and v_status = 'Done') then
      insert into hq.inventory_movements (op_id, variant_id, kind, qty_change, ref, reason, by_user, source)
      values ('pack:' || old.uid || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS') || ':' || substr(md5(random()::text), 1, 4), v_var,
              case when v_back > 0 then 'return' else 'sale' end, v_back, old.order_id,
              case when v_back > 0 then 'Unpacked: ' else 'Packed: ' end || coalesce(v_cust, ''),
              case when tg_op = 'DELETE' then old.state_by else new.state_by end, 'hq');
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $f$;

drop trigger if exists line_shelf_follow on hq.order_lines;
create trigger line_shelf_follow before update or delete on hq.order_lines for each row execute function hq.line_shelf_follow();

-- An open order that is deleted gives its packed shelf pieces back.
create or replace function hq.order_deleted_returns_shelf() returns trigger language plpgsql set search_path to '' as $f$
begin
  if new.deleted_at is not null and old.deleted_at is null and old.status <> 'Done' then
    update hq.order_lines set shelf_taken = 0 where order_id = new.id and shelf_taken > 0;
  end if;
  return null;
end $f$;

drop trigger if exists shelf_back_on_delete on hq.orders;
create trigger shelf_back_on_delete after update of deleted_at on hq.orders for each row execute function hq.order_deleted_returns_shelf();

-- A packed line holds its pieces in the box, not on the shelf: it no longer asks the shelf for anything.
CREATE OR REPLACE FUNCTION hq.shelf_alloc()
 RETURNS TABLE(seq integer, uid uuid, order_id text, line_no integer, kind text, alloc integer, needs integer, variant_id bigint, notion_id text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'hq', 'pg_temp'
AS $function$
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
    if r.tracked and not r.packed and not (r.kind = 'print' and (r.print_state <> '' or hq.is_custom(r.text))) then
      needs := r.qty; v_key := r.variant_id::text;
      v_left := coalesce((v_shelf->>v_key)::integer, 0);
      v_take := least(v_left, r.qty);
      if v_take > 0 then alloc := v_take; v_shelf := jsonb_set(v_shelf, array[v_key], to_jsonb(v_left - v_take)); end if;
    end if;
    return next;
  end loop;
end $function$;

-- Ticking packed takes what the line holds on the shelf; unticking gives it back (through the trigger).
CREATE OR REPLACE FUNCTION hq.set_line_state(p jsonb, p_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hq', 'pg_temp'
AS $function$
declare
  v_op text := nullif(trim(p->>'op_id'), ''); v_old hq.saved_ops; v_list jsonb; l jsonb; v_row hq.order_lines;
  v_first text; n integer := 0; v_ps text; v_pk boolean; v_res jsonb; v_back uuid[]; v_off integer := 0; v_a integer; v_taken integer := 0;
begin
  if v_op is null then raise exception 'set_line_state: op_id is required'; end if;
  select * into v_old from hq.saved_ops where op_id = v_op;
  if found then
    if v_old.payload = p then return v_old.result || '{"duplicate":true}'; end if;
    raise exception 'op_id % was already used for a different save', v_op;
  end if;

  v_list := case when p ? 'lines' then p->'lines' else jsonb_build_array(p - 'op_id') end;
  if jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) = 0 then raise exception 'set_line_state: lines must be a list with at least one line'; end if;

  -- lines a person is setting back to not-printed leave any printing / in-review batch first (plan row locked before
  -- the lines, the same order set_app_state takes them), so the plan can't put them back to Printing
  select array_agg((e.value->>'uid')::uuid) into v_back from jsonb_array_elements(v_list) e
  where e.value ? 'print_state' and coalesce(e.value->>'print_state', '') in ('', 'print', 'nostock')
    and coalesce(e.value->>'uid', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_off := hq.plan_drop_pieces(v_back, v_op, p_by);

  for l in select value from jsonb_array_elements(v_list) loop
    n := n + 1;
    if coalesce(l->>'uid', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'set_line_state: line % has no valid uid', n; end if;
    select * into v_row from hq.order_lines where uid = (l->>'uid')::uuid for update;
    if not found then raise exception 'set_line_state: unknown line %', l->>'uid'; end if;
    if not (l ? 'print_state' or l ? 'packed') then raise exception 'set_line_state: line % has nothing to set', l->>'uid'; end if;
    v_first := coalesce(v_first, v_row.order_id);
    if l ? 'print_state' then
      v_ps := coalesce(l->>'print_state', '');
      if v_ps not in ('', 'print', 'printing', 'printed', 'nostock') then raise exception 'set_line_state: print_state % is not allowed', v_ps; end if;
      update hq.order_lines set print_state = v_ps, print_at = now(), print_src = case when v_ps = '' then null else nullif(l->>'print_src', '') end, state_by = p_by
      where uid = v_row.uid;
    end if;
    if l ? 'packed' then
      if jsonb_typeof(l->'packed') <> 'boolean' then raise exception 'set_line_state: packed must be true or false'; end if;
      v_pk := (l->>'packed')::boolean; v_a := 0;
      if v_pk and not v_row.packed then
        -- the shelf pieces this line holds (by the shared allocation rule) come off the count now
        select a.alloc into v_a from hq.shelf_alloc() a where a.uid = v_row.uid;
        v_a := coalesce(v_a, 0);
      end if;
      update hq.order_lines set packed = v_pk, packed_at = now(),
        packed_from = case when not v_pk then null when v_a > 0 or shelf_taken > 0 then 'shelf' else nullif(l->>'packed_from', '') end,
        shelf_taken = case when not v_pk then 0 when not v_row.packed then v_a else shelf_taken end,
        state_by = p_by
      where uid = v_row.uid;
      v_taken := v_taken + v_a;
    end if;
  end loop;

  v_res := jsonb_build_object('updated', n, 'off_plan', v_off, 'taken', v_taken);
  insert into hq.saved_ops (op_id, order_id, payload, result, by_user) values (v_op, v_first, p, v_res, p_by);
  return v_res;
end $function$;

-- undo_done_keeps_packed_pieces_off_shelf (same day): undoing Done puts the order back on the board; pieces still packed stay off the shelf.
-- For an order marked Done the old way, each packed line takes its own piece back so the shelf ends where it was and unticking is what returns it.
-- The function body is in the live database (hq.undo_order_done) and in supabase_migrations.schema_migrations under that name.
