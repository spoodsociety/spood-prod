-- Tweezers are a printed piece, not a bought supply (owner: Frankie, Nov 12, 2026).
-- hq.line_kind treats category Supply as stock; Add-on is a printed add-on, so its lines read "Needs printing" and show on the Print Plan.
insert into hq.app_log (op_id, kind, data, by_user)
select 'tweezers_are_printed', 'product_recategorized', jsonb_build_object('product', id, 'from', category, 'to', 'Add-on'), 'claude'
from hq.products where id = 'tweezers' and category <> 'Add-on';
update hq.products set category = 'Add-on', updated_at = now() where id = 'tweezers' and category <> 'Add-on';
