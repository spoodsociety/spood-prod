-- Nov 5, 2026 — the enclosure door (magnetic vs latch) is checked against the pick, like size and color.
--
-- Why: an order's words saying "magnet" or "latch" were only read by the Bin View browser code. The server
-- compared size and color but not the door, so a magnet request on a line picked as the standard (latch)
-- enclosure was never stored as a conflict and showed nowhere but one chip. Now hq.line_check returns
-- "Text says Magnetic" / "Text says Latch" when the words and the picked enclosure variant disagree, and the
-- stored order_lines.conflict shows as the orange pill on every screen.
--
-- Door words: magnet / magnets / magnetic -> the magnetic variant (option_code 'magnetic');
--             latch -> the standard enclosure (option_code 'standard', the latch door).
-- Only for product 'enclosure': "Celestial Bat Magnetic Background" is a back panel, not a door.

create or replace function hq.line_check(p_text text, p_variant_id bigint)
returns text language plpgsql stable set search_path to '' as $$
declare v hq.variants; p hq.products; t text; k text; said text; door text; picks boolean; cs hq.color_schemes; c text; bad text[] := '{}'; names text[];
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

  -- door word, enclosures only
  if v.product_id = 'enclosure' then
    door := case when k like '%-magnet%' then 'magnetic' when k like '%-latch%' then 'standard' end;
    if door is not null and door <> coalesce(v.option_code, 'standard') then
      return 'Text says ' || case door when 'magnetic' then 'Magnetic' else 'Latch' end;
    end if;
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

-- stored conflicts on enclosure lines follow the new rule
update hq.order_lines l set conflict = hq.line_check(l.text, l.variant_id)
from hq.variants v where v.id = l.variant_id and v.product_id = 'enclosure'
  and hq.line_check(l.text, l.variant_id) is distinct from l.conflict;
