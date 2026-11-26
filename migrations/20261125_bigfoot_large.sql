-- Nov 25, 2026. Frankie: "can you also add the option of large sizes for these" (the Bigfoot pieces on a Large Enclosure order).
-- Large is added, through the catalog's own add_variant, to the five Bigfoot pieces that had only Small.
-- Bigfoot Branch Ledge already had Large (added in the app the same day). Each new item starts at 0 on the shelf.
-- No order line is changed.
do $mig$
declare r record; x record; made jsonb := '[]';
begin
  for r in select p.id, p.name from hq.products p
            where p.id in ('bigfoot-background-insert','bigfoot-hide','bigfoot-mushroom-ledge-set','bigfoot-tree-tower','bigfoot-wrap-insert')
              and not exists (select 1 from hq.product_sizes s where s.product_id = p.id and s.code = 'large')
            order by p.name loop
    select * into x from hq.add_variant(jsonb_build_object('product', r.name, 'size', 'Large', 'inventory_name', r.name || ' (Large)', 'new', jsonb_build_array('size')));
    made := made || jsonb_build_object('item', r.name || ' (Large)', 'status', x.status, 'sku', x.sku, 'variant_id', x.variant_id);
  end loop;
  if jsonb_array_length(made) > 0 then
    insert into hq.app_log (op_id, kind, data, by_user) values ('bigfoot-large-20261125', 'size_added', jsonb_build_object('made', made), 'lorino.frankie');
  end if;
end $mig$;
