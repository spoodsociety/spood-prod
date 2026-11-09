-- Collection editor (Nov 9, 2026): build new collections and edit existing ones from Inventory.
-- read_collections(): every collection (retired too) with its piece list.
-- save_collection(p, p_by): one atomic save of a collection and its whole piece list.
-- The catalog view stops tagging inventory with a retired collection.

create or replace function hq.read_collections()
returns jsonb language sql stable security definer
set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'archived', c.archived, 'updated_at', c.updated_at,
    'sells_accessory_set', c.sells_accessory_set, 'sells_enclosure', c.sells_enclosure,
    'pieces', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', cp.id, 'product_id', cp.product_id, 'color_scheme_id', cp.color_scheme_id,
                 'color_1', cs.color_1, 'color_2', cs.color_2, 'qty', cp.qty, 'size_code', cp.size_code,
                 'enclosure_only', cp.enclosure_only, 'choice', cp.choice, 'choice_option', cp.choice_option,
                 'option_code', cp.option_code, 'default_option', cp.default_option)
               order by cp.enclosure_only, cp.choice nulls first, pr.name, cp.id), '[]')
               from hq.collection_pieces cp join hq.products pr on pr.id = cp.product_id
               left join hq.color_schemes cs on cs.id = cp.color_scheme_id
               where cp.collection_id = c.id)
  ) order by c.archived, c.name), '[]')
  from hq.collections c
$$;

create or replace function hq.save_collection(p jsonb, p_by text default null)
returns jsonb language plpgsql security definer
set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $$
declare
  v_op text := nullif(p->>'op_id', '');
  v_id text := nullif(trim(coalesce(p->>'id', '')), '');
  v_name text := regexp_replace(trim(coalesce(p->>'name', '')), '\s+', ' ', 'g');
  v_key text := hq.name_key(p->>'name');
  v_arch boolean := coalesce((p->>'archived')::boolean, false);
  v_set boolean := coalesce((p->>'sells_accessory_set')::boolean, false);
  v_enc boolean := coalesce((p->>'sells_enclosure')::boolean, false);
  c hq.collections; v_new boolean; v_before jsonb; v_after jsonb;
  x jsonb; pr hq.products; v_c1 text; v_c2 text; v_scheme text; v_size text; v_opt text;
  v_ch text; v_cho text; v_qty int; v_pid bigint; v_dup text; v_warn text[] := '{}'; v_label text;
  v_old_pairs text[];
begin
  if v_op is not null then
    select l.data->'result' into v_after from app_log l where l.op_id = v_op and l.kind = 'collection_saved';
    if found then return v_after; end if;
  end if;
  if v_name = '' or v_key is null then raise exception 'Give the collection a name'; end if;
  if jsonb_typeof(coalesce(p->'pieces', '[]')) <> 'array' then raise exception 'save_collection: pieces must be a list'; end if;
  if not v_arch and not v_set and not v_enc then raise exception 'Pick how % is sold: accessory set, complete enclosure or both', v_name; end if;

  v_new := v_id is null;
  if v_new then
    v_id := v_key;
    if exists (select 1 from collections where id = v_id or hq.name_key(name) = v_key) then
      raise exception '%', 'There is already a collection called ' || v_name ||
        case when exists (select 1 from collections where (id = v_id or hq.name_key(name) = v_key) and archived) then ' (retired; open it and bring it back)' else '' end;
    end if;
    insert into collections (id, name, archived, sells_accessory_set, sells_enclosure) values (v_id, v_name, v_arch, v_set, v_enc);
    select * into c from collections where id = v_id;
    v_before := null; v_old_pairs := '{}';
  else
    select * into c from collections where id = v_id for update;
    if not found then raise exception 'That collection no longer exists'; end if;
    if p ? 'updated_at' and (p->>'updated_at')::timestamptz is distinct from c.updated_at then
      raise exception 'stale: % was changed by someone else since you opened it. Close and open it again.', c.name;
    end if;
    if exists (select 1 from collections where id <> v_id and hq.name_key(name) = v_key) then
      raise exception 'There is already a collection called %', v_name;
    end if;
    v_before := (select x2 from jsonb_array_elements(hq.read_collections()) x2 where x2->>'id' = v_id);
    v_old_pairs := array(select product_id || '|' || coalesce(color_scheme_id, '') from collection_pieces where collection_id = v_id);
    update collections set name = v_name, archived = v_arch, sells_accessory_set = v_set, sells_enclosure = v_enc, updated_at = now()
     where id = v_id;
  end if;

  delete from collection_pieces where collection_id = v_id;

  for x in select * from jsonb_array_elements(coalesce(p->'pieces', '[]')) loop
    select * into pr from products where id = x->>'product_id';
    if not found then raise exception 'Not in the catalog: piece "%"', coalesce(x->>'product_id', '(none)'); end if;
    v_label := pr.name;
    if pr.archived and not ((pr.id || '|' || coalesce(x->>'color_scheme_id', '')) = any(v_old_pairs)) then
      raise exception '% was removed from the catalog', pr.name;
    end if;

    v_qty := coalesce(nullif(x->>'qty', '')::int, 1);
    if v_qty < 1 or v_qty > 99 then raise exception '%: quantity must be 1 to 99', v_label; end if;

    v_size := nullif(x->>'size_code', '');
    if v_size is not null and not exists (select 1 from product_sizes s where s.product_id = pr.id and s.code = v_size) then
      raise exception '% isn''t made in size "%"', v_label, v_size;
    end if;

    v_opt := coalesce(nullif(x->>'option_code', ''), 'standard');
    if v_opt <> 'standard' and not exists (select 1 from variants v where v.product_id = pr.id and v.option_code = v_opt and not v.archived) then
      raise exception '% has no "%" option', v_label, v_opt;
    end if;

    -- colors: given as color ids -> the matching colorway (made if new); none given -> the colorway sent as is (null = any color)
    v_c1 := nullif(x->>'color_1', ''); v_c2 := nullif(x->>'color_2', '');
    if v_c1 is null and v_c2 is not null then raise exception '%: pick color 1 before color 2', v_label; end if;
    if v_c1 is not null then
      if not exists (select 1 from colors where id = v_c1) then raise exception 'Not in the catalog: color "%"', v_c1; end if;
      if v_c2 is not null and not exists (select 1 from colors where id = v_c2) then raise exception 'Not in the catalog: color "%"', v_c2; end if;
      v_c2 := nullif(v_c2, v_c1);
      select cs.id into v_scheme from color_schemes cs where cs.color_1 = v_c1 and cs.color_2 is not distinct from v_c2 order by cs.archived, cs.id limit 1;
      if v_scheme is null then
        v_scheme := concat_ws('-', v_c1, v_c2);
        insert into color_schemes (id, name, color_1, color_2)
        values (v_scheme, concat_ws(' + ', (select name from colors where id = v_c1), (select name from colors where id = v_c2)), v_c1, v_c2);
      end if;
    else
      v_scheme := nullif(x->>'color_scheme_id', '');
      if v_scheme is not null and not exists (select 1 from color_schemes where id = v_scheme) then
        raise exception 'Not in the catalog: colorway "%"', v_scheme;
      end if;
    end if;
    if v_scheme is not null then v_label := v_label || ' (' || (select name from color_schemes where id = v_scheme) || ')'; end if;

    v_ch := nullif(regexp_replace(trim(coalesce(x->>'choice', '')), '\s+', ' ', 'g'), '');
    v_cho := nullif(regexp_replace(trim(coalesce(x->>'choice_option', '')), '\s+', ' ', 'g'), '');
    if (v_ch is null) <> (v_cho is null) then raise exception '%: a choice needs both its name and the option', v_label; end if;
    if coalesce((x->>'default_option')::boolean, false) and v_ch is null then raise exception '%: only a choice option can be the default', v_label; end if;

    -- a colorway pinned here that the piece isn't listed in: saved, but flagged
    if v_scheme is not null and not ((pr.id || '|' || v_scheme) = any(v_old_pairs))
       and exists (select 1 from product_colors pc where pc.product_id = pr.id)
       and ((select color_1 from color_schemes where id = v_scheme) is not null)
       and (not exists (select 1 from product_colors pc where pc.product_id = pr.id and pc.slot = 1 and pc.color_id = (select color_1 from color_schemes where id = v_scheme))
            or ((select color_2 from color_schemes where id = v_scheme) is not null
                and not exists (select 1 from product_colors pc where pc.product_id = pr.id and pc.slot = 2 and pc.color_id = (select color_2 from color_schemes where id = v_scheme)))) then
      v_warn := v_warn || (v_label || ' isn''t listed in that color in Inventory; orders for it stay unmatched until it is');
    end if;

    v_pid := nullif(x->>'id', '')::bigint;
    if v_pid is not null and exists (select 1 from collection_pieces where id = v_pid) then v_pid := null; end if;  -- id from another collection: new row
    begin
      if v_pid is not null then
        insert into collection_pieces (id, collection_id, product_id, color_scheme_id, qty, size_code, enclosure_only, choice, choice_option, option_code, default_option)
        overriding system value
        values (v_pid, v_id, pr.id, v_scheme, v_qty, v_size, coalesce((x->>'enclosure_only')::boolean, false), v_ch, v_cho, v_opt, coalesce((x->>'default_option')::boolean, false));
      else
        insert into collection_pieces (collection_id, product_id, color_scheme_id, qty, size_code, enclosure_only, choice, choice_option, option_code, default_option)
        values (v_id, pr.id, v_scheme, v_qty, v_size, coalesce((x->>'enclosure_only')::boolean, false), v_ch, v_cho, v_opt, coalesce((x->>'default_option')::boolean, false));
      end if;
    exception when unique_violation then
      get stacked diagnostics v_dup = constraint_name;
      if v_dup = 'collection_pieces_one_default' then raise exception 'Only one default per choice (%)', v_ch; end if;
      raise exception '% is listed twice%', v_label, case when v_cho is not null then ' for ' || v_cho else '' end;
    end;
  end loop;

  if v_enc and not v_arch and not exists (select 1 from collection_pieces where collection_id = v_id and product_id = 'enclosure') then
    raise exception 'A complete enclosure needs the Enclosure piece (Door: Latch or Magnet)';
  end if;

  v_after := (select x2 from jsonb_array_elements(hq.read_collections()) x2 where x2->>'id' = v_id);
  v_after := v_after || jsonb_build_object('warnings', to_jsonb(v_warn), 'created', v_new);
  insert into app_log (op_id, kind, data, by_user)
  values (coalesce(v_op, 'coll-' || replace(gen_random_uuid()::text, '-', '')), 'collection_saved',
          jsonb_build_object('before', v_before, 'result', v_after), p_by);
  return v_after;
end $$;

revoke all on function hq.read_collections() from public, anon;
revoke all on function hq.save_collection(jsonb, text) from public, anon;
grant execute on function hq.read_collections() to authenticated;
grant execute on function hq.save_collection(jsonb, text) to authenticated;

-- A retired collection no longer labels inventory (collection / special-version tags).
create or replace view hq.catalog as
 SELECT v.id AS variant_id,
    v.sku,
    ( SELECT string_agg(c.name, ', '::text ORDER BY c.name) AS string_agg
           FROM (hq.collection_pieces cp
             JOIN hq.collections c ON ((c.id = cp.collection_id)))
          WHERE ((cp.product_id = v.product_id) AND (cp.color_scheme_id IS NULL) AND (NOT cp.enclosure_only) AND (NOT c.archived))) AS collection,
    p.name AS product,
    p.category,
    s.name AS size,
    cs.name AS color,
    NULLIF(v.option_code, 'standard'::text) AS option,
    p.tracked,
    v.notion_inventory_id,
    ((p.name ||
        CASE
            WHEN ((p.category = 'Floor Insert'::text) AND (hq.name_key(p.name) !~~ '%floor%'::text)) THEN ' Floor Insert'::text
            ELSE ''::text
        END) || COALESCE(((' ('::text || NULLIF(concat_ws(', '::text, NULLIF(s.name, 'Standard'::text),
        CASE
            WHEN (cs.id = ANY (ARRAY['standard'::text, 'shop-choice'::text])) THEN NULL::text
            ELSE cs.name
        END,
        CASE
            WHEN (v.option_code <> 'standard'::text) THEN initcap(replace(v.option_code, '-'::text, ' '::text))
            ELSE NULL::text
        END), ''::text)) || ')'::text), ''::text)) AS display_name,
    ( SELECT string_agg(c.name, ', '::text ORDER BY c.name) AS string_agg
           FROM (hq.collection_pieces cp
             JOIN hq.collections c ON ((c.id = cp.collection_id)))
          WHERE ((cp.product_id = v.product_id) AND (cp.color_scheme_id = v.color_scheme_id) AND (cp.color_scheme_id <> 'standard'::text) AND (NOT cp.enclosure_only) AND (NOT c.archived))) AS tags,
    v.archived
   FROM (((hq.variants v
     JOIN hq.products p ON ((p.id = v.product_id)))
     JOIN hq.product_sizes s ON (((s.product_id = v.product_id) AND (s.code = v.size_code))))
     JOIN hq.color_schemes cs ON ((cs.id = v.color_scheme_id)));
