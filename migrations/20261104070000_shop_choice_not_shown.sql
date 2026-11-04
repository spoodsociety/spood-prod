-- The Shop's choice colorway is not written on the item: "Bowl Feeder (Small)" on Bin View, Print Plan and Inventory.
update hq.variants set inventory_name = 'Bowl Feeder (Small)' where sku = 'bowl-feeder-small-shop-choice';
do $do$
declare src text := pg_get_viewdef('hq.catalog'::regclass);
  old text := $x$NULLIF(cs.name, 'Standard'::text),$x$;
  new text := $x$CASE WHEN (cs.id = ANY (ARRAY['standard'::text, 'shop-choice'::text])) THEN NULL::text ELSE cs.name END,$x$;
begin
  if (length(src) - length(replace(src, old, ''))) / length(old) <> 1 then raise exception 'catalog view: colorway anchor not found once'; end if;
  execute 'create or replace view hq.catalog as ' || replace(src, old, new);
end $do$;
