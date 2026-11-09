-- The color is "Sunshine Yellow (Matte)" (Frankie, Nov 9 2026): the two Galaxy Wall Climb labels now say so. Old labels logged and kept as aliases.
with fix(sku, label) as (values
  ('galaxy-wall-climb-small-sunshine-yellow-matte', 'Galaxy - Wall Climb (Small, Sunshine Yellow (Matte))'),
  ('galaxy-wall-climb-large-sunshine-yellow-matte', 'Galaxy - Wall Climb (Large, Sunshine Yellow (Matte))')),
logged as (
  insert into hq.app_log (op_id, kind, data, by_user)
  select gen_random_uuid()::text, 'label_normalized', jsonb_build_object('sku', v.sku, 'variant_id', v.id, 'from', v.inventory_name, 'to', f.label), 'claude'
  from hq.variants v join fix f on f.sku = v.sku where v.inventory_name is distinct from f.label),
remembered as (
  insert into hq.line_aliases (alias_key, untracked, decided_by, variant_id, sample_text)
  select hq.name_key(v.inventory_name), false, 'catalog', v.id, v.inventory_name
  from hq.variants v join fix f on f.sku = v.sku where v.inventory_name is distinct from f.label
  on conflict (alias_key) do nothing)
update hq.variants v set inventory_name = f.label from fix f where f.sku = v.sku and v.inventory_name is distinct from f.label;
