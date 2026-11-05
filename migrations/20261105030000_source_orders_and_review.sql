-- Nov 5, 2026 — sales as the platform reported them, linked to orders; imported orders carry a Review flag.
--
-- Why: orders enter Spood Production typed by a person from the Etsy/TikTok/Shopify order page. Nothing could say
-- whether a sale was entered at all (4 of the last 6 Etsy sales weren't), whether the quantity matched (Kristina's
-- 2 x Black Bat Ledges came in as 1), or whether an add-on was dropped (Carley's silk hide). The Etsy "You made a
-- sale" email and the Shopify order carry every variation the customer chose, as fields.
--
-- Rules:
--   1. hq.source_orders is one row per sale as the platform said it: buyer, dates, note, items with every variation.
--      Nothing is interpreted at write time. (platform, number) is unique; re-ingesting the same sale changes nothing.
--   2. A source is linked to one order (source_orders.order_id). ingest_source links by platform order number, else
--      by buyer name + order date when exactly one open-or-recent order matches; otherwise it stays unlinked and
--      Bin View's status line says "N sales not entered" with the names. Nothing is created automatically.
--   3. An order that came from a source (linked while open, or created from one later) gets orders.review = 'pending'
--      and shows a Review pill with the source's items beside its lines until a person taps Confirmed
--      (hq.confirm_review). Hand-entered orders (TikTok LIVE, in person) are normal and carry no flag.
--   4. Done orders linked during the backfill are not flagged; the backfill is a record, not a to-do.

create table if not exists hq.source_orders (
  id           bigserial primary key,
  platform     text not null,
  number       text not null,
  buyer        text,
  buyer_handle text,
  buyer_email  text,
  state        text,
  order_date   date,
  ship_by      date,
  total        numeric,
  note         text,
  items        jsonb not null default '[]'::jsonb,   -- [{title, qty, variations: [[name, value], …], personalization, transaction_id, price}]
  raw          text,
  message_id   text,
  received_at  timestamptz not null default now(),
  order_id     text references hq.orders(id),
  linked_at    timestamptz,
  linked_by    text,
  dismissed_at timestamptz,
  dismissed_by text,
  dismiss_why  text,
  unique (platform, number)
);
create index if not exists source_orders_order_id on hq.source_orders(order_id);
alter table hq.source_orders enable row level security;

alter table hq.orders add column if not exists review text;        -- 'pending' | null
alter table hq.orders add column if not exists review_by text;
alter table hq.orders add column if not exists review_at timestamptz;

-- the one order a source belongs to, by number, else by buyer name + date (unique match only). null when unsure.
create or replace function hq.source_match(p_platform text, p_number text, p_buyer text, p_date date)
returns text language plpgsql stable set search_path to '' as $$
declare v_id text; n integer; k1 text; r record; cands text[] := '{}';
begin
  select id into v_id from hq.orders where deleted_at is null and order_number = p_number and p_platform = any(platform) limit 1;
  if v_id is not null then return v_id; end if;
  if p_buyer is null or p_date is null then return null; end if;
  k1 := hq.name_key(p_buyer);
  for r in select o.id, hq.name_key(replace(o.customer, '*', '')) k from hq.orders o
           where o.deleted_at is null and p_platform = any(o.platform) and o.order_date between p_date - 4 and p_date + 4
             and not exists (select 1 from hq.source_orders s where s.order_id = o.id)
  loop
    if r.k = k1 or r.k like k1 || '-%' or k1 like r.k || '-%'
       or (split_part(r.k, '-', 1) = split_part(k1, '-', 1) and regexp_replace(r.k, '^.*-', '') = regexp_replace(k1, '^.*-', ''))
    then cands := cands || r.id; end if;
  end loop;
  if cardinality(cands) = 1 then return cands[1]; end if;
  return null;
end $$;

-- link a source to an order; the order is flagged for review unless it is Done
create or replace function hq.link_source(p_source_id bigint, p_order_id text, p_by text default null)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $$
declare s hq.source_orders; o hq.orders;
begin
  select * into s from hq.source_orders where id = p_source_id for update;
  if s.id is null then raise exception 'source % not found', p_source_id; end if;
  select * into o from hq.orders where id = lower(p_order_id) and deleted_at is null for update;
  if o.id is null then raise exception 'This order no longer exists'; end if;
  if exists (select 1 from hq.source_orders x where x.order_id = o.id and x.id <> s.id and x.platform = s.platform) then
    raise exception 'Order % is already linked to another % sale', o.customer, s.platform;
  end if;
  update hq.source_orders set order_id = o.id, linked_at = now(), linked_by = p_by, dismissed_at = null, dismissed_by = null, dismiss_why = null where id = s.id;
  update hq.orders set order_number = coalesce(order_number, s.number),
                       review = case when status = 'Done' then review else 'pending' end,
                       version = version + 1
   where id = o.id;
  insert into hq.app_log (op_id, kind, at, data, by_user)
  values ('link-' || s.id || '-' || extract(epoch from now())::bigint, 'source_link', now(), jsonb_build_object('source_id', s.id, 'platform', s.platform, 'number', s.number, 'order_id', o.id), p_by);
  return jsonb_build_object('source_id', s.id, 'order_id', o.id, 'review', (select review from hq.orders where id = o.id));
end $$;

-- one sale as the platform reported it. Upsert by (platform, number); auto-links when the order is unambiguous.
-- p: {platform, number, buyer, buyer_handle, buyer_email, state, order_date, ship_by, total, note, items, raw, message_id}
create or replace function hq.ingest_source(p jsonb, p_by text default null)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $$
declare v_plat text := trim(p->>'platform'); v_num text := trim(p->>'number'); s hq.source_orders; v_new boolean; v_match text;
begin
  if coalesce(v_plat, '') = '' or coalesce(v_num, '') = '' then raise exception 'ingest_source: platform and number are required'; end if;
  if jsonb_typeof(coalesce(p->'items', '[]'::jsonb)) <> 'array' then raise exception 'ingest_source: items must be a list'; end if;
  select * into s from hq.source_orders where platform = v_plat and number = v_num for update;
  v_new := s.id is null;
  insert into hq.source_orders as t (platform, number, buyer, buyer_handle, buyer_email, state, order_date, ship_by, total, note, items, raw, message_id)
  values (v_plat, v_num, nullif(trim(p->>'buyer'), ''), nullif(trim(p->>'buyer_handle'), ''), nullif(trim(p->>'buyer_email'), ''), nullif(trim(p->>'state'), ''),
          nullif(p->>'order_date', '')::date, nullif(p->>'ship_by', '')::date, nullif(p->>'total', '')::numeric, nullif(trim(p->>'note'), ''),
          coalesce(p->'items', '[]'::jsonb), p->>'raw', p->>'message_id')
  on conflict (platform, number) do update set
    buyer = coalesce(excluded.buyer, t.buyer), buyer_handle = coalesce(excluded.buyer_handle, t.buyer_handle), buyer_email = coalesce(excluded.buyer_email, t.buyer_email),
    state = coalesce(excluded.state, t.state), order_date = coalesce(excluded.order_date, t.order_date), ship_by = coalesce(excluded.ship_by, t.ship_by),
    total = coalesce(excluded.total, t.total), note = coalesce(excluded.note, t.note),
    items = case when jsonb_array_length(excluded.items) > 0 then excluded.items else t.items end,
    raw = coalesce(excluded.raw, t.raw), message_id = coalesce(excluded.message_id, t.message_id)
  returning * into s;
  if s.order_id is null and s.dismissed_at is null then
    v_match := hq.source_match(s.platform, s.number, s.buyer, s.order_date);
    if v_match is not null then perform hq.link_source(s.id, v_match, coalesce(p_by, 'auto')); select * into s from hq.source_orders where id = s.id; end if;
  end if;
  return jsonb_build_object('source_id', s.id, 'new', v_new, 'order_id', s.order_id, 'linked', s.order_id is not null);
end $$;

create or replace function hq.confirm_review(p_order_id text, p_by text default null)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $$
declare o hq.orders;
begin
  select * into o from hq.orders where id = lower(p_order_id) and deleted_at is null for update;
  if o.id is null then raise exception 'This order no longer exists'; end if;
  update hq.orders set review = null, review_by = p_by, review_at = now(), version = version + 1 where id = o.id;
  insert into hq.app_log (op_id, kind, at, data, by_user)
  values ('review-' || o.id || '-' || extract(epoch from now())::bigint, 'review_confirmed', now(), jsonb_build_object('order_id', o.id, 'customer', o.customer), p_by);
  return jsonb_build_object('id', o.id, 'version', o.version + 1);
end $$;

create or replace function hq.dismiss_source(p_source_id bigint, p_why text, p_by text default null)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $$
begin
  if coalesce(trim(p_why), '') = '' then raise exception 'Say why this sale needs no order'; end if;
  update hq.source_orders set dismissed_at = now(), dismissed_by = p_by, dismiss_why = trim(p_why) where id = p_source_id and order_id is null;
  if not found then raise exception 'source % not found or already linked', p_source_id; end if;
  insert into hq.app_log (op_id, kind, at, data, by_user)
  values ('dismiss-' || p_source_id || '-' || extract(epoch from now())::bigint, 'source_dismissed', now(), jsonb_build_object('source_id', p_source_id, 'why', trim(p_why)), p_by);
  return jsonb_build_object('source_id', p_source_id, 'dismissed', true);
end $$;

-- sales with no order yet (what Bin View's status line shows)
create or replace function hq.unlinked_sources()
returns jsonb language sql stable security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'platform', s.platform, 'number', s.number, 'buyer', s.buyer, 'order_date', s.order_date, 'ship_by', s.ship_by, 'note', s.note, 'items', s.items) order by s.order_date, s.id), '[]'::jsonb)
  from hq.source_orders s where s.order_id is null and s.dismissed_at is null
$$;

-- order_json carries the source (platform, number, items, note) so the card can show it beside the lines
create or replace function hq.order_json(p_id text, p_alloc jsonb default null)
returns jsonb language sql stable set search_path to '' as $$
  select to_jsonb(o) || jsonb_build_object('lines', coalesce((
           select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'text', l.text, 'note', l.note, 'qty', l.qty, 'match', l.match, 'tag', l.tag, 'size_1', l.size_1, 'size_2', l.size_2, 'size_3', l.size_3, 'size_unit', l.size_unit, 'size_basis', l.size_basis,
                    'conflict', l.conflict,
                    'variant_id', l.variant_id, 'sku', v.sku, 'notion_inventory_id', v.notion_inventory_id,
                    'uid', l.uid, 'group_uid', l.group_uid, 'print_state', l.print_state, 'print_at', l.print_at, 'print_src', l.print_src,
                    'packed', l.packed, 'packed_at', l.packed_at, 'packed_from', l.packed_from, 'state_by', l.state_by,
                    'kind', coalesce(p_alloc->(l.uid::text)->>'kind', hq.line_kind(l.text, l.match, v.product_id, p.category)),
                    'alloc', coalesce((p_alloc->(l.uid::text)->>'alloc')::integer, 0)) order by l.line_no)
           from hq.order_lines l left join hq.variants v on v.id = l.variant_id left join hq.products p on p.id = v.product_id
           where l.order_id = o.id), '[]'::jsonb))
       || jsonb_build_object('sources', coalesce((
           select jsonb_agg(jsonb_build_object('id', s.id, 'platform', s.platform, 'number', s.number, 'buyer', s.buyer, 'note', s.note, 'items', s.items, 'ship_by', s.ship_by) order by s.id)
           from hq.source_orders s where s.order_id = o.id), '[]'::jsonb))
       || coalesce((
           select jsonb_build_object('done_at', h.at, 'done_by', h.by_user, 'done_prev', h.before->>'status')
           from hq.order_history h
           where o.status = 'Done' and h.order_id = o.id and h.source = 'hq'
             and h.after->>'status' = 'Done' and coalesce(h.before->>'status', '') <> 'Done'
           order by h.at desc limit 1), '{}'::jsonb)
  from hq.orders o where o.id = p_id
$$;

grant execute on function hq.ingest_source(jsonb, text), hq.link_source(bigint, text, text), hq.confirm_review(text, text), hq.dismiss_source(bigint, text, text), hq.unlinked_sources() to authenticated;
