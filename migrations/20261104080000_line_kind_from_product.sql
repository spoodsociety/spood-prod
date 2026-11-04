-- A line matched to a catalog item takes its kind from the product (Kit/Supply/untracked = stock, else print); the words on
-- the line only decide for lines that are not in the catalog. "Celestial Bat Magnetic Background" is a printed Back Panel
-- Insert, not a bought part; "Floor - Substrate + Moss" is a supply, not a print. Checked against every saved line: 12 change, all correctly.
create or replace function hq.line_kind(p_text text, p_match text, p_product text, p_category text) returns text language sql stable set search_path to '' as $$
  select case
    when p_product = 'enclosure' or hq.is_enc_line(p_text) then 'enc'
    when p_match = 'untracked' then 'stock'
    when p_product is not null and p_match = 'item' then
      case when p_category in ('Kit', 'Supply') or exists (select 1 from hq.products p where p.id = p_product and not p.tracked) then 'stock' else 'print' end
    when coalesce(p_text, '') ~* '(starter\s*kit|c[ao]+c+o+n|\mplants?\M|substrate|moss|mystery|magnetic background|figurine|add[- ]?on\M)'
         and not (regexp_replace(coalesce(p_text, ''), 'starter\s*kit', '', 'gi') ~* '\m(hide|ledge|climb|floor|insert|cauldron|bowl|feeder)\M') then 'stock'
    else 'print' end
$$;
