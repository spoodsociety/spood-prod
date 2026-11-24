-- Listing recipes, learned case by case (Frankie, Nov 24 2026).
-- A sale read in from Etsy or Shopify is one or more listing items. When a person enters the order from the sale,
-- what they entered for each item is kept as a case. When the same listing with the same options has been entered
-- the same way three times in a row, that is offered as a recipe. An owner confirms it once; from then on the sale
-- opens the order form already filled in. A confirmed recipe that a person corrects goes back for review.
-- Applied to the test copy (ibjgaqpzlkcjcuhyedhg) first. NOT YET APPLIED TO LIVE.

create or replace function hq.recipe_threshold() returns int language sql immutable as $$ select 3 $$;

-- one listing with one set of options: platform | title | option=value ; option=value (case and spacing ignored, options sorted)
create or replace function hq.listing_key(p_platform text, p_item jsonb) returns text
language sql immutable set search_path to 'pg_catalog', 'hq', 'pg_temp' as $$
  select lower(trim(p_platform)) || ' | ' || lower(regexp_replace(trim(coalesce(p_item->>'title', '')), '\s+', ' ', 'g')) || ' | ' ||
         coalesce((select string_agg(lower(trim(v->>0)) || '=' || lower(regexp_replace(trim(v->>1), '\s+', ' ', 'g')), ' ; '
                                     order by lower(trim(v->>0)), lower(trim(v->>1)))
                     from jsonb_array_elements(case when jsonb_typeof(p_item->'variations') = 'array' then p_item->'variations' else '[]'::jsonb end) v), '')
$$;

-- the pieces of a case in one comparable form (order of lines ignored)
create or replace function hq.lines_key(p_lines jsonb) returns text
language sql immutable set search_path to 'pg_catalog', 'hq', 'pg_temp' as $$
  select coalesce(string_agg(k, ' + ' order by k), '') from (
    select coalesce('v' || (l->>'variant_id'), 't:' || lower(trim(l->>'text'))) || ' x' || (l->>'qty') || case when coalesce(l->>'tag', '') <> '' then ' #' || (l->>'tag') else '' end k
      from jsonb_array_elements(p_lines) l) t
$$;

create table hq.listing_cases (
  id bigint generated always as identity primary key,
  source_id bigint not null references hq.source_orders(id) on delete cascade,
  item_no int not null,
  case_key text not null,
  lines jsonb not null,
  lines_key text not null,
  order_id text,
  by_user text,
  at timestamptz not null default now(),
  unique (source_id, item_no)
);
create index listing_cases_key on hq.listing_cases (case_key, at desc);

create table hq.listing_recipes (
  case_key text primary key,
  platform text not null,
  title text not null,
  variations jsonb not null default '[]'::jsonb,
  lines jsonb not null,
  lines_key text not null,
  status text not null check (status in ('offered', 'confirmed', 'declined', 'review')),
  offered_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text
);
alter table hq.listing_cases enable row level security;
alter table hq.listing_recipes enable row level security;
revoke all on hq.listing_cases, hq.listing_recipes from public, anon, authenticated;

-- p_items: [{item_no, lines: [{variant_id | text + untracked, qty, tag, size_1}]}], the lines a person saved for each item of the sale
create or replace function hq.record_cases(p_source_id bigint, p_order_id text, p_items jsonb, p_by text default null) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
declare s hq.source_orders; it jsonb; src jsonb; l jsonb; r hq.listing_recipes; v_no int; v_qty int; v_lines jsonb; v_key text; v_lkey text; v_skip text;
        v_n int; v_kinds int; v_top text; v_did text; v_out jsonb := '[]'::jsonb;
begin
  select * into s from hq.source_orders where id = p_source_id;
  if s.id is null then raise exception 'record_cases: sale % not found', p_source_id; end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'record_cases: items must be a list'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_no := (it->>'item_no')::int; src := s.items -> v_no; v_skip := null; v_did := 'kept'; v_lines := '[]'::jsonb;
    if src is null then raise exception 'record_cases: the sale has no item %', v_no; end if;
    v_qty := greatest(coalesce(nullif(src->>'qty', '')::int, 1), 1);
    if coalesce(trim(src->>'personalization'), '') <> '' then v_skip := 'personalized';
    elsif jsonb_typeof(it->'lines') is distinct from 'array' or jsonb_array_length(it->'lines') = 0 then v_skip := 'no lines';
    else
      for l in select * from jsonb_array_elements(it->'lines') loop
        if l->>'size_1' is not null then v_skip := 'custom size'; exit; end if;
        if l->>'variant_id' is null and not coalesce((l->>'untracked')::boolean, false) then v_skip := 'line not in the catalog'; exit; end if;
        if l->>'variant_id' is null and coalesce(trim(l->>'text'), '') = '' then v_skip := 'line has no text'; exit; end if;
        if l->>'variant_id' is not null and not exists (select 1 from hq.variants v where v.id = (l->>'variant_id')::bigint and not v.archived) then v_skip := 'unknown variation'; exit; end if;
        if coalesce((l->>'qty')::int, 0) < 1 or ((l->>'qty')::int % v_qty) <> 0 then v_skip := 'quantity does not divide'; exit; end if;
        v_lines := v_lines || jsonb_strip_nulls(jsonb_build_object('variant_id', (l->>'variant_id')::bigint,
                     'text', case when l->>'variant_id' is null then trim(l->>'text') end, 'qty', (l->>'qty')::int / v_qty, 'tag', nullif(l->>'tag', '')));
      end loop;
    end if;
    if v_skip is not null then
      delete from hq.listing_cases where source_id = s.id and item_no = v_no;
      v_out := v_out || jsonb_build_object('item_no', v_no, 'skipped', v_skip); continue;
    end if;
    v_key := hq.listing_key(s.platform, src); v_lkey := hq.lines_key(v_lines);
    insert into hq.listing_cases as c (source_id, item_no, case_key, lines, lines_key, order_id, by_user)
    values (s.id, v_no, v_key, v_lines, v_lkey, lower(p_order_id), p_by)
    on conflict (source_id, item_no) do update set case_key = excluded.case_key, lines = excluded.lines, lines_key = excluded.lines_key, order_id = excluded.order_id, by_user = excluded.by_user, at = now();
    select * into r from hq.listing_recipes where case_key = v_key for update;
    if r.case_key is not null and r.status = 'confirmed' then
      if r.lines_key <> v_lkey then
        update hq.listing_recipes set status = 'review', offered_at = now() where case_key = v_key; v_did := 'review';
        insert into hq.app_log (op_id, kind, at, data, by_user)
        values ('recipe-' || md5(v_key) || '-' || replace(gen_random_uuid()::text, '-', ''), 'recipe_corrected', now(),
                jsonb_build_object('case_key', v_key, 'recipe', r.lines, 'entered', v_lines, 'source_id', s.id, 'order_id', lower(p_order_id)), p_by);
      end if;
    else
      select count(*), count(distinct t.lines_key), min(t.lines_key) into v_n, v_kinds, v_top
        from (select c.lines_key from hq.listing_cases c where c.case_key = v_key order by c.at desc, c.id desc limit hq.recipe_threshold()) t;
      if v_n >= hq.recipe_threshold() and v_kinds = 1
         and not (r.case_key is not null and r.lines_key = v_top and r.status in ('offered', 'declined')) then
        insert into hq.listing_recipes as x (case_key, platform, title, variations, lines, lines_key, status)
        values (v_key, s.platform, src->>'title', case when jsonb_typeof(src->'variations') = 'array' then src->'variations' else '[]'::jsonb end, v_lines, v_lkey, 'offered')
        on conflict (case_key) do update set lines = excluded.lines, lines_key = excluded.lines_key, variations = excluded.variations, title = excluded.title,
                                             status = 'offered', offered_at = now(), decided_at = null, decided_by = null;
        v_did := 'offered';
        insert into hq.app_log (op_id, kind, at, data, by_user)
        values ('recipe-' || md5(v_key) || '-' || replace(gen_random_uuid()::text, '-', ''), 'recipe_offered', now(), jsonb_build_object('case_key', v_key, 'lines', v_lines), p_by);
      end if;
    end if;
    v_out := v_out || jsonb_build_object('item_no', v_no, 'case_key', v_key, 'recipe', v_did);
  end loop;
  return jsonb_build_object('source_id', s.id, 'items', v_out);
end $function$;

-- an owner's answer to an offered recipe (or one sent back for review): confirm or decline
create or replace function hq.decide_recipe(p_key text, p_decision text, p_by text default null) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
declare r hq.listing_recipes; v_to text;
begin
  if p_decision not in ('confirm', 'decline') then raise exception 'decide_recipe: confirm or decline'; end if;
  select * into r from hq.listing_recipes where case_key = p_key for update;
  if r.case_key is null then raise exception 'This recipe no longer exists'; end if;
  if r.status not in ('offered', 'review') then raise exception 'This recipe was already answered'; end if;
  v_to := case p_decision when 'confirm' then 'confirmed' else 'declined' end;
  update hq.listing_recipes set status = v_to, decided_at = now(), decided_by = p_by where case_key = p_key;
  insert into hq.app_log (op_id, kind, at, data, by_user)
  values ('recipe-' || md5(p_key) || '-' || replace(gen_random_uuid()::text, '-', ''), 'recipe_' || v_to, now(), jsonb_build_object('case_key', p_key, 'lines', r.lines, 'was', r.status), p_by);
  return jsonb_build_object('case_key', p_key, 'status', v_to);
end $function$;

-- recipes waiting for an owner (offered, or sent back for review), with each line's catalog name
create or replace function hq.read_recipes() returns jsonb
language sql stable security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
  select coalesce(jsonb_agg(jsonb_build_object('key', r.case_key, 'platform', r.platform, 'title', r.title, 'variations', r.variations, 'status', r.status,
           'cases', (select count(*) from hq.listing_cases c where c.case_key = r.case_key),
           'lines', (select jsonb_agg(l.x || jsonb_build_object('name', coalesce(v.inventory_name, l.x->>'text')) order by l.n)
                       from jsonb_array_elements(r.lines) with ordinality l(x, n) left join hq.variants v on v.id = (l.x->>'variant_id')::bigint))
         order by r.offered_at), '[]'::jsonb)
    from hq.listing_recipes r where r.status in ('offered', 'review')
$function$;

-- sales with no order yet: each item now carries its confirmed recipe (lines for one unit), when every piece of it is still in the catalog
create or replace function hq.unlinked_sources() returns jsonb
language sql stable security definer set search_path to 'pg_catalog', 'hq', 'pg_temp' as $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'platform', s.platform, 'number', s.number, 'buyer', s.buyer, 'order_date', s.order_date, 'ship_by', s.ship_by,
           'note', s.note, 'shipping', s.shipping, 'problems', s.problems,
           'items', (select coalesce(jsonb_agg(case when r.case_key is not null and coalesce(trim(i.it->>'personalization'), '') = ''
                                                      and not exists (select 1 from jsonb_array_elements(r.lines) x
                                                                       where x->>'variant_id' is not null
                                                                         and not exists (select 1 from hq.variants v where v.id = (x->>'variant_id')::bigint and not v.archived))
                                                    then i.it || jsonb_build_object('recipe', jsonb_build_object('key', r.case_key, 'lines', r.lines))
                                                    else i.it end order by i.n), '[]'::jsonb)
                       from jsonb_array_elements(s.items) with ordinality i(it, n)
                       left join hq.listing_recipes r on r.status = 'confirmed' and r.case_key = hq.listing_key(s.platform, i.it)))
         order by s.order_date, s.id), '[]'::jsonb)
    from hq.source_orders s where s.order_id is null and s.dismissed_at is null
$function$;

-- signed-in only, like every hq function
revoke all on function hq.record_cases(bigint, text, jsonb, text), hq.decide_recipe(text, text, text), hq.read_recipes(), hq.recipe_threshold(), hq.listing_key(text, jsonb), hq.lines_key(jsonb) from public, anon;
grant execute on function hq.record_cases(bigint, text, jsonb, text), hq.decide_recipe(text, text, text), hq.read_recipes() to authenticated, service_role;
