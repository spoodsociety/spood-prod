-- A variation has no name of its own. Its name is the item's name plus its size, color and option:
--   Checkered Wavy Floor (Small, Stardust Purple + Turquoise Blue)
-- Until now every variation also carried a typed label from the Notion inventory ("Neon Halloween - Trippy Floor Insert (Small, …)"),
-- and Inventory, Bin View and the Print Plan read the item, size and color back out of that text while order cards showed the catalog's name.
-- Two names per variation, and the typed one drifted from the item (196 of 210 disagreed with their item's name).
--
--   hq.variant_name(product, size, colorway, option)  the one rule
--   trigger name_from_item on hq.variants             sets inventory_name from that rule on every insert and update: a typed name is ignored
--   trigger variant_names on products / product_sizes / color_schemes   a renamed item, size or colorway renames its variations
--   trigger renamed on hq.variants                    same item under a new name: order lines that only carried the old name carry the new one
--                                                     (open orders get version + 1), and the old name is kept as learned wording
-- Existing labels are rewritten once here; each old label is logged (app_log kind label_normalized) and kept as wording.

create or replace function hq.variant_name(p_product text, p_size text, p_scheme text, p_option text)
 returns text
 language sql
 stable
 set search_path to ''
as $function$
  select p.name || coalesce(' (' || nullif(concat_ws(', ',
           nullif(s.name, 'Standard'),
           case when cs.id in ('standard', 'shop-choice') then null else cs.name end,
           case when coalesce(p_option, 'standard') <> 'standard' then initcap(replace(p_option, '-', ' ')) end), '') || ')', '')
  from hq.products p
  left join hq.product_sizes s on s.product_id = p.id and s.code = p_size
  left join hq.color_schemes cs on cs.id = p_scheme
  where p.id = p_product
$function$;

create or replace function hq.variants_name()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  new.inventory_name := hq.variant_name(new.product_id, new.size_code, new.color_scheme_id, new.option_code);
  return new;
end $function$;

create or replace function hq.variants_renamed()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare k_old text := hq.name_key(old.inventory_name); k_new text := hq.name_key(new.inventory_name);
begin
  -- wording learned for another item can't also be this item's name (the learned wording is read first and would win)
  if not new.archived and k_new is not null then
    delete from hq.line_aliases a where a.alias_key = k_new and a.variant_id is distinct from new.id;
  end if;
  -- a different item now (its size, color or option changed): its lines keep their words and are re-checked by save_item
  if k_old is null or (old.product_id, old.size_code, old.color_scheme_id, old.option_code)
                      is distinct from (new.product_id, new.size_code, new.color_scheme_id, new.option_code) then
    return null;
  end if;
  -- the same item under a new name: a line that only carried the item's name carries the new one
  with ch as (
    update hq.order_lines l set text = new.inventory_name
     where l.variant_id = new.id and hq.name_key(l.text) = k_old and l.text is distinct from new.inventory_name
    returning l.order_id)
  update hq.orders o set version = o.version + 1
   where o.id in (select ch.order_id from ch) and o.status <> 'Done' and o.deleted_at is null;
  -- the old name still finds the item, unless another item is called that now or its words disagree with the item
  if not new.archived and k_old is distinct from k_new
     and not exists (select 1 from hq.variants z where z.id <> new.id and not z.archived and hq.name_key(z.inventory_name) = k_old)
     and hq.line_check(old.inventory_name, new.id) is null then
    insert into hq.line_aliases (alias_key, variant_id, sample_text, decided_by)
    values (k_old, new.id, old.inventory_name, 'rename') on conflict do nothing;
  end if;
  return null;
end $function$;

create or replace function hq.variants_rename_all()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if tg_table_name = 'products' then
    update hq.variants v set inventory_name = v.inventory_name where v.product_id = new.id;
  elsif tg_table_name = 'product_sizes' then
    update hq.variants v set inventory_name = v.inventory_name where v.product_id = new.product_id and v.size_code = new.code;
  elsif tg_table_name = 'color_schemes' then
    update hq.variants v set inventory_name = v.inventory_name where v.color_scheme_id = new.id;
  end if;
  return null;
end $function$;

revoke all on function hq.variant_name(text, text, text, text) from public, anon, authenticated;
revoke all on function hq.variants_name() from public, anon, authenticated;
revoke all on function hq.variants_renamed() from public, anon, authenticated;
revoke all on function hq.variants_rename_all() from public, anon, authenticated;

create trigger name_from_item before insert or update on hq.variants
  for each row execute function hq.variants_name();
create trigger renamed after update on hq.variants
  for each row when (old.inventory_name is distinct from new.inventory_name) execute function hq.variants_renamed();
create trigger variant_names after update on hq.products
  for each row when (old.name is distinct from new.name) execute function hq.variants_rename_all();
create trigger variant_names after update on hq.product_sizes
  for each row when (old.name is distinct from new.name) execute function hq.variants_rename_all();
create trigger variant_names after update on hq.color_schemes
  for each row when (old.name is distinct from new.name) execute function hq.variants_rename_all();

-- Existing labels: log each old one, then let the triggers rewrite them (old label kept as wording, lines that carried it follow).
insert into hq.app_log (op_id, kind, data, by_user)
select 'names-from-item:' || v.id, 'label_normalized',
       jsonb_build_object('variant_id', v.id, 'sku', v.sku, 'from', v.inventory_name,
                          'to', hq.variant_name(v.product_id, v.size_code, v.color_scheme_id, v.option_code), 'why', 'variation names come from the item'),
       'claude'
from hq.variants v
where v.inventory_name is distinct from hq.variant_name(v.product_id, v.size_code, v.color_scheme_id, v.option_code);

update hq.variants v set inventory_name = v.inventory_name
 where v.inventory_name is distinct from hq.variant_name(v.product_id, v.size_code, v.color_scheme_id, v.option_code);
set constraints all immediate;   -- the queued re-match of open lines runs now; a table with queued trigger events can't be altered
alter table hq.variants alter column inventory_name set not null;
set constraints all deferred;

-- The catalog view's display_name had its own copy of the rule (plus " Floor Insert" added to some names). One name now.
create or replace view hq.catalog as
 select v.id as variant_id,
    v.sku,
    ( select string_agg(c.name, ', '::text order by c.name) as string_agg
           from (hq.collection_pieces cp
             join hq.collections c on ((c.id = cp.collection_id)))
          where ((cp.product_id = v.product_id) and (cp.color_scheme_id is null) and (not cp.enclosure_only) and (not c.archived))) as collection,
    p.name as product,
    p.category,
    s.name as size,
    cs.name as color,
    nullif(v.option_code, 'standard'::text) as option,
    p.tracked,
    v.notion_inventory_id,
    v.inventory_name as display_name,
    ( select string_agg(c.name, ', '::text order by c.name) as string_agg
           from (hq.collection_pieces cp
             join hq.collections c on ((c.id = cp.collection_id)))
          where ((cp.product_id = v.product_id) and (cp.color_scheme_id = v.color_scheme_id) and (cp.color_scheme_id <> 'standard'::text) and (not cp.enclosure_only) and (not c.archived))) as tags,
    v.archived
   from (((hq.variants v
     join hq.products p on ((p.id = v.product_id)))
     join hq.product_sizes s on (((s.product_id = v.product_id) and (s.code = v.size_code))))
     join hq.color_schemes cs on ((cs.id = v.color_scheme_id)));

-- inventory_rows hands the screens the item, color and option as the catalog has them, so nothing is read back out of the name.
-- Same rows, same grants; item and name are the same text now; aka = the item's other names (for search).
drop function hq.inventory_rows();
create function hq.inventory_rows()
 returns table(id text, item text, name text, collection text, tags text, in_stock integer, tracked boolean, note text, sku text, updated_at timestamp with time zone, owed integer, size text, print_minutes integer, product_id text, product text, color text, option text, aka text)
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
         nullif(array_to_string(p.aliases, ' | '), '')
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

-- Functions that took or built a typed name: update_variant ignores one; line_variant and pick_variant start from the item's name.
do $patch$
declare d text; n text; a text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'hq' and p.proname = 'update_variant';
  a := $a$v_name text := nullif(trim(p->>'inventory_name'), '');$a$;
  if position(a in d) = 0 then raise exception 'update_variant: anchor not found'; end if;
  execute replace(d, a, $b$v_name text := null;   -- a variation's name comes from its item, size and color (hq.variant_name); a typed name is ignored$b$);

  foreach n in array array['line_variant', 'pick_variant'] loop
    select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'hq' and p.proname = n;
    a := substring(d from $re$select regexp_replace\(v\.inventory_name.*?limit 1;$re$);
    if a is null then raise exception '%: anchor not found', n; end if;
    execute replace(d, a, '-- (the name starts from the item''s name; see hq.variant_name)');
  end loop;
end $patch$;
