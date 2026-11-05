-- The Order Desk's Add-ons bar is driven by a catalog flag, not by category,
-- so a product of any category (Silk Cocoon Hide) can sit on it without changing what it is.
alter table hq.products add column if not exists addon boolean not null default false;
comment on column hq.products.addon is 'Shown on the Order Desk Add-ons bar.';

update hq.products set addon = true
 where id in ('bowl-feeder', 'starter-kit', 'substrate-moss', 'natural-silk-cocoon-hide')
    or category in ('Add-on', 'Kit', 'Supply');

create or replace function hq.catalog_options()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
  select jsonb_build_object(
    'collections', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                       'sells_accessory_set', c.sells_accessory_set, 'sells_enclosure', c.sells_enclosure,
                       'choices', (select coalesce(jsonb_object_agg(x.choice, x.opts), '{}') from (
                                     select cp.choice, jsonb_agg(distinct cp.choice_option) opts from hq.collection_pieces cp
                                     where cp.collection_id = c.id and cp.choice is not null
                                       and exists (select 1 from hq.collection_pieces y where y.collection_id = c.id and y.choice = cp.choice and not y.enclosure_only)
                                     group by cp.choice) x),
                       'enclosure_choices', (select coalesce(jsonb_object_agg(x.choice, x.opts), '{}') from (
                                     select cp.choice, jsonb_agg(distinct cp.choice_option) opts from hq.collection_pieces cp
                                     where cp.collection_id = c.id and cp.choice is not null group by cp.choice) x),
                       'defaults', (select coalesce(jsonb_object_agg(cp.choice, cp.choice_option), '{}') from hq.collection_pieces cp
                                    where cp.collection_id = c.id and cp.default_option),
                       'pieces', (select count(distinct cp.product_id) from hq.collection_pieces cp join hq.products pr on pr.id = cp.product_id where cp.collection_id = c.id and not pr.archived)) order by c.name), '[]')
                    from hq.collections c where not c.archived),
    'categories',  '["Hide","Ledge","Climb","Floor Insert","Insert","Figure","Part","Enclosure","Add-on","Supply","Kit","Set"]'::jsonb,
    'products',    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'category', p.category, 'aliases', p.aliases,
                      'tracked', p.tracked, 'picks_color', p.customer_picks_color, 'default_scheme', p.default_color_scheme_id, 'addon', p.addon,
                      'collections', (select coalesce(jsonb_agg(distinct cp.collection_id), '[]') from hq.collection_pieces cp where cp.product_id = p.id and not cp.enclosure_only),
                      'offered', (select coalesce(jsonb_object_agg(x.slot, x.ids), '{}') from (
                                    select pc.slot, jsonb_agg(pc.color_id order by c.name) ids from hq.product_colors pc join hq.colors c on c.id = pc.color_id
                                    where pc.product_id = p.id and not c.archived group by pc.slot) x),
                      'sizes', (select coalesce(jsonb_agg(s.name order by s.code), '[]') from hq.product_sizes s where s.product_id = p.id and not s.archived),
                      'size_codes', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name) order by s.code = 'small' desc, s.code = 'standard' desc, s.code), '[]')
                                     from hq.product_sizes s where s.product_id = p.id and not s.archived)) order by p.name), '[]')
                    from hq.products p where not p.archived),
    'colors',      (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'aliases', c.aliases) order by c.name), '[]')
                    from hq.colors c where not c.archived),
    'color_schemes', (select coalesce(jsonb_agg(jsonb_build_object('id', cs.id, 'name', cs.name, 'color_1', cs.color_1, 'color_2', cs.color_2) order by cs.name), '[]')
                    from hq.color_schemes cs where not cs.archived),
    'variants',    (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'notion_id', v.notion_inventory_id, 'product_id', v.product_id,
                      'size_code', v.size_code, 'color_scheme_id', v.color_scheme_id, 'option_code', v.option_code,
                      'sku', v.sku, 'name', coalesce(v.inventory_name, v.sku)) order by v.id), '[]')
                    from hq.variants v join hq.products p on p.id = v.product_id where not v.archived and not p.archived)
  )
$function$;
