-- A custom size is a fact about the order line, not a catalog variant. Each product keeps one "Custom" size; the line
-- carries the measurements as entered: size_1 × size_2 (× size_3) in inches or cm, and whether that is the piece itself
-- or the enclosure it has to fit. Nothing is re-mapped to a standard size: entered as custom, shown as custom.
--
-- - hq.parse_dims(text): measurements out of free text ("5.9” W x 9.84” H", "Fits 4.7 x 4.7", "3 3/4”", "10.25 cm x 10.25 cm",
--   "6x6x9 enclosure", "3-1/4” x 3-1/2”"). Fractions and commas handled; mm stored as cm.
-- - save_order: takes size_1..3 / size_unit / size_basis per line (a key that is absent leaves the saved value alone);
--   a custom-size line saved without measurements gets them parsed from its note, then its text. Still none → stays
--   empty and Bin View flags it.
-- - order_json / read_orders: the fields on every line.
-- - Backfill: every existing custom-size line, from note then text.

alter table hq.order_lines
  add column if not exists size_1 numeric(7,2),
  add column if not exists size_2 numeric(7,2),
  add column if not exists size_3 numeric(7,2),
  add column if not exists size_unit text not null default 'in' check (size_unit in ('in', 'cm')),
  add column if not exists size_basis text not null default 'piece' check (size_basis in ('piece', 'enclosure'));

create or replace function hq.parse_dims(p_text text) returns jsonb language plpgsql immutable set search_path to '' as $$
declare
  num constant text := '\d+(?:[.,]\d+)?(?:[\s-]+\d+/\d+)?(?:\s*(?:[”"″'']|cm|mm|in(?:ch(?:es)?)?\M))?(?:\s*[WHLD]\M)?';
  pat text; m text; nums text[]; vals numeric[] := '{}'; x text; v numeric; unit text; basis text;
begin
  if p_text is null then return null; end if;
  pat := '(?:(?:fits|measurements?|enclosure size|size)\s*:?\s*)?(?:' || num || '\s*[x×X]\s*' || num || '(?:\s*[x×X]\s*' || num || ')?|\d+(?:[.,]\d+)?(?:[\s-]+\d+/\d+)?\s*(?:[”"″]|cm|mm|in(?:ch(?:es)?)?\M))(?:\s*(?:enclosure(?:\s*size)?|\(enclosure\)))?';
  m := substring(p_text from '(?i)' || pat);
  if m is null then return null; end if;
  nums := array(select r[1] from regexp_matches(m, '(\d+(?:[.,]\d+)?(?:[\s-]+\d+/\d+)?)', 'g') r);
  foreach x in array nums loop
    if x ~ '/' then
      v := replace(regexp_replace(x, '[\s-]+\d+/\d+$', ''), ',', '.')::numeric
         + (split_part(substring(x from '\d+/\d+$'), '/', 1)::numeric / split_part(substring(x from '\d+/\d+$'), '/', 2)::numeric);
    else v := replace(x, ',', '.')::numeric; end if;
    vals := vals || round(v, 2);
  end loop;
  unit := case when m ~* '\mmm\M' then 'mm' when m ~* '\mcm\M' then 'cm' else 'in' end;
  if unit = 'mm' then vals := array(select round(u / 10, 2) from unnest(vals) u); unit := 'cm'; end if;
  basis := case when m ~* '(fits|enclosure)' then 'enclosure' else 'piece' end;
  return jsonb_build_object('size_1', vals[1], 'size_2', vals[2], 'size_3', vals[3], 'size_unit', unit, 'size_basis', basis);
end $$;
drop function if exists hq.parse_dims_try(text);

-- save_order: size fields in, and parsed from the text when a custom-size line arrives without them
do $do$
declare src text := pg_get_functiondef('hq.save_order(jsonb,text,text)'::regprocedure); old text; new text; i int;
  reps text[][] := array[
   [$x$          note = nullif(trim(l->>'note'), ''), tag = case when l->>'tag' in ('gift', 'addon') then l->>'tag' else '' end
        where order_id = v_id and uid = v_uid;$x$,
    $x$          note = nullif(trim(l->>'note'), ''), tag = case when l->>'tag' in ('gift', 'addon') then l->>'tag' else '' end,
          size_1 = case when l ? 'size_1' then nullif(l->>'size_1', '')::numeric else size_1 end,
          size_2 = case when l ? 'size_2' then nullif(l->>'size_2', '')::numeric else size_2 end,
          size_3 = case when l ? 'size_3' then nullif(l->>'size_3', '')::numeric else size_3 end,
          size_unit = case when l ? 'size_unit' then coalesce(nullif(l->>'size_unit', ''), 'in') else size_unit end,
          size_basis = case when l ? 'size_basis' then coalesce(nullif(l->>'size_basis', ''), 'piece') else size_basis end
        where order_id = v_id and uid = v_uid;$x$],
   [$x$        insert into hq.order_lines (order_id, line_no, text, qty, variant_id, match, note, tag)
        values (v_id, n, trim(l->>'text'), coalesce(nullif(l->>'qty', '')::integer, 1), v_var, v_match, nullif(trim(l->>'note'), ''), case when l->>'tag' in ('gift', 'addon') then l->>'tag' else '' end)$x$,
    $x$        insert into hq.order_lines (order_id, line_no, text, qty, variant_id, match, note, tag, size_1, size_2, size_3, size_unit, size_basis)
        values (v_id, n, trim(l->>'text'), coalesce(nullif(l->>'qty', '')::integer, 1), v_var, v_match, nullif(trim(l->>'note'), ''), case when l->>'tag' in ('gift', 'addon') then l->>'tag' else '' end,
                nullif(l->>'size_1', '')::numeric, nullif(l->>'size_2', '')::numeric, nullif(l->>'size_3', '')::numeric,
                coalesce(nullif(l->>'size_unit', ''), 'in'), coalesce(nullif(l->>'size_basis', ''), 'piece'))$x$],
   [$x$    delete from hq.order_lines where order_id = v_id and line_no >= 1000000;$x$,
    $x$    -- a custom-size line with no measurements entered: read them from its note, then its text
    update hq.order_lines ol set size_1 = d.s1, size_2 = d.s2, size_3 = d.s3, size_unit = d.su, size_basis = d.sb
      from (select x.uid, (j->>'size_1')::numeric s1, (j->>'size_2')::numeric s2, (j->>'size_3')::numeric s3, j->>'size_unit' su, j->>'size_basis' sb
              from hq.order_lines x join hq.variants v on v.id = x.variant_id
              cross join lateral (select coalesce(hq.parse_dims(x.note), hq.parse_dims(x.text)) j) p
             where x.order_id = v_id and x.line_no < 1000000 and v.size_code = 'custom' and x.size_1 is null and j is not null) d
     where ol.uid = d.uid;
    delete from hq.order_lines where order_id = v_id and line_no >= 1000000;$x$]];
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

-- order_json: the size fields on every line
do $do$
declare src text := pg_get_functiondef('hq.order_json(text,jsonb)'::regprocedure);
  old text := $x$'match', l.match, 'tag', l.tag,$x$;
  new text := $x$'match', l.match, 'tag', l.tag, 'size_1', l.size_1, 'size_2', l.size_2, 'size_3', l.size_3, 'size_unit', l.size_unit, 'size_basis', l.size_basis,$x$;
begin
  if (length(src) - length(replace(src, old, ''))) / length(old) <> 1 then raise exception 'order_json patch: anchor not found once'; end if;
  execute replace(src, old, new);
end $do$;

-- backfill every custom-size line that has no measurements yet
update hq.order_lines ol set size_1 = d.s1, size_2 = d.s2, size_3 = d.s3, size_unit = d.su, size_basis = d.sb
  from (select x.uid, (j->>'size_1')::numeric s1, (j->>'size_2')::numeric s2, (j->>'size_3')::numeric s3, j->>'size_unit' su, j->>'size_basis' sb
          from hq.order_lines x join hq.variants v on v.id = x.variant_id
          cross join lateral (select coalesce(hq.parse_dims(x.note), hq.parse_dims(x.text)) j) p
         where v.size_code = 'custom' and x.size_1 is null and j is not null) d
 where ol.uid = d.uid;
