-- inventory_rows returns the catalog's display name (product name + size/color, e.g. "Christmas Tree Climb (Small)").
-- Bin View shows that instead of guessing a design name from the inventory name's "Collection - " prefix:
-- the product name already says whether the collection is part of the design's name (Christmas Tree Climb, Gothic Web Climb)
-- or not (Coffin Hide, Moon Hide). `item` (the inventory name) is unchanged for Inventory, Print Plan and lookups.

drop function hq.inventory_rows();
create function hq.inventory_rows()
 returns table(id text, item text, name text, collection text, tags text, in_stock integer, tracked boolean, note text, sku text, updated_at timestamptz, owed integer)
 language sql stable security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $$
  with w as (select x.variant_id, sum(x.needs)::integer n from hq.shelf_alloc() x group by 1)
  select v.notion_inventory_id, coalesce(v.inventory_name, v.sku), k.display_name, k.collection, k.tags,
         case when p.tracked and p.fulfillment_type = 'individual' then coalesce(s.on_hand, 0) end,
         p.tracked and p.fulfillment_type = 'individual', v.note, v.sku, v.updated_at, coalesce(w.n, 0)
  from hq.variants v
  join hq.products p on p.id = v.product_id
  join hq.catalog k on k.variant_id = v.id
  left join hq.stock_on_hand s on s.variant_id = v.id
  left join w on w.variant_id = v.id
  where v.notion_inventory_id is not null and not v.archived
  order by k.collection nulls last, coalesce(v.inventory_name, v.sku)
$$;
grant execute on function hq.inventory_rows() to authenticated;
