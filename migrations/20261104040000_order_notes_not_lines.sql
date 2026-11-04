-- Instructions are order context, not line items. Three homes, one meaning each:
--   orders.handle    who the customer is on the platform (TikTok handle · display name)
--   orders.important the one thing the packer must not miss (red banner)
--   orders.summary   order notes: context and instructions ("see Etsy notes", "enclosure is 3x3x6")
--   order_lines.note something about that one piece
-- 1. hq.is_note_line(text): a bullet that names no product and reads like an instruction.
-- 2. save_order, source notion: such bullets go to order notes instead of becoming lines (never dropped, never duplicated).
-- 3. Backfill: the open "See notes to customer in Etsy" line → order notes; TikTok handle/display name out of Important into handle.

create or replace function hq.is_note_line(t text) returns boolean language sql stable set search_path to '' as $$
  select t is not null and not hq.is_enc_line(t)
     and coalesce(hq.resolve_line(t)->>'status', '') in ('unresolved', 'untracked')
     and regexp_replace(t, '^\W+', '') ~* '^(see\M|customer\M|measurements?\M|shipping\M|tracking\M|please\M|notes?\M|requested\M|asked\M|wants?\M|address\M|giveaway\M|refund|also\M|throw in|extras?\M|ship\M|gift note|message)'
$$;

do $do$
declare src text := pg_get_functiondef('hq.save_order(jsonb,text,text)'::regprocedure); old text; new text; i int;
  reps text[][] := array[
   [$x$v_dups jsonb := '[]'::jsonb;$x$, $x$v_dups jsonb := '[]'::jsonb; v_lines jsonb; v_notes text;$x$],
   [$x$    update hq.order_lines set line_no = line_no + 1000000 where order_id = v_id;
    for l in select value from jsonb_array_elements(coalesce(p->'lines', '[]')) loop$x$,
    $x$    -- a Notion bullet that names no product and reads like an instruction is order context, not a line to pack
    v_lines := coalesce(p->'lines', '[]'::jsonb);
    if p_source = 'notion' then
      select coalesce(jsonb_agg(x.value order by x.ord) filter (where not x.note), '[]'::jsonb),
             string_agg(trim(x.value->>'text'), E'\n' order by x.ord) filter (where x.note)
        into v_lines, v_notes
        from (select e.value, e.ord, hq.is_note_line(e.value->>'text') as note
                from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality e(value, ord)) x;
    end if;
    update hq.order_lines set line_no = line_no + 1000000 where order_id = v_id;
    for l in select value from jsonb_array_elements(v_lines) loop$x$],
   [$x$    n := 0;
    for l in select value from jsonb_array_elements(coalesce(p->'lines', '[]')) loop$x$,
    $x$    n := 0;
    for l in select value from jsonb_array_elements(v_lines) loop$x$],
   [$x$    delete from hq.order_lines where order_id = v_id and line_no >= 1000000;$x$,
    $x$    delete from hq.order_lines where order_id = v_id and line_no >= 1000000;
    if v_notes is not null then
      update hq.orders set summary = concat_ws(E'\n', nullif(summary, ''), v_notes)
       where id = v_id and (summary is null or position(v_notes in summary) = 0);
    end if;$x$]];
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

-- backfill 1: open orders' instruction lines → order notes (line text + its note), with history
do $do$
declare r record; v_txt text; v_before jsonb;
begin
  for r in select ol.uid, ol.order_id, ol.text, ol.note from hq.order_lines ol join hq.orders o on o.id = ol.order_id
            where o.deleted_at is null and o.status <> 'Done' and ol.variant_id is null and hq.is_note_line(ol.text) loop
    v_before := hq.order_json(r.order_id);
    v_txt := concat_ws(' — ', trim(r.text), nullif(trim(r.note), ''));
    delete from hq.order_lines where uid = r.uid;
    update hq.orders set summary = concat_ws(E'\n', nullif(summary, ''), v_txt), version = version + 1 where id = r.order_id;
    insert into hq.order_history (order_id, op_id, source, before, after, by_user)
    values (r.order_id, 'fix-' || replace(gen_random_uuid()::text, '-', ''), 'hq', v_before, hq.order_json(r.order_id), 'frankie');
  end loop;
end $do$;
delete from hq.line_aliases where alias_key = hq.name_key('See notes to customer in Etsy');

-- backfill 2: TikTok orders — first line of Important is the handle (one token), an optional short second line the
-- display name; both move to handle. Whatever else was in Important stays there.
do $do$
declare r record; ls text[]; h text; rest text[];
begin
  for r in select id, important from hq.orders where deleted_at is null and handle is null and important is not null
            and ('TikTok' = any(platform) or 'TikTok - LIVE' = any(platform)) loop
    ls := array(select x from unnest(regexp_split_to_array(r.important, E'\r?\n')) x where trim(x) <> '');
    continue when ls[1] !~ '^[A-Za-z0-9._]+$';
    h := ls[1]; rest := ls[2:];
    if rest[1] ~ '^[A-Za-z0-9._ ]{1,30}$' and rest[1] !~* '(winner|ship|order|enclosure|set\M|spends|tiktok)' then
      h := h || ' · ' || rest[1]; rest := rest[2:];
    end if;
    update hq.orders set handle = h, important = nullif(array_to_string(rest, E'\n'), '') where id = r.id;
  end loop;
end $do$;
