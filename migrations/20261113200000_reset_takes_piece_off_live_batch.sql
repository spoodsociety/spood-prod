-- A person setting a line back to Needs printing (or Reset / Change to print) did not stick while its piece sat on a
-- printing or in-review batch: the save went through, then the plan_follow_lines trigger re-applied the plan and put
-- the line straight back to Printing, with no message (Alisha Richard's Yeti Hide, Batch 100, Nov 13, 2026).
-- A person's word in Bin View wins over the plan, so the piece now leaves the live batch in the same save
-- (same rule the plan's binCleanup already applies to pieces marked Done or packed). Queued batches don't drive
-- status and are left alone; finalized batches are history. A batch left with nothing disappears.

create or replace function hq.plan_drop_pieces(p_uids uuid[], p_op text, p_by text default null) returns integer
language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
declare v jsonb; v_lanes jsonb := '{}'::jsonb; lane record; b jsonb; v_out jsonb; v_keep jsonb; v_gone jsonb; v_removed jsonb := '[]'::jsonb;
begin
  if p_uids is null or cardinality(p_uids) = 0 then return 0; end if;
  select value into v from hq.app_state where key = 'printplan2/main' for update;
  if not found or jsonb_typeof(v->'lanes') is distinct from 'object' then return 0; end if;

  for lane in select key, value from jsonb_each(v->'lanes') loop
    if jsonb_typeof(lane.value) <> 'array' then v_lanes := v_lanes || jsonb_build_object(lane.key, lane.value); continue; end if;
    v_out := '[]'::jsonb;
    for b in select e.value from jsonb_array_elements(lane.value) with ordinality e(value, ord) order by e.ord loop
      if b->>'state' in ('printing', 'review') and jsonb_typeof(b->'items') = 'array' then
        select coalesce(jsonb_agg(i.value order by i.ord) filter (where not m.hit), '[]'::jsonb),
               coalesce(jsonb_agg(jsonb_build_object('batch', b->>'name', 'printer', lane.key, 'state', b->>'state', 'pieceId', i.value->>'pieceId', 'name', i.value->'spec'->>'name') order by i.ord) filter (where m.hit), '[]'::jsonb)
          into v_keep, v_gone
        from jsonb_array_elements(b->'items') with ordinality i(value, ord)
        cross join lateral (select split_part(coalesce(i.value->>'pieceId', ''), '#', 1) = any (select u::text from unnest(p_uids) u) as hit) m;
        if jsonb_array_length(v_gone) > 0 then
          v_removed := v_removed || v_gone;
          if jsonb_array_length(v_keep) = 0 then continue; end if;
          b := jsonb_set(b, '{items}', v_keep);
        end if;
      end if;
      v_out := v_out || jsonb_build_array(b);
    end loop;
    v_lanes := v_lanes || jsonb_build_object(lane.key, v_out);
  end loop;

  if jsonb_array_length(v_removed) = 0 then return 0; end if;
  update hq.app_state set value = jsonb_set(v, '{lanes}', v_lanes), version = version + 1, updated_at = now(), updated_by = p_by where key = 'printplan2/main';
  insert into hq.app_log (op_id, kind, data, by_user) values (p_op || ':plan', 'plan_piece_removed', jsonb_build_object('why', 'set back to needs printing in Bin View', 'removed', v_removed), p_by);
  return jsonb_array_length(v_removed);
end $function$;
revoke all on function hq.plan_drop_pieces(uuid[], text, text) from public, anon, authenticated;

create or replace function hq.set_line_state(p jsonb, p_by text default null) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
declare
  v_op text := nullif(trim(p->>'op_id'), ''); v_old hq.saved_ops; v_list jsonb; l jsonb; v_row hq.order_lines;
  v_first text; n integer := 0; v_ps text; v_pk boolean; v_res jsonb; v_back uuid[]; v_off integer := 0;
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
      v_pk := (l->>'packed')::boolean;
      update hq.order_lines set packed = v_pk, packed_at = now(), packed_from = case when v_pk then nullif(l->>'packed_from', '') else null end, state_by = p_by
      where uid = v_row.uid;
    end if;
  end loop;

  v_res := jsonb_build_object('updated', n, 'off_plan', v_off);
  insert into hq.saved_ops (op_id, order_id, payload, result, by_user) values (v_op, v_first, p, v_res, p_by);
  return v_res;
end $function$;
