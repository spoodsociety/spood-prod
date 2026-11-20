-- resolve_line: a word on an order line that is one of the product's own sizes ("Mini") is a size, not an unknown color.
-- Only Small / Large / Sling / Custom / Standard were known as size words, so "Space Rock (Mini, Space Grey)" came back
-- "unknown color: mini" even though the catalog has that exact item. Any size a piece is given in the item editor now reads as a size.
-- Checked against every line text ever saved or learned (912): none changes; only Mini lines that were wrongly unresolved now match.
-- The function is patched in place (one statement added after the product is found); it fails loudly if that spot isn't there.
do $patch$
declare d text := pg_get_functiondef('hq.resolve_line(text)'::regprocedure);
  a text := $a$  v_prod := v_prods[1];
  select p.category, p.customer_picks_color, p.default_color_scheme_id into v_cat, v_pick, v_def from hq.products p where p.id = v_prod;$a$;
  b text := $b$  v_prod := v_prods[1];
  select p.category, p.customer_picks_color, p.default_color_scheme_id into v_cat, v_pick, v_def from hq.products p where p.id = v_prod;
  -- a word that is one of this product's own sizes ("Mini") is a size, not an unknown color
  v_badc := array(select x from unnest(v_badc) x where not exists (select 1 from hq.product_sizes s where s.product_id = v_prod and not s.archived and (s.code = x or hq.name_key(s.name) = x)));$b$;
begin
  if position('one of this product''s own sizes' in d) > 0 then return; end if;   -- already applied
  if position(a in d) = 0 then raise exception 'resolve_line: patch point not found'; end if;
  execute replace(d, a, b);
end $patch$;
