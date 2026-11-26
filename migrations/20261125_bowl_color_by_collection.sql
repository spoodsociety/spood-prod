-- Nov 25, 2026. Frankie: "feeder bowl defaults are: sage green for bigfoot enclosure and woodland; taro purple for
-- cosmic and celestial. other cases would default white".
--
-- 1. products.color_by_collection: {collection id: color scheme id, "*": the color for any other order}.
--    Set on the Bowl Feeder only. The order form reads it from catalog_options and fills the color in.
--    The bowl keeps "Color required" and keeps no catalog-wide default color: a bowl that arrives as text with no
--    color on an order nobody has opened still says "Needs a color" (the resolver sees one line, not the order).
-- 2. Open bowl lines still waiting for a color take the default for their order's collections. Words kept.
--    An order that names both a sage collection and a taro collection is left for a person.
alter table hq.products add column if not exists color_by_collection jsonb;
do $mig$
declare d text; n int; r record; v_var bigint; v_scheme text; v_prev jsonb; done jsonb := '[]';
  a1 text := $a$'color_required', p.color_required,$a$;
  b1 text := $b$'color_required', p.color_required, 'color_by_collection', p.color_by_collection,$b$;
begin
  update hq.products set color_by_collection = '{"bigfoot":"sage-green","woodland":"sage-green","cosmic":"taro-purple","celestial-bat":"taro-purple","*":"white"}'::jsonb
   where id = 'bowl-feeder' and color_by_collection is distinct from '{"bigfoot":"sage-green","woodland":"sage-green","cosmic":"taro-purple","celestial-bat":"taro-purple","*":"white"}'::jsonb;
  d := pg_get_functiondef('hq.catalog_options()'::regprocedure);
  if position('color_by_collection' in d) = 0 then
    n := (length(d) - length(replace(d, a1, ''))) / length(a1); if n <> 1 then raise exception 'catalog_options: anchor found % times', n; end if;
    execute replace(d, a1, b1);
  end if;
  for r in select l.uid, l.order_id, l.text, o.collections
             from hq.order_lines l join hq.orders o on o.id = l.order_id
            where o.status <> 'Done' and o.deleted_at is null and l.match = 'unmatched'
              and hq.resolve_line(l.text)->>'reason' = 'needs color' and hq.resolve_line(l.text)->>'product_id' = 'bowl-feeder'
            order by o.ship_by nulls last, o.id, l.line_no
            for update of l loop
    select case when count(distinct m.s) = 1 then min(m.s) when count(distinct m.s) = 0 then 'white' end into v_scheme
      from (select p.color_by_collection->>c.id s from hq.products p, hq.collections c
             where p.id = 'bowl-feeder' and c.name = any(r.collections) and p.color_by_collection ? c.id) m;
    continue when v_scheme is null;
    select v.id into v_var from hq.variants v
     where v.product_id = 'bowl-feeder' and v.color_scheme_id = v_scheme and v.option_code = 'standard' and not v.archived
       and v.size_code = coalesce(hq.resolve_line(r.text)->>'size_code', 'small');
    continue when v_var is null;
    v_prev := hq.order_json(r.order_id);
    update hq.order_lines x set variant_id = v_var, match = 'item', conflict = hq.line_check(x.text, v_var) where x.uid = r.uid and x.match = 'unmatched';
    update hq.orders o set version = o.version + 1 where o.id = r.order_id;
    insert into hq.order_history (order_id, op_id, source, before, after, by_user)
    values (r.order_id, 'bowl-default-' || replace(gen_random_uuid()::text, '-', ''), 'hq', v_prev, hq.order_json(r.order_id), 'bowl-default-20261125');
    done := done || jsonb_build_object('order_id', r.order_id, 'uid', r.uid, 'text', r.text, 'collections', to_jsonb(r.collections), 'color', v_scheme, 'variant_id', v_var);
  end loop;
  if jsonb_array_length(done) > 0 and not exists (select 1 from hq.app_log where op_id = 'bowl-default-20261125') then
    insert into hq.app_log (op_id, kind, data, by_user) values ('bowl-default-20261125', 'bowl_default_color', jsonb_build_object('lines', done), 'lorino.frankie');
  end if;
end $mig$;
