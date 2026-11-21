-- Feed intake: read an Etsy "You made a sale" email or a Shopify order into hq.source_orders (Nov 20, 2026).
--
-- Why: hq.source_orders, ingest_source, the "sales not entered" box and the Review pill have existed since Nov 5,
-- but nothing fed them. A person (or a Claude session) had to turn each email into the items list by hand.
-- These functions do that part the same way every time, in the database:
--   hq.parse_etsy_sale(subject, body, received)  -> the sale as fields. Reads only; never guesses.
--   hq.ingest_etsy_email(message_id, subject, body, received) -> parse, then ingest_source, then log.
--   hq.ingest_shopify_order(order as the Admin API returns it) -> same for a site order.
-- Whatever moves the emails and orders here (a scheduled reader today) only carries text. It decides nothing.
--
-- Rules kept from Nov 5: nothing is interpreted at write time, (platform, number) is unique so reading the same sale
-- twice changes nothing, no order is ever created here, and an order that gets linked is flagged for Review.
-- New: the shipping method the buyer paid for (Express) and anything the parser could not account for are kept on
-- the source row (shipping, problems). A message that is not a readable sale is refused and logged, never half-saved.

alter table hq.source_orders add column if not exists shipping text;
alter table hq.source_orders add column if not exists problems jsonb not null default '[]'::jsonb;

create or replace function hq.parse_etsy_sale(p_subject text, p_body text, p_received timestamptz)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_body text := replace(coalesce(p_body, ''), E'\r', '');
  v_lines text[];
  v_line text;
  v_state text := '';
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_m text[];
  v_note text;
  v_handle text;
  v_num_s text := (regexp_match(coalesce(p_subject, ''), 'Order #(\d+)'))[1];
  v_num_b text;
  v_total_s numeric := replace((regexp_match(coalesce(p_subject, ''), '\[\$([\d,]+\.\d\d)'))[1], ',', '')::numeric;
  v_total_b numeric;
  v_name text;
  v_st text;
  v_email text;
  v_shipping text;
  v_ship_by date;
  v_day date := (coalesce(p_received, now()) at time zone 'America/Chicago')::date;
  v_count text;
  v_qty integer;
  v_problems jsonb := '[]'::jsonb;
  v_last integer;
begin
  v_lines := regexp_split_to_array(v_body, E'\n');
  v_num_b := coalesce((regexp_match(v_body, 'etsy\.com/your/orders/(\d+)'))[1], (regexp_match(v_body, 'order number is:?\s*(\d+)', 'i'))[1]);

  foreach v_line in array v_lines loop
    v_line := regexp_replace(v_line, '^\s+|\s+$', '', 'g');

    if v_state = 'note_head' then
      if v_line ~ '^-{5,}$' then v_state := 'note'; end if;
      continue;
    elsif v_state = 'note' then
      if v_line ~ '^-{5,}$' then v_state := ''; continue; end if;
      if v_line <> '' or v_note is not null then v_note := coalesce(v_note || E'\n', '') || v_line; end if;
      continue;
    end if;

    if v_line ~ '^Note from .*:$' then
      v_handle := coalesce(v_handle, nullif((regexp_match(v_line, '^Note from (.*):$'))[1], ''));
      v_state := 'note_head';
      continue;
    end if;

    if v_line ~ '^Transaction ID:' then
      if v_item is not null then v_items := v_items || jsonb_build_array(v_item); end if;
      v_item := jsonb_build_object('transaction_id', (regexp_match(v_line, '(\d+)'))[1], 'variations', '[]'::jsonb);
      v_state := 'item';
      continue;
    end if;

    if v_state = 'item' then
      if v_line = '' then continue; end if;
      if v_line ~ '^-{5,}$' then
        v_items := v_items || jsonb_build_array(v_item); v_item := null; v_state := '';
        continue;
      end if;
      if v_line ~ '^Item:' then
        v_item := v_item || jsonb_build_object('title', regexp_replace(v_line, '^Item:\s*', ''));
      elsif v_line ~ '^Quantity:\s*\d+$' then
        v_item := v_item || jsonb_build_object('qty', (regexp_match(v_line, '(\d+)'))[1]::integer);
      elsif v_line ~ '^Item price:' then
        v_item := v_item || jsonb_build_object('price', replace((regexp_match(v_line, '\$([\d,]+\.\d\d)'))[1], ',', '')::numeric);
        v_items := v_items || jsonb_build_array(v_item); v_item := null; v_state := '';
      else
        v_m := regexp_match(v_line, '^([^:]{1,80}):\s*(.*)$');
        if v_m is not null and v_m[1] ~* '^personali[sz]ation$' then
          v_item := v_item || jsonb_build_object('personalization', v_m[2]);
        elsif v_m is not null then
          v_item := jsonb_set(v_item, '{variations}', (v_item -> 'variations') || jsonb_build_array(jsonb_build_array(v_m[1], v_m[2])));
        elsif v_item ? 'personalization' then
          -- a personalization the buyer typed over several lines
          v_item := v_item || jsonb_build_object('personalization', (v_item ->> 'personalization') || E'\n' || v_line);
        elsif jsonb_array_length(v_item -> 'variations') > 0 then
          -- a value that ran onto a second line stays with its field
          v_last := jsonb_array_length(v_item -> 'variations') - 1;
          v_item := jsonb_set(v_item, array['variations', v_last::text, '1'], to_jsonb((v_item -> 'variations' -> v_last ->> 1) || ' ' || v_line));
        else
          v_problems := v_problems || to_jsonb('unread line in item: ' || left(v_line, 80));
        end if;
      end if;
      continue;
    end if;
  end loop;
  if v_item is not null then v_items := v_items || jsonb_build_array(v_item); end if;

  v_handle := coalesce(v_handle, (regexp_match(v_body, '(?:^|\n)\s*Buyer:\s*(\S+)'))[1]);
  v_name := (regexp_match(v_body, 'class=''name''>([^<]*)<'))[1];
  v_st := (regexp_match(v_body, 'class=''state''>([^<]*)<'))[1];
  v_name := nullif(btrim(replace(replace(replace(coalesce(v_name, ''), '&amp;', '&'), '&#39;', ''''), '&quot;', '"')), '');
  v_email := (regexp_match(v_body, '\* Email (\S+@\S+)'))[1];
  v_shipping := nullif(btrim((regexp_match(v_body, 'Shipping:\s*\$[\d,\.]+\s*\(([^)]*)\)'))[1]), '');
  v_total_b := replace((regexp_match(v_body, 'Order Total:\s*\$([\d,]+\.\d\d)'))[1], ',', '')::numeric;
  v_note := nullif(btrim(coalesce(v_note, ''), E' \n\t'), '');
  if v_note ~* '^the buyer did not leave a note\.?$' then v_note := null; end if;

  v_m := regexp_match(coalesce(p_subject, ''), 'Ship by ([A-Za-z]{3})[a-z]* (\d{1,2})');
  if v_m is not null then
    v_ship_by := to_date(v_m[1] || ' ' || v_m[2] || ' ' || extract(year from v_day)::int, 'Mon DD YYYY');
    if v_ship_by < v_day - 60 then v_ship_by := (v_ship_by + interval '1 year')::date; end if;
  end if;

  -- what the parser could not account for is said, not smoothed over
  if coalesce(p_subject, '') !~ '^You made a sale on Etsy' then v_problems := v_problems || to_jsonb('not a sale email'::text); end if;
  if coalesce(v_num_s, v_num_b) is null then v_problems := v_problems || to_jsonb('no order number'::text); end if;
  if v_num_s is not null and v_num_b is not null and v_num_s <> v_num_b then v_problems := v_problems || to_jsonb('order number differs between subject and body'::text); end if;
  if jsonb_array_length(v_items) = 0 then v_problems := v_problems || to_jsonb('no items found'::text); end if;
  if exists (select 1 from jsonb_array_elements(v_items) e where coalesce(e ->> 'title', '') = '' or (e ->> 'qty') is null) then
    v_problems := v_problems || to_jsonb('an item has no title or quantity'::text);
  end if;
  if v_total_s is not null and v_total_b is not null and v_total_s <> v_total_b then v_problems := v_problems || to_jsonb('total differs between subject and body'::text); end if;
  if v_name is null then v_problems := v_problems || to_jsonb('no ship-to name'::text); end if;
  v_count := (regexp_match(v_body, '(?:sale of|order for) (\d+) items?'))[1];
  select coalesce(sum((e ->> 'qty')::integer), 0) into v_qty from jsonb_array_elements(v_items) e;
  if v_count is not null and v_count::integer <> v_qty then
    v_problems := v_problems || to_jsonb(format('email says %s items, %s read', v_count, v_qty));
  end if;

  return jsonb_build_object(
    'platform', 'Etsy', 'number', coalesce(v_num_s, v_num_b), 'buyer', v_name, 'buyer_handle', v_handle, 'buyer_email', v_email,
    'state', v_st, 'order_date', v_day, 'ship_by', v_ship_by, 'total', coalesce(v_total_b, v_total_s), 'note', v_note,
    'items', v_items, 'shipping', v_shipping, 'problems', v_problems);
end
$fn$;

create or replace function hq.ingest_etsy_email(p_message_id text, p_subject text, p_body text, p_received timestamptz, p_by text default 'feed')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, hq, pg_temp
as $fn$
declare
  v jsonb := hq.parse_etsy_sale(p_subject, p_body, p_received);
  r jsonb;
begin
  if (v ->> 'number') is null or jsonb_array_length(v -> 'items') = 0 or (v -> 'problems') @> '["not a sale email"]'::jsonb then
    insert into hq.app_log (op_id, kind, data, by_user)
    values ('ingest-etsy-' || coalesce(p_message_id, 'none') || '-' || extract(epoch from clock_timestamp())::bigint, 'source_unreadable',
            jsonb_build_object('platform', 'Etsy', 'message_id', p_message_id, 'subject', p_subject, 'problems', v -> 'problems'), p_by);
    return jsonb_build_object('ok', false, 'message_id', p_message_id, 'problems', v -> 'problems');
  end if;
  r := hq.ingest_source((v - 'shipping' - 'problems') || jsonb_build_object('raw', p_body, 'message_id', p_message_id), p_by);
  update hq.source_orders set shipping = coalesce(v ->> 'shipping', shipping), problems = v -> 'problems' where id = (r ->> 'source_id')::bigint;
  if (r ->> 'new')::boolean or jsonb_array_length(v -> 'problems') > 0 then
    insert into hq.app_log (op_id, kind, data, by_user)
    values ('ingest-etsy-' || (v ->> 'number') || '-' || extract(epoch from clock_timestamp())::bigint, 'source_ingested',
            r || jsonb_build_object('platform', 'Etsy', 'number', v ->> 'number', 'items', jsonb_array_length(v -> 'items'), 'problems', v -> 'problems'), p_by);
  end if;
  return r || jsonb_build_object('ok', true, 'platform', 'Etsy', 'number', v ->> 'number', 'buyer', v ->> 'buyer', 'items', jsonb_array_length(v -> 'items'), 'problems', v -> 'problems');
end
$fn$;

-- p: one order node from the Shopify Admin API:
-- {id, name, createdAt, cancelledAt, displayFulfillmentStatus, note, email, customer{displayName}, shippingAddress{name, provinceCode},
--  shippingLine{title}, currentTotalPriceSet{shopMoney{amount}}, lineItems{nodes[{title, quantity, currentQuantity, variantTitle, customAttributes[{key, value}]}]}}
create or replace function hq.ingest_shopify_order(p jsonb, p_by text default 'feed')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, hq, pg_temp
as $fn$
declare
  v_num text := nullif(regexp_replace(coalesce(p ->> 'name', ''), '^#', ''), '');
  v_known boolean;
  v_items jsonb;
  v_buyer text := coalesce(nullif(btrim(p #>> '{customer,displayName}'), ''), nullif(btrim(p #>> '{shippingAddress,name}'), ''));
  v_problems jsonb := '[]'::jsonb;
  v jsonb;
  r jsonb;
begin
  if v_num is null then raise exception 'ingest_shopify_order: the order has no name'; end if;
  select exists (select 1 from hq.source_orders where platform = 'Shopify' and number = v_num) into v_known;
  -- only sales that still need work are wanted: a cancelled or already shipped order that was never read in is left out
  if not v_known and (p ->> 'cancelledAt') is not null then return jsonb_build_object('ok', true, 'number', v_num, 'skipped', 'cancelled'); end if;
  if not v_known and (p ->> 'displayFulfillmentStatus') = 'FULFILLED' then return jsonb_build_object('ok', true, 'number', v_num, 'skipped', 'already shipped'); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'title', li ->> 'title',
           'qty', coalesce((li ->> 'currentQuantity')::integer, (li ->> 'quantity')::integer),
           'variations',
             (case when coalesce(li ->> 'variantTitle', '') in ('', 'Default Title') then '[]'::jsonb
                   else jsonb_build_array(jsonb_build_array('Variant', li ->> 'variantTitle')) end)
             || coalesce((select jsonb_agg(jsonb_build_array(a ->> 'key', a ->> 'value')) from jsonb_array_elements(coalesce(li -> 'customAttributes', '[]'::jsonb)) a
                          where coalesce(a ->> 'key', '') !~ '^_'), '[]'::jsonb)
         ) order by ord), '[]'::jsonb)
    into v_items
  from jsonb_array_elements(coalesce(p #> '{lineItems,nodes}', '[]'::jsonb)) with ordinality as t(li, ord)
  where coalesce((li ->> 'currentQuantity')::integer, (li ->> 'quantity')::integer, 0) > 0;

  if jsonb_array_length(v_items) = 0 then v_problems := v_problems || to_jsonb('no items found'::text); end if;
  if v_buyer is null then v_problems := v_problems || to_jsonb('no buyer name'::text); end if;
  if (p ->> 'cancelledAt') is not null then v_problems := v_problems || to_jsonb('cancelled on Shopify'::text); end if;

  v := jsonb_build_object(
    'platform', 'Shopify', 'number', v_num, 'buyer', v_buyer, 'buyer_email', p ->> 'email', 'state', p #>> '{shippingAddress,provinceCode}',
    'order_date', ((p ->> 'createdAt')::timestamptz at time zone 'America/Chicago')::date,
    'total', p #>> '{currentTotalPriceSet,shopMoney,amount}', 'note', p ->> 'note', 'items', v_items, 'raw', p::text, 'message_id', p ->> 'id');
  r := hq.ingest_source(v, p_by);
  update hq.source_orders set shipping = coalesce(nullif(btrim(p #>> '{shippingLine,title}'), ''), shipping), problems = v_problems where id = (r ->> 'source_id')::bigint;
  if (r ->> 'new')::boolean or jsonb_array_length(v_problems) > 0 then
    insert into hq.app_log (op_id, kind, data, by_user)
    values ('ingest-shopify-' || v_num || '-' || extract(epoch from clock_timestamp())::bigint, 'source_ingested',
            r || jsonb_build_object('platform', 'Shopify', 'number', v_num, 'items', jsonb_array_length(v_items), 'problems', v_problems), p_by);
  end if;
  return r || jsonb_build_object('ok', true, 'platform', 'Shopify', 'number', v_num, 'buyer', v_buyer, 'items', jsonb_array_length(v_items), 'problems', v_problems);
end
$fn$;

-- the Bin View box and the order form can show the paid shipping method and any parse problem
create or replace function hq.unlinked_sources()
returns jsonb language sql stable security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'platform', s.platform, 'number', s.number, 'buyer', s.buyer, 'order_date', s.order_date, 'ship_by', s.ship_by,
                                               'note', s.note, 'items', s.items, 'shipping', s.shipping, 'problems', s.problems) order by s.order_date, s.id), '[]'::jsonb)
  from hq.source_orders s where s.order_id is null and s.dismissed_at is null
$$;

revoke all on function hq.parse_etsy_sale(text, text, timestamptz) from public;
revoke all on function hq.parse_etsy_sale(text, text, timestamptz) from anon;
grant execute on function hq.parse_etsy_sale(text, text, timestamptz) to authenticated, service_role;
revoke all on function hq.ingest_etsy_email(text, text, text, timestamptz, text) from public;
revoke all on function hq.ingest_etsy_email(text, text, text, timestamptz, text) from anon, authenticated;
grant execute on function hq.ingest_etsy_email(text, text, text, timestamptz, text) to service_role;
revoke all on function hq.ingest_shopify_order(jsonb, text) from public;
revoke all on function hq.ingest_shopify_order(jsonb, text) from anon, authenticated;
grant execute on function hq.ingest_shopify_order(jsonb, text) to service_role;
