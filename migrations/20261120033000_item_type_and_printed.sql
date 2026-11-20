-- An item's type is the shop's own word, and whether the shop prints it is its own switch.
-- Until now: Inventory guessed a type from words in the item's name (anything it didn't recognise was a "Hide") and never read the type saved in Items;
-- the type had to be one of twelve built-in words; and "printed or bought" was read off the type (Kit and Supply = not printed), so it couldn't be set.
--   products.printed            the switch (Items -> "We print it"). Starts as the old rule gave it: off for Kit and Supply, on for everything else.
--   hq.line_kind                a matched line is a print line when its item is printed and tracked; the type no longer decides
--   save_item / add_variant_core  any type up to 40 letters; one already in use keeps its spelling. save_item also saves printed.
--   catalog_options.categories  the built-in types plus any the shop has added
--   inventory_rows              also returns category and printed, so Inventory shows the item's real type

alter table hq.products add column printed boolean not null default true;
update hq.products set printed = false where category in ('Kit', 'Supply');

do $patch$
declare d text; a text; b text;
  types constant text := $t$array['Hide','Ledge','Climb','Floor Insert','Insert','Figure','Part','Enclosure','Add-on','Supply','Kit','Set']$t$;
  fn constant text := $q$select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'hq' and p.proname = $q$;
begin
  -- line_kind
  execute fn || quote_literal('line_kind') into d;
  a := $a$case when p_category in ('Kit', 'Supply') or exists (select 1 from hq.products p where p.id = p_product and not p.tracked) then 'stock' else 'print' end$a$;
  if position(a in d) = 0 then raise exception 'line_kind: anchor not found'; end if;
  execute replace(d, a, $b$case when exists (select 1 from hq.products p where p.id = p_product and (not p.printed or not p.tracked)) then 'stock' else 'print' end   -- the item's own switch (Items -> We print it), not its type$b$);

  -- save_item: any type; printed
  execute fn || quote_literal('save_item') into d;
  a := '  if not (v_cat = any (' || types || E')) then\n    raise exception ''Not an item type: "%"'', v_cat;';
  if position(a in d) = 0 then raise exception 'save_item: type anchor not found'; end if;
  d := replace(d, a, E'  -- a type is the shop''s own word: a built-in one or one already in use keeps its spelling, a new one is taken as typed\n'
    || E'  v_cat := regexp_replace(v_cat, ''\\s+'', '' '', ''g'');\n'
    || '  v_cat := coalesce((select x from unnest(' || types || E') x where lower(x) = lower(v_cat) limit 1),\n'
    || E'                    (select q.category from products q where lower(q.category) = lower(v_cat) order by q.category limit 1), v_cat);\n'
    || E'  if v_cat = '''' or length(v_cat) > 40 then\n    raise exception ''Give the item a type (up to 40 letters)'';');
  a := $a$addon = case when p ? 'addon' then coalesce((p->>'addon')::boolean, q.addon) else q.addon end,$a$;
  if position(a in d) = 0 then raise exception 'save_item: addon anchor not found'; end if;
  execute replace(d, a, a || $b$
         printed = case when p ? 'printed' then coalesce((p->>'printed')::boolean, q.printed) else q.printed end,$b$);

  -- read_item: printed
  execute fn || quote_literal('read_item') into d;
  a := $a$'addon', p.addon, 'archived', p.archived,$a$;
  if position(a in d) = 0 then raise exception 'read_item: anchor not found'; end if;
  execute replace(d, a, $b$'addon', p.addon, 'printed', p.printed, 'archived', p.archived,$b$);

  -- add_variant_core: a new piece can have any type; printed starts from the old rule
  execute fn || quote_literal('add_variant_core') into d;
  a := 'if v_cat is null or not (v_cat = any(' || types || ')) then';
  if position(a in d) = 0 then raise exception 'add_variant_core: type anchor not found'; end if;
  d := replace(d, a, 'if v_cat is null or length(v_cat) > 40 then');
  a := 'insert into hq.products (id, name, category, fulfillment_type, tracked)'; b := $b$coalesce((p->>'tracked')::boolean, true));$b$;
  if position(a in d) = 0 or position(b in d) = 0 then raise exception 'add_variant_core: insert anchor not found'; end if;
  execute replace(replace(d, a, 'insert into hq.products (id, name, category, fulfillment_type, tracked, printed)'), b, $c$coalesce((p->>'tracked')::boolean, true), v_cat not in ('Kit', 'Supply'));$c$);

  -- catalog_options: built-in types plus the shop's own
  execute fn || quote_literal('catalog_options') into d;
  a := substring(d from $re$'categories',\s*'\[[^\]]*\]'::jsonb,$re$);
  if a is null then raise exception 'catalog_options: anchor not found'; end if;
  execute replace(d, a, $b$'categories',  (select jsonb_agg(x.c order by x.o, x.c) from (
                      select b.c, b.o from unnest($b$ || types || $b$) with ordinality b(c, o)
                      union all
                      select distinct p.category, 100 from hq.products p where not p.archived and not (p.category = any($b$ || types || $b$))) x),$b$);
end $patch$;

drop function hq.inventory_rows();
create function hq.inventory_rows()
 returns table(id text, item text, name text, collection text, tags text, in_stock integer, tracked boolean, note text, sku text, updated_at timestamp with time zone, owed integer, size text, print_minutes integer, product_id text, product text, color text, option text, aka text, category text, printed boolean)
 language sql stable security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
  with w as (select x.variant_id, sum(x.needs)::integer n from hq.shelf_alloc() x group by 1)
  select v.notion_inventory_id, v.inventory_name, v.inventory_name, k.collection, k.tags,
         case when p.tracked and p.fulfillment_type = 'individual' then coalesce(s.on_hand, 0) end,
         p.tracked and p.fulfillment_type = 'individual', v.note, v.sku, v.updated_at, coalesce(w.n, 0), k.size, z.print_minutes,
         p.id, p.name,
         case when v.color_scheme_id in ('standard', 'shop-choice') then null else k.color end,
         case when v.option_code <> 'standard' then initcap(replace(v.option_code, '-', ' ')) end,
         nullif(array_to_string(p.aliases, ' | '), ''), p.category, p.printed
  from hq.variants v
  join hq.products p on p.id = v.product_id
  join hq.catalog k on k.variant_id = v.id
  left join hq.product_sizes z on z.product_id = v.product_id and z.code = v.size_code
  left join hq.stock_on_hand s on s.variant_id = v.id
  left join w on w.variant_id = v.id
  where v.notion_inventory_id is not null and not v.archived
  order by k.collection nulls last, v.inventory_name
$function$;
revoke all on function hq.inventory_rows() from public, anon;
grant execute on function hq.inventory_rows() to authenticated;
