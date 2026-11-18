-- Reset to Needs printing also has to win over a FINALIZED batch.
--
-- What broke (Nov 17, 2026): Zitlaly A's Christmas - Tree Climb (Small) was finalized to her order in Batch 96.
-- Setting the line back to Needs printing saved, then hq.plan_apply read the finalized batch (outcome to: piece)
-- and put the line straight back to Printed, with no message. hq.plan_drop_pieces only looked at printing and
-- in-review batches (migration reset_takes_piece_off_live_batch), so off_plan came back 0 seven times in a row.
--
-- Now: the same save also releases the piece from any finalized batch. The batch stays in history; the piece's
-- outcome there becomes {to: "fail", reset: true}, the value the Print Plan already understands: it no longer
-- counts as printed for that order, the piece shows as needing a print again, and the finalized batch offers
-- "Reprint on…". Logged in app_log as plan_piece_removed (state "done").
create or replace function hq.plan_drop_pieces(p_uids uuid[], p_op text, p_by text default null::text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
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
        -- live batch: the piece comes off it
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
      elsif b->>'state' = 'done' and jsonb_typeof(b->'items') = 'array' then
        -- finalized batch: history stays, the piece no longer counts as printed for that order
        select coalesce(jsonb_agg(case when m.hit then jsonb_set(i.value, '{outcome}', '{"to":"fail","reset":true}'::jsonb) else i.value end order by i.ord), '[]'::jsonb),
               coalesce(jsonb_agg(jsonb_build_object('batch', b->>'name', 'printer', lane.key, 'state', 'done', 'pieceId', i.value->'outcome'->>'pieceId', 'name', i.value->'spec'->>'name') order by i.ord) filter (where m.hit), '[]'::jsonb)
          into v_keep, v_gone
        from jsonb_array_elements(b->'items') with ordinality i(value, ord)
        cross join lateral (select coalesce(i.value->'outcome'->>'to' = 'piece'
                              and split_part(coalesce(i.value->'outcome'->>'pieceId', ''), '#', 1) = any (select u::text from unnest(p_uids) u), false) as hit) m;
        if jsonb_array_length(v_gone) > 0 then
          v_removed := v_removed || v_gone;
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
