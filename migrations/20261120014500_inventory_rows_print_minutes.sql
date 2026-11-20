-- inventory_rows returns the print time saved on the item's size (product_sizes.print_minutes, edited in Inventory -> Items).
-- The Print Plan used a rough guess from the item's name for every piece and never read the saved time. Same rows, same grants, one more column.
drop function hq.inventory_rows();
create function hq.inventory_rows()
 returns table(id text, item text, name text, collection text, tags text, in_stock integer, tracked boolean, note text, sku text, updated_at timestamp with time zone, owed integer, size text, print_minutes integer)
 language sql stable security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
  with w as (select x.variant_id, sum(x.needs)::integer n from hq.shelf_alloc() x group by 1)
  select v.notion_inventory_id, coalesce(v.inventory_name, v.sku), k.display_name, k.collection, k.tags,
         case when p.tracked and p.fulfillment_type = 'individual' then coalesce(s.on_hand, 0) end,
         p.tracked and p.fulfillment_type = 'individual', v.note, v.sku, v.updated_at, coalesce(w.n, 0), k.size, z.print_minutes
  from hq.variants v
  join hq.products p on p.id = v.product_id
  join hq.catalog k on k.variant_id = v.id
  left join hq.product_sizes z on z.product_id = v.product_id and z.code = v.size_code
  left join hq.stock_on_hand s on s.variant_id = v.id
  left join w on w.variant_id = v.id
  where v.notion_inventory_id is not null and not v.archived
  order by k.collection nulls last, coalesce(v.inventory_name, v.sku)
$function$;
grant execute on function hq.inventory_rows() to authenticated;
