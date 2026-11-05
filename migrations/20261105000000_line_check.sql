-- Nov 5, 2026 — an order line keeps the customer's words; the pick is checked against them.
--
-- Why: April Hulsey's floor insert came in as "…Cream Background, Large". A person converted the text line to a
-- catalog pick, the pick defaulted to Small, and save_order overwrote the line text with the Small variant's name.
-- "Large" then existed nowhere in Supabase, so nothing could notice. A Small was printed and shipped.
--
-- Rules:
--   1. order_lines.text is what the order said. A pick never replaces it. (save_order keeps a kept line's words when
--      the browser sends the variant's catalog name instead; a line that never had words gets the catalog name.)
--   2. hq.line_check(text, variant_id) compares the size word and the color names in the text with the picked
--      variant. A disagreement is stored on the line (order_lines.conflict, e.g. "Text says Large") and logged.
--      It flags; it never blocks a save. Bin View, Print Plan and the Order Desk show it as the orange pill.

alter table hq.order_lines add column if not exists conflict text;

-- colors named in a line's text (ids), longest name first so "hot pink" is not also "pink"
create or replace function hq.text_colors(p_text text)
returns text[] language plpgsql stable set search_path to '' as $$
declare k text := '-' || coalesce(hq.name_key(regexp_replace(coalesce(p_text, ''), '\(matte\)', ' Matte', 'gi')), '') || '-';
        r record; out text[] := '{}';
begin
  for r in
    select q.id, q.k from (
      select c.id, hq.name_key(c.name) as k from hq.colors c where not c.archived
      union all select c.id, hq.name_key(x) from hq.colors c, unnest(c.aliases) x where not c.archived) q
    where q.k is not null order by length(q.k) desc
  loop
    if position('-' || r.k || '-' in k) > 0 then
      if not (r.id = any(out)) then out := out || r.id; end if;
      k := replace(k, '-' || r.k || '-', '-');
    end if;
  end loop;
  return out;
end $$;

-- "Text says Large" / "Text says Hot Pink" / null when the words and the pick agree (or the text has no size or color words)
create or replace function hq.line_check(p_text text, p_variant_id bigint)
returns text language plpgsql stable set search_path to '' as $$
declare v hq.variants; p hq.products; t text; k text; said text; picks boolean; cs hq.color_schemes; c text; bad text[] := '{}'; names text[];
begin
  if p_variant_id is null or hq.line_clean(p_text) is null then return null; end if;
  select * into v from hq.variants where id = p_variant_id; if v.id is null then return null; end if;
  select * into p from hq.products where id = v.product_id;
  t := regexp_replace(hq.line_clean(p_text), '\(matte\)', ' Matte', 'gi');
  -- the catalog's own name for this item carries no customer words
  if hq.name_key(t) = hq.name_key(v.inventory_name) or hq.name_key(t) = v.sku then return null; end if;
  k := '-' || hq.name_key(t) || '-';

  -- size word
  said := case when k like '%-large-%' or k like '%-lg-%' then 'large'
               when k like '%-small-%' or k like '%-sm-%' or k like '%-standard-%' or k like '%-regular-%' or k like '%-reg-%' then 'small'
               when hq.is_custom(t) then 'custom' end;
  -- measurements in the text and Custom picked agree, whatever size word sits beside them; an enclosure has no custom size
  if v.size_code = 'custom' and hq.is_custom(t) then said := null; end if;
  if v.product_id = 'enclosure' and said = 'custom' then said := null; end if;
  if said is not null and said <> v.size_code and not (said = 'small' and v.size_code = 'standard') then
    return 'Text says ' || case said when 'custom' then 'custom size' else initcap(said) end;
  end if;

  -- color names, only for a product that is made in more than one color
  picks := p.customer_picks_color
        or exists (select 1 from hq.product_colors pc where pc.product_id = p.id)
        or exists (select 1 from hq.variants x where x.product_id = p.id and x.color_scheme_id <> 'standard');
  if not picks then return null; end if;
  select * into cs from hq.color_schemes where id = v.color_scheme_id;
  foreach c in array hq.text_colors(t) loop
    if c is distinct from cs.color_1 and c is distinct from cs.color_2
       and not (v.color_scheme_id = c or v.color_scheme_id like c || '-%' or v.color_scheme_id like '%-' || c) then
      bad := bad || c;
    end if;
  end loop;
  if cardinality(bad) = 0 then return null; end if;
  select array_agg(x.name order by array_position(bad, x.id)) into names from hq.colors x where x.id = any(bad);
  return 'Text says ' || array_to_string(names, ' + ');
end $$;

grant execute on function hq.line_check(text, bigint), hq.text_colors(text) to authenticated;
