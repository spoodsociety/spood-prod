-- save_order: learn a line alias only when a person changed the line.
--
-- Defect: the alias rule checked v_uid "is the line new or changed?" before v_uid had been read from the
-- payload (it was always null at that point), so EVERY hq save — including a status change from Bin View,
-- which resends all lines unchanged — rewrote hq.line_aliases for every catalog-matched line
-- (decided_by/decided_at churn, and the same text on two orders linked to different items flips the alias
-- back and forth with each status change). Migration pick_only_on_change_latest_human_wins intended the
-- opposite. Fix: read the line's uid first, then apply the alias rule. No other behavior changes.
create or replace function hq.save_order(p jsonb, p_by text default null::text, p_source text default 'hq'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare
  v_op   text := nullif(trim(p->>'op_id'), '');
  v_id   text := lower(nullif(trim(p->>'id'), ''));
  v_prev jsonb; v_res jsonb; v_old hq.saved_ops; v_cur integer; l jsonb; v_var bigint; v_match text; n integer := 0;
  v_uid uuid; v_uids uuid[] := '{}'; v_new boolean[] := '{}'; v_g uuid; v_ix integer; v_del timestamptz; v_dups jsonb := '[]'::jsonb;
begin
  if v_op is null then raise exception 'save_order: op_id is required'; end if;

  select * into v_old from hq.saved_ops where op_id = v_op;
  if found then
    if v_old.payload = p then return v_old.result || '{"duplicate":true}'; end if;
    raise exception 'op_id % was already used for a different save', v_op;
  end if;

  if v_id is null then
    if coalesce((p->>'delete')::boolean, false) then raise exception 'save_order: which order to delete?'; end if;
    v_id := replace(gen_random_uuid()::text, '-', '');
  elsif v_id !~ '^[0-9a-f]{32}$' then raise exception 'save_order: bad order id';
  end if;

  if p_source not in ('hq', 'notion') then raise exception 'save_order: source must be hq or notion'; end if;
  select version, deleted_at into v_cur, v_del from hq.orders where id = v_id for update;
  if found and v_del is not null then raise exception 'This order no longer exists'; end if;
  if found and p_source = 'notion' then
    if exists (select 1 from hq.order_history h where h.order_id = v_id and h.source = 'hq') then
      raise exception 'Order % was changed in HQ after it was imported; not overwritten', v_id;
    end if;
    v_prev := hq.order_json(v_id);
  elsif found then
    if nullif(p->>'version', '') is null or (p->>'version')::integer <> v_cur then
      raise exception 'stale: this order changed since it was opened (now version %); reopen it and save again', v_cur
        using errcode = '40001';
    end if;
    v_prev := hq.order_json(v_id);
  elsif nullif(p->>'version', '') is not null and nullif(trim(p->>'id'), '') is not null and p_source = 'hq' then
    raise exception 'This order no longer exists';
  end if;

  if coalesce((p->>'delete')::boolean, false) then
    if v_prev is null then raise exception 'This order no longer exists'; end if;
    update hq.orders set deleted_at = now(), deleted_by = p_by, version = version + 1 where id = v_id;
    v_res := jsonb_build_object('id', v_id, 'deleted', true);
  else
    if coalesce(trim(p->>'customer'), '') = '' then raise exception 'Customer is required'; end if;
    if jsonb_typeof(coalesce(p->'lines', '[]')) <> 'array' then raise exception 'lines must be a list'; end if;

    insert into hq.orders as o (id, customer, repeat_customer, handle, platform, order_number, shipping_number, order_date, ship_by,
                                ship_type, status, notes, important, summary, freebie, items, collections, order_type, state, source)
    values (v_id, trim(p->>'customer'), coalesce((p->>'repeat_customer')::boolean, false), nullif(trim(p->>'handle'), ''),
            coalesce(array(select jsonb_array_elements_text(p->'platform')), '{}'), nullif(trim(p->>'order_number'), ''),
            nullif(trim(p->>'shipping_number'), ''), nullif(p->>'order_date', '')::date, nullif(p->>'ship_by', '')::date,
            coalesce(nullif(p->>'ship_type', ''), 'Standard'),
            coalesce(nullif(replace(trim(p->>'status'), '*', ''), ''), 'Not started'),
            p->>'notes', nullif(p->>'important', ''), nullif(p->>'summary', ''),
            coalesce(array(select jsonb_array_elements_text(p->'freebie')), '{}'),
            coalesce(array(select jsonb_array_elements_text(p->'items')), '{}'),
            coalesce(array(select jsonb_array_elements_text(p->'collections')), '{}'),
            coalesce(array(select jsonb_array_elements_text(p->'order_type')), '{}'),
            nullif(trim(p->>'state'), ''), p_source)
    on conflict (id) do update set
      customer = excluded.customer, repeat_customer = excluded.repeat_customer, handle = excluded.handle, platform = excluded.platform,
      order_number = excluded.order_number, shipping_number = excluded.shipping_number, order_date = excluded.order_date,
      ship_by = excluded.ship_by, ship_type = excluded.ship_type, status = excluded.status, notes = excluded.notes,
      important = excluded.important, summary = excluded.summary, freebie = excluded.freebie, items = excluded.items, collections = excluded.collections,
      order_type = excluded.order_type, state = excluded.state, version = o.version + 1;

    update hq.order_lines set line_no = line_no + 1000000 where order_id = v_id;
    for l in select value from jsonb_array_elements(coalesce(p->'lines', '[]')) loop
      n := n + 1; v_var := null; v_uid := null;
      if coalesce(trim(l->>'text'), '') = '' then raise exception 'Line % has no text', n; end if;

      -- which saved line this is (read first: the alias rule below needs to know whether the line changed)
      if nullif(l->>'uid', '') is not null then
        if l->>'uid' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Line "%": bad uid', l->>'text'; end if;
        v_uid := (l->>'uid')::uuid;
        if v_uid = any(v_uids) then raise exception 'Line "%": uid % is used twice in this order', l->>'text', v_uid; end if;
        if not exists (select 1 from hq.order_lines x where x.order_id = v_id and x.uid = v_uid) then v_uid := null; end if;
      elsif p_source = 'notion' then
        select x.uid into v_uid from hq.order_lines x
        where x.order_id = v_id and x.line_no >= 1000000 and x.text = trim(l->>'text') order by x.line_no limit 1;
      end if;

      if nullif(l->>'variant_id', '') is not null then
        select id into v_var from hq.variants where id = (l->>'variant_id')::bigint;
        if v_var is null then raise exception 'Line "%": item % is not in the catalog', l->>'text', l->>'variant_id'; end if;
      elsif nullif(l->>'notion_inventory_id', '') is not null then
        select id into v_var from hq.variants where notion_inventory_id = lower(replace(l->>'notion_inventory_id', '-', ''));
        if v_var is null then raise exception 'Line "%": its Inventory row is not in the Supabase catalog', l->>'text'; end if;
      end if;
      v_match := case when v_var is not null then 'item' when coalesce((l->>'untracked')::boolean, false) then 'untracked' else 'unmatched' end;
      if v_var is null and v_match = 'unmatched' then
        select lv.variant_id, lv.match into v_var, v_match from hq.line_variant(trim(l->>'text'), p_by) lv;
      elsif p_source = 'hq' and hq.name_key(regexp_replace(hq.line_clean(l->>'text'), '\(matte\)', ' Matte', 'gi')) is not null
            and not hq.is_enc_line(trim(l->>'text'))
            and (v_uid is null or exists (select 1 from hq.order_lines x where x.order_id = v_id and x.uid = v_uid and x.line_no >= 1000000
                                           and (x.variant_id is distinct from v_var or x.text <> trim(l->>'text')))) then
        -- a person picked this item (or marked it not tracked) on a new or changed line: remember the text for next time
        insert into hq.line_aliases (alias_key, variant_id, untracked, sample_text, decided_by)
        values (hq.name_key(regexp_replace(hq.line_clean(l->>'text'), '\(matte\)', ' Matte', 'gi')), v_var, v_var is null, trim(l->>'text'), p_by)
        on conflict (alias_key) do update set variant_id = excluded.variant_id, untracked = excluded.untracked, decided_by = excluded.decided_by, decided_at = now()
        ;
      end if;

      v_new := v_new || (v_uid is null);
      if v_uid is not null then
        update hq.order_lines set line_no = n, text = trim(l->>'text'), qty = coalesce(nullif(l->>'qty', '')::integer, 1), variant_id = v_var, match = v_match,
          -- a different catalog item: the old piece's print/pack status doesn't carry over
          print_state = case when variant_id is not null and variant_id is distinct from v_var then '' else print_state end,
          print_at    = case when variant_id is not null and variant_id is distinct from v_var then null else print_at end,
          print_src   = case when variant_id is not null and variant_id is distinct from v_var then null else print_src end,
          packed      = case when variant_id is not null and variant_id is distinct from v_var then false else packed end,
          packed_at   = case when variant_id is not null and variant_id is distinct from v_var then null else packed_at end,
          packed_from = case when variant_id is not null and variant_id is distinct from v_var then null else packed_from end,
          note = nullif(trim(l->>'note'), ''), tag = case when l->>'tag' in ('gift', 'addon') then l->>'tag' else '' end
        where order_id = v_id and uid = v_uid;
      else
        insert into hq.order_lines (order_id, line_no, text, qty, variant_id, match, note, tag)
        values (v_id, n, trim(l->>'text'), coalesce(nullif(l->>'qty', '')::integer, 1), v_var, v_match, nullif(trim(l->>'note'), ''), case when l->>'tag' in ('gift', 'addon') then l->>'tag' else '' end)
        returning uid into v_uid;
      end if;
      v_uids := v_uids || v_uid;
    end loop;

    n := 0;
    for l in select value from jsonb_array_elements(coalesce(p->'lines', '[]')) loop
      n := n + 1; v_g := null;
      if nullif(l->>'group_uid', '') is not null then
        if l->>'group_uid' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Line "%": bad group_uid', l->>'text'; end if;
        v_g := (l->>'group_uid')::uuid;
        if not (v_g = any(v_uids)) then raise exception 'Line "%": its enclosure line is not on this order', l->>'text'; end if;
      elsif nullif(l->>'group_index', '') is not null then
        v_ix := (l->>'group_index')::integer;
        if v_ix < 1 or v_ix > array_length(v_uids, 1) then raise exception 'Line "%": group_index % is not a line of this order', l->>'text', v_ix; end if;
        v_g := v_uids[v_ix];
      end if;
      if v_g = v_uids[n] then raise exception 'Line "%" cannot be its own enclosure line', l->>'text'; end if;
      if v_g is not null then
        update hq.order_lines set group_uid = v_g where order_id = v_id and uid = v_uids[n];
      elsif v_new[n] then
        if not hq.is_enc_line(trim(l->>'text')) then
          update hq.order_lines set group_uid = (select h.uid from hq.order_lines h
            where h.order_id = v_id and h.uid = any(v_uids) and h.line_no < n and hq.is_enc_line(h.text) order by h.line_no desc limit 1)
          where order_id = v_id and uid = v_uids[n];
        end if;
      end if;
    end loop;
    delete from hq.order_lines where order_id = v_id and line_no >= 1000000;

    if nullif(trim(p->>'order_number'), '') is not null then
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'customer', x.customer, 'order_number', x.order_number) order by x.created_at, x.id), '[]'::jsonb)
        into v_dups from hq.orders x
       where x.id <> v_id and x.deleted_at is null and lower(trim(x.order_number)) = lower(trim(p->>'order_number'));
    end if;
    v_res := jsonb_build_object('id', v_id, 'version', (select version from hq.orders where id = v_id),
                                'lines', n, 'unmatched', (select count(*) from hq.order_lines where order_id = v_id and match = 'unmatched'),
                                'uids', to_jsonb(v_uids), 'duplicates', v_dups);
  end if;

  insert into hq.order_history (order_id, op_id, source, before, after, by_user)
  values (v_id, v_op, p_source, v_prev, case when v_res ? 'deleted' then null else hq.order_json(v_id) end, p_by);
  insert into hq.saved_ops (op_id, order_id, payload, result, by_user) values (v_op, v_id, p, v_res, p_by);
  return v_res;
end $function$;
