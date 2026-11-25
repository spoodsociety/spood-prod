-- Bowl Feeder: a color has to be picked (Frankie, Nov 25 2026). Replaces the Nov 4 rule (20261104060000_bowl_feeder_shops_choice.sql),
-- where a bowl with no color was a complete line on the no-color item "Bowl Feeder (Small)".
--
-- 1. hq.products.color_required: the order form will not save a picked line of such an item without a color.
--    Carried by catalog_options and read_item, saved by save_item (Items: "Color required").
-- 2. Bowl Feeder: color required, no default color.
-- 3. Open order lines on the no-color bowl go back to "needs a color" (their words are kept). Done and deleted orders are left alone.
-- 4. Wording that meant "a bowl, no color" is forgotten, so it asks for a color instead of matching by itself.
-- 5. The no-color bowl item and the "Shop's choice" color are retired (archived, not deleted).
alter table hq.products add column if not exists color_required boolean not null default false;

do $mig$
declare
  d text; d2 text; r record;
  v_var bigint; v_notion text; v_prev jsonb; v_orders jsonb := '[]'; v_forgot jsonb;
begin
  -- ---------- 1. the three functions carry the flag (one exact place each; stop if any is not as expected) ----------
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'hq' and p.proname = 'catalog_options';
  if position('color_required' in d) = 0 then
    d2 := replace(d, $s$'addon', p.addon,$s$, $s$'addon', p.addon, 'color_required', p.color_required,$s$);
    if d2 = d then raise exception 'catalog_options: place for color_required not found'; end if;
    execute d2;
  end if;
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'hq' and p.proname = 'read_item';
  if position('color_required' in d) = 0 then
    d2 := replace(d, $s$'addon', p.addon,$s$, $s$'addon', p.addon, 'color_required', p.color_required,$s$);
    if d2 = d then raise exception 'read_item: place for color_required not found'; end if;
    execute d2;
  end if;
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'hq' and p.proname = 'save_item';
  if position('color_required' in d) = 0 then
    d2 := replace(d, $s$else q.addon end,$s$, $s$else q.addon end,
         color_required = case when p ? 'color_required' then coalesce((p->>'color_required')::boolean, q.color_required) else q.color_required end,$s$);
    if d2 = d then raise exception 'save_item: place for color_required not found'; end if;
    execute d2;
  end if;

  -- ---------- 2. Bowl Feeder ----------
  -- (this update runs the usual re-match of open lines once, while the bowl lines are still linked; nothing about them changes yet)
  update hq.products set color_required = true, default_color_scheme_id = null where id = 'bowl-feeder';
  -- the rest of this change must not be re-matched half way through
  perform set_config('hq.rematch_done', txid_current()::text, true);

  select v.id, v.notion_inventory_id into v_var, v_notion from hq.variants v where v.sku = 'bowl-feeder-small-shop-choice';
  if v_var is not null then
    -- ---------- 3. open lines on the no-color bowl ----------
    for r in select distinct o.id, o.customer from hq.orders o join hq.order_lines l on l.order_id = o.id
              where l.variant_id = v_var and o.status <> 'Done' and o.deleted_at is null order by o.id loop
      v_prev := hq.order_json(r.id);
      update hq.order_lines set variant_id = null, match = 'unmatched', conflict = null where order_id = r.id and variant_id = v_var;
      update hq.orders set version = version + 1 where id = r.id;
      insert into hq.order_history (order_id, op_id, source, before, after, by_user)
      values (r.id, 'bowlcolor-' || replace(gen_random_uuid()::text, '-', ''), 'hq', v_prev, hq.order_json(r.id), 'bowl color required');
      v_orders := v_orders || jsonb_build_object('order_id', r.id, 'customer', r.customer);
    end loop;

    -- ---------- 5. retire the no-color bowl (refuses if it has stock or is still on an open line) ----------
    if not (select archived from hq.variants where id = v_var) then perform hq.archive_variant(v_notion); end if;
  end if;

  -- ---------- 4. wording that meant a bowl with no color ----------
  with gone as (
    delete from hq.line_aliases a
     where a.variant_id in (select v.id from hq.variants v where v.product_id = 'bowl-feeder')
       and (a.variant_id = v_var or cardinality(hq.text_colors(regexp_replace(a.sample_text, '\(matte\)', ' Matte', 'gi'))) = 0)
    returning a.alias_key, a.sample_text, a.variant_id)
  select coalesce(jsonb_agg(to_jsonb(gone)), '[]') into v_forgot from gone;

  update hq.color_schemes set archived = true where id = 'shop-choice' and not archived;
  update hq.colors set archived = true where id = 'shop-choice' and not archived;

  insert into hq.app_log (op_id, kind, data, by_user)
  values ('bowl-color-required-20261125', 'product_color_required',
          jsonb_build_object('product_id', 'bowl-feeder', 'retired_variant', v_var, 'orders_asked_for_a_color', v_orders, 'wording_forgotten', v_forgot),
          'Frankie via Claude')
  on conflict do nothing;
end $mig$;
