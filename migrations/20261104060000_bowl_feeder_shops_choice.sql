-- A Bowl Feeder ordered without a color is a complete order line: it matches the "Shop's choice" colorway and the shop
-- decides the color when it's packed (Bin View → Change item… picks White or Lavender and takes it from that shelf).
insert into hq.colors (id, name, aliases, on_filament_list) values ('shop-choice', 'Shop''s choice', '{}', false) on conflict (id) do nothing;
insert into hq.color_schemes (id, name, color_1, color_2) values ('shop-choice', 'Shop''s choice', 'shop-choice', null) on conflict (id) do nothing;
insert into hq.variants (sku, product_id, size_code, color_scheme_id, option_code, notion_inventory_id, inventory_name)
select 'bowl-feeder-small-shop-choice', 'bowl-feeder', 'small', 'shop-choice', 'standard', replace(gen_random_uuid()::text, '-', ''), 'Bowl Feeder (Small, Shop''s choice)'
where not exists (select 1 from hq.variants where sku = 'bowl-feeder-small-shop-choice');
update hq.products set default_color_scheme_id = 'shop-choice', updated_at = now() where id = 'bowl-feeder';

-- open bowl lines with no color
update hq.order_lines ol set variant_id = x.variant_id, match = x.match
  from (select l.uid, lv.variant_id, lv.match from hq.order_lines l join hq.orders o on o.id = l.order_id, lateral hq.line_variant(l.text, 'frankie') lv
         where o.deleted_at is null and o.status <> 'Done' and l.match = 'unmatched' and lv.match = 'item') x
 where x.uid = ol.uid;
