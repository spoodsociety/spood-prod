-- Nov 5, 2026 — save_order keeps the order's words on a line and checks the pick against them (see 20261105000000_line_check.sql).
--
-- 1. A kept line keeps its words when the browser sends the item's catalog name in their place (old clients, item swaps).
--    A line that never had words gets the catalog name, as before.
-- 2. Alias learning uses the words, and never learns words that disagree with the pick.
-- 3. After every save, order_lines.conflict = hq.line_check(text, variant_id) for each line; a new conflict is logged
--    (app_log kind pick_conflict). Nothing blocks.
-- 4. order_json (so read_orders, Bin View, Print Plan, the Order Desk) carries conflict.
-- 5. Backfill: lines whose words were overwritten by a catalog name get their first words back from order_history
--    (the Bin View shows the catalog name for a matched line either way); every line's conflict is computed.

do $do$
declare src text := pg_get_functiondef('hq.save_order(jsonb,text,text)'::regprocedure); old text; new text; i int;
  reps text[][] := array[
   [$x$v_lines jsonb; v_notes text;$x$, $x$v_lines jsonb; v_notes text; v_text text; v_said text; v_chk text; r record;$x$],
   [$x$      if v_var is null and v_match = 'unmatched' then
        select lv.variant_id, lv.match into v_var, v_match from hq.line_variant(trim(l->>'text'), p_by) lv;
      elsif p_source = 'hq' and hq.name_key(regexp_replace(hq.line_clean(l->>'text'), '\(matte\)', ' Matte', 'gi')) is not null
            and not hq.is_enc_line(trim(l->>'text'))
            and (v_uid is null or exists (select 1 from hq.order_lines x where x.order_id = v_id and x.uid = v_uid and x.line_no >= 1000000
                                           and (x.variant_id is distinct from v_var or x.text <> trim(l->>'text')))) then
        -- a person picked this item (or marked it not tracked) on a new or changed line: remember the text for next time
        insert into hq.line_aliases (alias_key, variant_id, untracked, sample_text, decided_by)
        values (hq.name_key(regexp_replace(hq.line_clean(l->>'text'), '\(matte\)', ' Matte', 'gi')), v_var, v_var is null, trim(l->>'text'), p_by)$x$,
    $x$      -- the order's words stay on a kept line when the browser sends the item's catalog name in their place
      v_text := trim(l->>'text');
      if v_uid is not null and v_var is not null then
        select x.text into v_said from hq.order_lines x where x.order_id = v_id and x.uid = v_uid and x.line_no >= 1000000;
        if v_said is distinct from v_text
           and exists (select 1 from hq.variants v where hq.name_key(v.inventory_name) = hq.name_key(v_text) or v.sku = hq.name_key(v_text))
           and not exists (select 1 from hq.variants v where hq.name_key(v.inventory_name) = hq.name_key(v_said) or v.sku = hq.name_key(v_said)) then
          v_text := v_said;
        end if;
      end if;
      if v_var is null and v_match = 'unmatched' then
        select lv.variant_id, lv.match into v_var, v_match from hq.line_variant(v_text, p_by) lv;
      elsif p_source = 'hq' and hq.name_key(regexp_replace(hq.line_clean(v_text), '\(matte\)', ' Matte', 'gi')) is not null
            and not hq.is_enc_line(v_text)
            and hq.line_check(v_text, v_var) is null
            and (v_uid is null or exists (select 1 from hq.order_lines x where x.order_id = v_id and x.uid = v_uid and x.line_no >= 1000000
                                           and (x.variant_id is distinct from v_var or x.text <> v_text))) then
        -- a person picked this item (or marked it not tracked) on a new or changed line: remember the words for next time
        -- (never words that disagree with the pick)
        insert into hq.line_aliases (alias_key, variant_id, untracked, sample_text, decided_by)
        values (hq.name_key(regexp_replace(hq.line_clean(v_text), '\(matte\)', ' Matte', 'gi')), v_var, v_var is null, v_text, p_by)$x$],
   [$x$update hq.order_lines set line_no = n, text = trim(l->>'text'), qty =$x$, $x$update hq.order_lines set line_no = n, text = v_text, qty =$x$],
   [$x$values (v_id, n, trim(l->>'text'), coalesce(nullif(l->>'qty', '')::integer, 1), v_var, v_match,$x$,
    $x$values (v_id, n, v_text, coalesce(nullif(l->>'qty', '')::integer, 1), v_var, v_match,$x$],
   [$x$    delete from hq.order_lines where order_id = v_id and line_no >= 1000000;$x$,
    $x$    delete from hq.order_lines where order_id = v_id and line_no >= 1000000;
    -- the pick against the order's words: a disagreement is shown and logged, never blocking
    for r in select x.uid, x.text, x.variant_id, x.conflict from hq.order_lines x where x.order_id = v_id loop
      v_chk := hq.line_check(r.text, r.variant_id);
      if v_chk is distinct from r.conflict then
        update hq.order_lines set conflict = v_chk where uid = r.uid;
        if v_chk is not null then
          insert into hq.app_log (op_id, kind, data, by_user)
          values ('conflict-' || replace(gen_random_uuid()::text, '-', ''), 'pick_conflict',
                  jsonb_build_object('order_id', v_id, 'uid', r.uid, 'text', r.text, 'variant_id', r.variant_id, 'conflict', v_chk), p_by);
        end if;
      end if;
    end loop;$x$]];
begin
  for i in 1..array_length(reps, 1) loop
    old := reps[i][1]; new := reps[i][2];
    if (length(src) - length(replace(src, old, ''))) / length(old) <> 1 then
      raise exception 'save_order patch: replacement % matched % times', i, (length(src) - length(replace(src, old, ''))) / length(old);
    end if;
    src := replace(src, old, new);
  end loop;
  execute src;
end $do$;

create or replace function hq.order_json(p_id text, p_alloc jsonb default null)
returns jsonb language sql stable set search_path to '' as $$
  select to_jsonb(o) || jsonb_build_object('lines', coalesce((
           select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'text', l.text, 'note', l.note, 'qty', l.qty, 'match', l.match, 'tag', l.tag, 'size_1', l.size_1, 'size_2', l.size_2, 'size_3', l.size_3, 'size_unit', l.size_unit, 'size_basis', l.size_basis,
                    'conflict', l.conflict,
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
$$;

-- backfill: the order's first words back onto lines whose text became a catalog name
with hist as (
  select h.order_id, l->>'uid' as uid, l->>'text' as text, h.at
  from hq.order_history h
  cross join lateral (select jsonb_array_elements(coalesce(h.before->'lines','[]'::jsonb)) union all select jsonb_array_elements(coalesce(h.after->'lines','[]'::jsonb))) x(l)
  where l->>'uid' is not null and l->>'text' is not null
), first_text as (
  select distinct on (order_id, uid) order_id, uid::uuid as uid, text from hist order by order_id, uid, at
)
update hq.order_lines ol set text = f.text
  from first_text f
 where f.uid = ol.uid and f.order_id = ol.order_id and ol.variant_id is not null and f.text <> ol.text
   and exists (select 1 from hq.variants v where hq.name_key(v.inventory_name) = hq.name_key(ol.text) or v.sku = hq.name_key(ol.text))
   and not exists (select 1 from hq.variants v where hq.name_key(v.inventory_name) = hq.name_key(f.text) or v.sku = hq.name_key(f.text));

update hq.order_lines set conflict = hq.line_check(text, variant_id);
