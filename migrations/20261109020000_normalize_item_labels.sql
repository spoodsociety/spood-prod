-- Item labels brought in line with their own catalog fields (Frankie, Nov 9 2026). Old labels are kept in app_log.
with fix(sku, label) as (values
  ('cosmic-wall-climb-small-turquoise-blue',                'Cosmic - Wall Climb (Small, Turquoise Blue)'),
  ('cosmic-wall-climb-large-turquoise-blue',                'Cosmic - Wall Climb (Large, Turquoise Blue)'),
  ('floor-insert-checkered-large-hot-pink-turquoise-blue',  'Floor Insert - Checkered (Large, Hot Pink + Turquoise Blue)'),
  ('gothic-coffin-hide-oreo-marble',                        'Gothic - Coffin Hide (Oreo Marble)'),
  ('cosmic-wall-climb-small-grape-jelly-translucent',       'Cosmic - Wall Climb (Small, Translucent Purple)'),
  ('yeti-yeti-hide-small-white-silk-powder-blue',           'Yeti - Yeti Hide (Small, White Silk + Powder Blue)'),
  ('yeti-yeti-hide-small-grey',                             'Yeti - Yeti Hide (Small, Grey)'),
  ('gothic-coffin-hide-olive-green',                        'Gothic - Coffin Hide (Olive Green)'),
  ('gothic-coffin-hide-hot-pink-grape-jelly-translucent',   'Neon Halloween - Coffin Hide (Hot Pink + Translucent Purple)'),
  ('floor-insert-wavy-checkered-small-lavender-matte-gitd-green', 'Neon Halloween - Trippy Floor Insert (Small, Lavender (Matte) + GITD Green)'),
  ('yeti-yeti-hide-small-white-light-pink',                 'Yeti - Yeti Hide (Small, White + Light Pink)'),
  ('yeti-yeti-hide-small-white-lavender-matte',             'Yeti - Yeti Hide (Small, White + Lavender (Matte))')),
logged as (
  insert into hq.app_log (op_id, kind, data, by_user)
  select gen_random_uuid()::text, 'label_normalized', jsonb_build_object('sku', v.sku, 'variant_id', v.id, 'from', v.inventory_name, 'to', f.label), 'claude'
  from hq.variants v join fix f on f.sku = v.sku where v.inventory_name is distinct from f.label),
-- the old label keeps resolving to the same item when it is pasted or imported again
remembered as (
  insert into hq.line_aliases (alias_key, untracked, decided_by, variant_id, sample_text)
  select hq.name_key(v.inventory_name), false, 'catalog', v.id, v.inventory_name
  from hq.variants v join fix f on f.sku = v.sku where v.inventory_name is distinct from f.label
  on conflict (alias_key) do nothing)
update hq.variants v set inventory_name = f.label from fix f where f.sku = v.sku and v.inventory_name is distinct from f.label;

-- Coffin Hide is one-size. The Small "Hot Pink + Grape Jelly Translucent" was the Neon Halloween two-color coffin entered a second time:
-- its lines and learned texts move to the one-size item, then it and the Small size are archived (nothing deleted).
with dup as (select id from hq.variants where sku = 'gothic-coffin-hide-small-hot-pink-grape-jelly-translucent'),
     keep as (select id from hq.variants where sku = 'gothic-coffin-hide-hot-pink-grape-jelly-translucent'),
logged as (
  insert into hq.app_log (op_id, kind, data, by_user)
  select gen_random_uuid()::text, 'relink', jsonb_build_object('uid', l.uid, 'order_id', l.order_id, 'text', l.text, 'from_variant', l.variant_id, 'to_variant', (select id from keep), 'reason', 'Coffin Hide is one-size; duplicate Small variant merged'), 'claude'
  from hq.order_lines l where l.variant_id = (select id from dup)),
al as (update hq.line_aliases set variant_id = (select id from keep) where variant_id = (select id from dup))
update hq.order_lines set variant_id = (select id from keep) where variant_id = (select id from dup);
update hq.variants set archived = true where sku = 'gothic-coffin-hide-small-hot-pink-grape-jelly-translucent';
update hq.product_sizes set archived = true where product_id = 'gothic-coffin-hide' and code = 'small';
