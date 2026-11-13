-- Dried Substrate - 10g is a bought stock item, not a printed piece (owner: Frankie, Nov 12, 2026).
-- hq.line_kind treats category Supply as stock, so its lines read "Pull from shelf" / "Out of stock" and stay off the Print Plan.
insert into hq.app_log (op_id, kind, data, by_user)
select 'dried_substrate_is_supply', 'product_recategorized', jsonb_build_object('product', id, 'from', category, 'to', 'Supply'), 'claude'
from hq.products where id = 'dried-substrate-10g' and category <> 'Supply';
update hq.products set category = 'Supply', updated_at = now() where id = 'dried-substrate-10g' and category <> 'Supply';
