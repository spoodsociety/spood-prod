-- Item editor: everything about a piece can be read and saved in one go.
--   hq.read_item(product id)  -> the piece, its sizes, offered colors, every variation (removed ones too) and the order wording learned for each
--   hq.save_item(p, p_by)     -> name, other names (aliases), type, note, tracked, customer picks color, add-ons bar, default color,
--                                sizes (name, filament, print time, profile, remove/bring back), offered colors,
--                                variations (inventory name, note, size, color, option, remove/bring back), forget learned wording
-- One transaction, stale-edit check, logged in app_log as item_saved with before/after. Only the keys sent are changed.
-- Until now only a variation's inventory name and note could be edited (update_variant).

-- The colorway for a pair of colors: the existing one, or a new one. Internal (not callable by signed-in users).
create or replace function hq.scheme_for(p_c1 text, p_c2 text)
 returns text
 language plpgsql
 set search_path to ''
as $function$
declare v_c1 text := nullif(trim(coalesce(p_c1, '')), ''); v_c2 text := nullif(trim(coalesce(p_c2, '')), ''); v_id text; n1 text; n2 text;
begin
  if v_c1 is null then
    if v_c2 is not null then raise exception 'Pick color 1 before color 2'; end if;
    return 'standard';
  end if;
  v_c2 := nullif(v_c2, v_c1);   -- the same color twice is one color
  select c.name into n1 from hq.colors c where c.id = v_c1;
  if n1 is null then raise exception 'Not in the catalog: color "%"', v_c1; end if;
  if v_c2 is not null then
    select c.name into n2 from hq.colors c where c.id = v_c2;
    if n2 is null then raise exception 'Not in the catalog: color "%"', v_c2; end if;
  end if;
  select cs.id into v_id from hq.color_schemes cs where cs.color_1 = v_c1 and cs.color_2 is not distinct from v_c2;
  if v_id is not null then
    update hq.color_schemes set archived = false where id = v_id and archived;
    return v_id;
  end if;
  v_id := concat_ws('-', v_c1, v_c2);
  if exists (select 1 from hq.color_schemes cs where cs.id = v_id) then v_id := v_id || '-' || substr(md5(random()::text), 1, 4); end if;
  begin
    insert into hq.color_schemes (id, name, color_1, color_2) values (v_id, concat_ws(' + ', n1, n2), v_c1, v_c2);
  exception when unique_violation then
    raise exception 'A colorway called "%" already exists with other colors', concat_ws(' + ', n1, n2);
  end;
  return v_id;
end $function$;
revoke execute on function hq.scheme_for(text, text) from public, anon, authenticated;

create or replace function hq.read_item(p_id text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'category', p.category, 'aliases', to_jsonb(p.aliases), 'description', p.description,
    'tracked', p.tracked, 'fulfillment_type', p.fulfillment_type, 'picks_color', p.customer_picks_color, 'addon', p.addon, 'archived', p.archived,
    'default_scheme', p.default_color_scheme_id,
    'default_color_1', (select cs.color_1 from color_schemes cs where cs.id = p.default_color_scheme_id),
    'default_color_2', (select cs.color_2 from color_schemes cs where cs.id = p.default_color_scheme_id),
    'stamp', greatest(p.updated_at, (select max(s.updated_at) from product_sizes s where s.product_id = p.id),
                      (select max(v.updated_at) from variants v where v.product_id = p.id)),
    'has_history', exists (select 1 from inventory_movements m join variants v on v.id = m.variant_id where v.product_id = p.id),
    'collections', (select coalesce(jsonb_agg(distinct c.name), '[]') from collection_pieces cp join collections c on c.id = cp.collection_id
                    where cp.product_id = p.id and not c.archived),
    'sizes', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name, 'filament_g', s.filament_g, 'print_minutes', s.print_minutes,
                       'print_profile', s.print_profile, 'archived', s.archived,
                       'used', (select count(*) from variants v where v.product_id = p.id and v.size_code = s.code and not v.archived))
                     order by s.archived, s.code = 'mini' desc, s.code = 'sling-size' desc, s.code = 'small' desc, s.code = 'standard' desc, s.code = 'large' desc, s.code = 'custom', s.code), '[]')
              from product_sizes s where s.product_id = p.id),
    'colors', jsonb_build_object(
       '1', (select coalesce(jsonb_agg(pc.color_id order by c.name), '[]') from product_colors pc join colors c on c.id = pc.color_id where pc.product_id = p.id and pc.slot = 1),
       '2', (select coalesce(jsonb_agg(pc.color_id order by c.name), '[]') from product_colors pc join colors c on c.id = pc.color_id where pc.product_id = p.id and pc.slot = 2)),
    'variants', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'notion_id', v.notion_inventory_id, 'sku', v.sku, 'label', v.inventory_name, 'note', v.note,
                       'size_code', v.size_code, 'color_scheme_id', v.color_scheme_id, 'color_1', cs.color_1, 'color_2', cs.color_2, 'color_name', cs.name,
                       'option_code', v.option_code, 'archived', v.archived,
                       'on_hand', (select s.on_hand from stock_on_hand s where s.variant_id = v.id),
                       'open_lines', (select count(*) from order_lines l join orders o on o.id = l.order_id
                                       where l.variant_id = v.id and o.status <> 'Done' and o.deleted_at is null),
                       'learned', (select coalesce(jsonb_agg(jsonb_build_object('key', la.alias_key, 'text', la.sample_text) order by la.sample_text), '[]')
                                   from line_aliases la where la.variant_id = v.id))
                     order by v.archived, v.size_code, cs.name, v.option_code, v.id), '[]')
                 from variants v join color_schemes cs on cs.id = v.color_scheme_id where v.product_id = p.id))
  from products p where p.id = p_id
$function$;

create or replace function hq.save_item(p jsonb, p_by text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare
  v_op text := nullif(p->>'op_id', '');
  v_id text := nullif(trim(coalesce(p->>'id', '')), '');
  r_p products; r_s product_sizes; r_v variants;
  v_before jsonb; v_after jsonb;
  v_name text; v_cat text; v_al text[]; v_seen text[] := '{}'; v_a text; v_k text; v_def text; v_tracked boolean;
  v_x jsonb; v_code text; v_sname text; v_g numeric; v_min integer; v_newarch text[] := '{}';
  v_size text; v_scheme text; v_opt text; v_label text; v_arch boolean; v_ident boolean;
  v_n integer; v_slot integer; v_other text; v_old jsonb := '[]'; v_warn text[] := '{}'; v_forgot integer := 0; v_flagged integer := 0;
  v_oldkeys text[];
begin
  if v_op is not null then
    select l.data->'result' into v_after from app_log l where l.op_id = v_op and l.kind = 'item_saved';
    if found then return v_after; end if;
  end if;
  select * into r_p from products q where q.id = v_id for update;
  if not found then raise exception 'That item no longer exists'; end if;
  v_before := hq.read_item(v_id);
  if p ? 'stamp' and (p->>'stamp')::timestamptz is distinct from (v_before->>'stamp')::timestamptz then
    raise exception 'stale: % was changed by someone else since you opened it. Close and open it again.', r_p.name;
  end if;

  -- ---------- the piece ----------
  v_name := case when p ? 'name' then regexp_replace(trim(coalesce(p->>'name', '')), '\s+', ' ', 'g') else r_p.name end;
  if v_name = '' or hq.name_key(v_name) is null then raise exception 'Give the item a name'; end if;
  if not r_p.archived then
    select q.name into v_other from products q where q.id <> v_id and not q.archived and hq.name_key(q.name) = hq.name_key(v_name) limit 1;
    if v_other is not null then raise exception 'Another item is already called "%"', v_other; end if;
  end if;
  v_cat := case when p ? 'category' then trim(coalesce(p->>'category', '')) else r_p.category end;
  if not (v_cat = any (array['Hide','Ledge','Climb','Floor Insert','Insert','Figure','Part','Enclosure','Add-on','Supply','Kit','Set'])) then
    raise exception 'Not an item type: "%"', v_cat;
  end if;
  if p ? 'aliases' then
    if jsonb_typeof(p->'aliases') <> 'array' then raise exception 'save_item: aliases must be a list'; end if;
    v_al := '{}';
    for v_a in select trim(t.x) from jsonb_array_elements_text(p->'aliases') as t(x) loop
      v_k := lower(v_a);
      continue when hq.name_key(v_a) is null or hq.name_key(v_a) = hq.name_key(v_name) or v_k = any (v_seen);   -- empty, the name itself, or listed twice
      v_seen := v_seen || v_k; v_al := v_al || v_a;
    end loop;
  else
    v_al := r_p.aliases;
  end if;
  v_tracked := case when p ? 'tracked' then coalesce((p->>'tracked')::boolean, r_p.tracked) else r_p.tracked end;
  if r_p.tracked and not v_tracked and (v_before->>'has_history')::boolean then
    raise exception '% has stock history, so it stays tracked', v_name;
  end if;
  if p ? 'default_color_1' then
    v_def := case when nullif(trim(coalesce(p->>'default_color_1', '')), '') is null then null else hq.scheme_for(p->>'default_color_1', p->>'default_color_2') end;
  elsif p ? 'default_scheme' then
    v_def := nullif(p->>'default_scheme', '');
    if v_def is not null and not exists (select 1 from color_schemes cs where cs.id = v_def) then raise exception 'Not in the catalog: colorway "%"', v_def; end if;
  else
    v_def := r_p.default_color_scheme_id;
  end if;
  update products q set name = v_name, category = v_cat, aliases = v_al, tracked = v_tracked,
         description = case when p ? 'description' then nullif(trim(coalesce(p->>'description', '')), '') else q.description end,
         customer_picks_color = case when p ? 'picks_color' then coalesce((p->>'picks_color')::boolean, q.customer_picks_color) else q.customer_picks_color end,
         addon = case when p ? 'addon' then coalesce((p->>'addon')::boolean, q.addon) else q.addon end,
         default_color_scheme_id = v_def, updated_at = now()
   where q.id = v_id;

  -- ---------- sizes ----------
  if p ? 'sizes' then
    if jsonb_typeof(p->'sizes') <> 'array' then raise exception 'save_item: sizes must be a list'; end if;
    for v_x in select * from jsonb_array_elements(p->'sizes') loop
      v_code := nullif(v_x->>'code', '');
      v_sname := regexp_replace(trim(coalesce(v_x->>'name', '')), '\s+', ' ', 'g');
      if v_sname = '' or hq.name_key(v_sname) is null then raise exception 'A size needs a name'; end if;
      v_g := nullif(trim(coalesce(v_x->>'filament_g', '')), '')::numeric;
      v_min := round(nullif(trim(coalesce(v_x->>'print_minutes', '')), '')::numeric)::integer;
      if v_g is not null and v_g <= 0 then raise exception '%: filament must be more than 0', v_sname; end if;
      if v_min is not null and v_min <= 0 then raise exception '%: print time must be more than 0', v_sname; end if;
      if v_code is null then                       -- a new size (or one removed earlier, brought back by name)
        v_code := hq.name_key(v_sname);
        select * into r_s from product_sizes s where s.product_id = v_id and s.code = v_code;
        if found then
          if not r_s.archived then raise exception 'Size "%" is listed twice', v_sname; end if;
          update product_sizes s set name = v_sname, archived = false, filament_g = coalesce(v_g, s.filament_g), print_minutes = coalesce(v_min, s.print_minutes),
                 print_profile = coalesce(nullif(trim(coalesce(v_x->>'print_profile', '')), ''), s.print_profile)
           where s.product_id = v_id and s.code = v_code;
        else
          insert into product_sizes (product_id, code, name, filament_g, print_minutes, print_profile)
          values (v_id, v_code, v_sname, v_g, v_min, nullif(trim(coalesce(v_x->>'print_profile', '')), ''));
        end if;
      else
        select * into r_s from product_sizes s where s.product_id = v_id and s.code = v_code for update;
        if not found then raise exception 'Not a size of %: "%"', v_name, v_code; end if;
        update product_sizes s set name = v_sname,
               filament_g = case when v_x ? 'filament_g' then v_g else s.filament_g end,
               print_minutes = case when v_x ? 'print_minutes' then v_min else s.print_minutes end,
               print_profile = case when v_x ? 'print_profile' then nullif(trim(coalesce(v_x->>'print_profile', '')), '') else s.print_profile end,
               archived = case when v_x ? 'archived' then coalesce((v_x->>'archived')::boolean, s.archived) else s.archived end
         where s.product_id = v_id and s.code = v_code;
        if coalesce((v_x->>'archived')::boolean, false) and not r_s.archived then v_newarch := v_newarch || v_code; end if;
      end if;
    end loop;
    select max(s.name) into v_other from product_sizes s where s.product_id = v_id and not s.archived group by hq.name_key(s.name) having count(*) > 1 limit 1;
    if v_other is not null then raise exception 'Size "%" is listed twice', v_other; end if;
  end if;

  -- ---------- colors the piece is offered in ----------
  if p ? 'colors' then
    for v_slot in 1..2 loop
      select t.x into v_other from jsonb_array_elements_text(coalesce(p->'colors'->(v_slot::text), '[]')) as t(x)
       where not exists (select 1 from colors c where c.id = t.x) limit 1;
      if v_other is not null then raise exception 'Not in the catalog: color "%"', v_other; end if;
      delete from product_colors pc where pc.product_id = v_id and pc.slot = v_slot
         and pc.color_id not in (select t.x from jsonb_array_elements_text(coalesce(p->'colors'->(v_slot::text), '[]')) as t(x));
      insert into product_colors (product_id, slot, color_id, source, added_by)
      select v_id, v_slot::smallint, t.x, 'added', p_by from jsonb_array_elements_text(coalesce(p->'colors'->(v_slot::text), '[]')) as t(x)
      on conflict do nothing;
    end loop;
  end if;

  -- ---------- order wording a person asked to forget ----------
  if p ? 'forget' then
    with d as (delete from line_aliases la where la.alias_key in (select t.x from jsonb_array_elements_text(p->'forget') as t(x))
                 and la.variant_id in (select v.id from variants v where v.product_id = v_id) returning 1)
    select count(*) into v_n from d;
    v_forgot := v_forgot + v_n;
  end if;

  -- ---------- variations ----------
  if p ? 'variants' then
    if jsonb_typeof(p->'variants') <> 'array' then raise exception 'save_item: variants must be a list'; end if;
    for v_x in select * from jsonb_array_elements(p->'variants') loop
      select * into r_v from variants v where v.id = (v_x->>'id')::bigint and v.product_id = v_id for update;
      if not found then raise exception 'Not a variation of %: %', v_name, v_x->>'id'; end if;
      v_size := coalesce(nullif(v_x->>'size_code', ''), r_v.size_code);
      if not exists (select 1 from product_sizes s where s.product_id = v_id and s.code = v_size) then raise exception '% isn''t made in size "%"', v_name, v_size; end if;
      v_scheme := case when v_x ? 'color_1' then hq.scheme_for(v_x->>'color_1', v_x->>'color_2')
                       when v_x ? 'color_scheme_id' then coalesce(nullif(v_x->>'color_scheme_id', ''), 'standard')
                       else r_v.color_scheme_id end;
      if not exists (select 1 from color_schemes cs where cs.id = v_scheme) then raise exception 'Not in the catalog: colorway "%"', v_scheme; end if;
      v_opt := coalesce(nullif(v_x->>'option_code', ''), r_v.option_code);
      if v_opt !~ '^[a-z0-9-]+$' then raise exception 'Not an option: "%"', v_opt; end if;
      v_label := case when v_x ? 'label' then nullif(regexp_replace(trim(coalesce(v_x->>'label', '')), '\s+', ' ', 'g'), '') else r_v.inventory_name end;
      if v_label is null and r_v.inventory_name is not null then raise exception 'Every variation needs a name (%)', r_v.inventory_name; end if;
      v_arch := case when v_x ? 'archived' then coalesce((v_x->>'archived')::boolean, r_v.archived) else r_v.archived end;
      v_ident := (v_size, v_scheme, v_opt) is distinct from (r_v.size_code, r_v.color_scheme_id, r_v.option_code);

      if v_arch and not r_v.archived then          -- removing: same rule as archive_variant
        select s.on_hand into v_n from stock_on_hand s where s.variant_id = r_v.id;
        if coalesce(v_n, 0) <> 0 then raise exception '"%" still has % in stock; count it to 0 first', coalesce(r_v.inventory_name, r_v.sku), v_n; end if;
        select count(*) into v_n from order_lines l join orders o on o.id = l.order_id where l.variant_id = r_v.id and o.status <> 'Done' and o.deleted_at is null;
        if v_n > 0 then raise exception '"%" is on % open order line%; change those lines first', coalesce(r_v.inventory_name, r_v.sku), v_n, case when v_n = 1 then '' else 's' end; end if;
      end if;

      begin
        update variants v set size_code = v_size, color_scheme_id = v_scheme, option_code = v_opt, inventory_name = v_label, archived = v_arch,
               note = case when v_x ? 'note' then nullif(trim(coalesce(v_x->>'note', '')), '') else v.note end
         where v.id = r_v.id;
      exception when unique_violation then
        select coalesce(q.inventory_name, q.sku) || case when q.archived then ' (removed; bring it back instead)' else '' end into v_other
          from variants q where q.product_id = v_id and q.size_code = v_size and q.color_scheme_id = v_scheme and q.option_code = v_opt and q.id <> r_v.id;
        raise exception 'That size and color is already in the catalog as "%"', coalesce(v_other, v_label);
      end;

      if v_ident then
        -- the sku says what the item is (the Order Desk reads an enclosure's size and door from it), so it follows; kept if another item has that sku
        update variants v set sku = concat_ws('-', v_id, nullif(v_size, 'standard'), nullif(v_scheme, 'standard'), nullif(v_opt, 'standard'))
         where v.id = r_v.id
           and not exists (select 1 from variants q where q.id <> r_v.id and q.sku = concat_ws('-', v_id, nullif(v_size, 'standard'), nullif(v_scheme, 'standard'), nullif(v_opt, 'standard')));
        -- the wording learned for it described the old size/color: forget it, and re-check the open orders it is on against their words
        with d as (delete from line_aliases la where la.variant_id = r_v.id returning 1) select count(*) into v_n from d;
        v_forgot := v_forgot + v_n;
        with u as (update order_lines l set conflict = hq.line_check(l.text, l.variant_id) from orders o
                    where o.id = l.order_id and l.variant_id = r_v.id and o.status <> 'Done' and o.deleted_at is null
                      and l.conflict is distinct from hq.line_check(l.text, l.variant_id)
                    returning l.conflict)
        select count(*) filter (where u.conflict is not null) into v_n from u;
        v_flagged := v_flagged + v_n;
      elsif r_v.inventory_name is not null and hq.name_key(r_v.inventory_name) is distinct from hq.name_key(v_label) then
        v_old := v_old || jsonb_build_object('id', r_v.id, 'label', r_v.inventory_name);
      end if;
    end loop;

    select max(q.inventory_name) into v_other from variants q
     where not q.archived and q.inventory_name is not null
       and hq.name_key(q.inventory_name) in (select hq.name_key(z.inventory_name) from variants z where z.product_id = v_id and not z.archived and z.inventory_name is not null)
     group by hq.name_key(q.inventory_name) having count(*) > 1 limit 1;
    if v_other is not null then raise exception 'Two items would be called "%"', v_other; end if;

    -- wording learned for another item that is now exactly this item's name gives way to the name
    with d as (delete from line_aliases la using variants z
                where z.product_id = v_id and not z.archived and z.inventory_name is not null
                  and la.alias_key = hq.name_key(z.inventory_name) and la.variant_id is distinct from z.id returning 1)
    select count(*) into v_n from d;
    v_forgot := v_forgot + v_n;

    -- an old name still finds its item, as long as its words agree with the item and no item is called that now
    insert into line_aliases (alias_key, sample_text, variant_id, decided_by)
    select hq.name_key(o.label), o.label, o.id, p_by
      from (select (t.x->>'id')::bigint as id, t.x->>'label' as label from jsonb_array_elements(v_old) as t(x)) o
     where hq.name_key(o.label) is not null
       and not exists (select 1 from variants z where not z.archived and hq.name_key(z.inventory_name) = hq.name_key(o.label))
       and hq.line_check(o.label, o.id) is null
    on conflict (alias_key) do nothing;
  end if;

  -- ---------- the piece as a whole ----------
  select s.name into v_other from product_sizes s
   where s.product_id = v_id and s.archived and exists (select 1 from variants v where v.product_id = v_id and v.size_code = s.code and not v.archived) limit 1;
  if v_other is not null then raise exception 'Size % still has items; remove or change them first', v_other; end if;
  select s.name || ' (' || c.name || ')' into v_other from product_sizes s
    join collection_pieces cp on cp.product_id = s.product_id and cp.size_code = s.code join collections c on c.id = cp.collection_id
   where s.product_id = v_id and s.code = any (v_newarch) and not c.archived limit 1;
  if v_other is not null then raise exception 'Size % is set on that collection; change it there first', v_other; end if;
  if not r_p.archived and not exists (select 1 from product_sizes s where s.product_id = v_id and not s.archived) then raise exception '% needs at least one size', v_name; end if;
  select coalesce(v.inventory_name, v.sku) into v_other from variants v join color_schemes cs on cs.id = v.color_scheme_id
   where v.product_id = v_id and not v.archived and cs.archived limit 1;
  if v_other is not null then raise exception '"%" is in a color that was removed from the catalog', v_other; end if;

  -- a name or other name that another piece also answers to: order text with only that name needs a person to pick
  v_oldkeys := array(select hq.name_key(t.x) from unnest(array[r_p.name] || r_p.aliases) as t(x));
  for v_a in select t.x from unnest(array[v_name] || v_al) as t(x) loop
    continue when hq.name_key(v_a) = any (v_oldkeys);
    select string_agg(q.name, ', ' order by q.name) into v_other from products q
     where q.id <> v_id and not q.archived
       and (hq.name_key(q.name) = hq.name_key(v_a) or hq.name_key(v_a) = any (array(select hq.name_key(y.x) from unnest(q.aliases) as y(x))));
    if v_other is not null then v_warn := v_warn || ('"' || v_a || '" is also ' || v_other); end if;
  end loop;
  if v_flagged > 0 then
    v_warn := v_warn || (v_flagged || ' open order line' || case when v_flagged = 1 then ' says' else 's say' end || ' something different now; check Bin View');
  end if;

  v_after := hq.read_item(v_id) || jsonb_build_object('warnings', to_jsonb(v_warn), 'forgotten', v_forgot);
  insert into app_log (op_id, kind, data, by_user)
  values (coalesce(v_op, 'item-' || replace(gen_random_uuid()::text, '-', '')), 'item_saved', jsonb_build_object('before', v_before, 'result', v_after), p_by);
  return v_after;
end $function$;

grant execute on function hq.read_item(text) to authenticated;
grant execute on function hq.save_item(jsonb, text) to authenticated;
