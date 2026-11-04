-- resolve_line learns two things owners already told the catalog:
-- 1. A collection named on a line ("Neon Halloween", "neon halloween colors") means that collection's colorway of the
--    design, from hq.collection_pieces (Neon Halloween + Checkered Wavy Floor = Lavender + GITD Green). Explicit colors
--    on the line still win. The collection word is no longer mistaken for an unknown color.
-- 2. "Head - part" lines try the head with every option part as a product name/alias, not only the first
--    ("Floor Insert - Small, Trippy, Neon Halloween" -> alias "Floor Insert - Trippy").
-- Checked against every line text ever saved (839): only the three Neon Halloween trippy-floor lines change, all to the
-- right item. Applied as replacements on the current definition so the rest of the resolver is untouched.

do $do$
declare src text := pg_get_functiondef('hq.resolve_line(text)'::regprocedure); old text; new text; i int;
  reps text[][] := array[
   ['v_matchkey text;', 'v_matchkey text; v_cscheme text;'],
   [$x$  if v_parts[1] is not null then v_keys := v_keys || hq.name_key(v_head || ' ' || v_parts[1]); end if;$x$,
    $x$  foreach part in array v_parts loop if coalesce(part, '') <> '' then v_keys := v_keys || hq.name_key(v_head || ' ' || part); end if; end loop;$x$],
   [$x$  if v_parts[1] is not null and v_matchkey = hq.name_key(v_head || ' ' || v_parts[1]) then
    v_badc := array_remove(v_badc, hq.name_key(v_parts[1]));
  end if;$x$,
    $x$  foreach part in array v_parts loop
    if coalesce(part, '') <> '' and v_matchkey = hq.name_key(v_head || ' ' || part) then v_badc := array_remove(v_badc, hq.name_key(part)); end if;
  end loop;$x$],
   [$x$  select p.category, p.customer_picks_color, p.default_color_scheme_id into v_cat, v_pick, v_def from hq.products p where p.id = v_prod;
$x$,
    $x$  select p.category, p.customer_picks_color, p.default_color_scheme_id into v_cat, v_pick, v_def from hq.products p where p.id = v_prod;
  -- a collection named on the line ("Neon Halloween", "neon halloween colors") means that collection's colorway of this design
  foreach part in array v_parts loop
    continue when part is null or part = '';
    k := hq.name_key(regexp_replace(part, '\y(colou?rs?|colou?rway|version|edition|theme)\y', '', 'gi'));
    continue when k is null;
    v_cid := null;
    select c.id into v_cid from hq.collections c where not c.archived and hq.name_key(c.name) = k;
    if v_cid is not null then
      v_badc := array_remove(array_remove(v_badc, k), hq.name_key(part));
      if v_coll is null then v_coll := v_cid; end if;
    end if;
  end loop;
  if v_coll is not null then
    select cp.color_scheme_id into v_cscheme from hq.collection_pieces cp
     where cp.collection_id = v_coll and cp.product_id = v_prod and cp.color_scheme_id is not null limit 1;
  end if;
$x$],
   [$x$    v_scheme := v_def;
$x$, $x$    v_scheme := coalesce(v_cscheme, v_def);
$x$]];
begin
  for i in 1..array_length(reps, 1) loop
    old := reps[i][1]; new := reps[i][2];
    if (length(src) - length(replace(src, old, ''))) / length(old) <> 1 then
      raise exception 'resolve_line patch: replacement % matched % times', i, (length(src) - length(replace(src, old, ''))) / length(old);
    end if;
    src := replace(src, old, new);
  end loop;
  execute src;
end $do$;

-- the design's own name as the shop writes it (confirmed by Frankie, Nov 3 2026)
update hq.products set aliases = array_append(aliases, 'Trippy Floor Insert')
 where id = 'floor-insert-wavy-checkered' and not ('Trippy Floor Insert' = any(aliases));

-- unmatched lines on open orders that the resolver can now place
update hq.order_lines ol set variant_id = x.variant_id, match = x.match
  from (select l.uid, lv.variant_id, lv.match
          from hq.order_lines l join hq.orders o on o.id = l.order_id, lateral hq.line_variant(l.text, 'catalog') lv
         where o.deleted_at is null and o.status <> 'Done' and l.match = 'unmatched' and lv.match = 'item') x
 where x.uid = ol.uid;
