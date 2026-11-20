-- Order lines that should match the catalog but didn't: four root causes fixed.
-- 1. resolve_line: a product whose own name has parentheses ("Space Rock Wrap (for Floor) (Small, Space Grey)") was cut at the first
--    parenthesis and came back "no product". Each parenthesis group is now its own part.
-- 2. resolve_line: "Small" on a one-size piece ("Silk Cocoon Hide (Small)") came back "size not offered". The shop's regular size is
--    Small, stored as Standard on one-size pieces, so Small now means that size there (line_check already treated it that way).
-- 3. line_variant / pick_variant: a new variation's inventory name was built from an existing one cut at its first " (", which dropped
--    "(for Floor)" from the name. Only the last parenthesis group (size, color) is cut now.
-- 4. pick_variant: a person picking a color on the order form that the piece isn't listed in was told "add it in Inventory" and, if they
--    saved anyway, the line stayed unmatched for good. With offer:true (sent only for a pick made on the form) the color is recorded as
--    offered and the variation is made, like any other new variation. Pasted or imported text still never creates a new colorway.
-- 5. hq.rematch_open_lines: unmatched lines on open orders are matched again whenever the catalog or the learned wording changes
--    (deferred triggers, once per save, after the save itself is done). Before, a line stayed unmatched until someone re-saved its order.
do $patch$
declare d text; a text[]; b text[]; i int;
begin
  d := pg_get_functiondef('hq.resolve_line(text)'::regprocedure);
  a := array[
    $a$    v_tail := regexp_replace(substr(v_text, length(v_head) + 1), '[()]', ' ', 'g');$a$,
    $a$(k = 'standard' and s.code in ('small', 'standard')))$a$];
  b := array[
    $b$    v_tail := regexp_replace(regexp_replace(substr(v_text, length(v_head) + 1), '\)\s*\(', ', ', 'g'), '[()]', ' ', 'g');$b$,
    $b$(k = 'standard' and s.code in ('small', 'standard')) or (k = 'small' and s.code = 'standard'))$b$];
  for i in 1..2 loop
    if position(b[i] in d) > 0 then continue; end if;
    if position(a[i] in d) = 0 then raise exception 'resolve_line: patch point % not found', i; end if;
    d := replace(d, a[i], b[i]);
  end loop;
  execute d;

  d := pg_get_functiondef('hq.line_variant(text,text)'::regprocedure);
  if position($a$split_part(v.inventory_name, ' (', 1)$a$ in d) > 0 then
    execute replace(d, $a$split_part(v.inventory_name, ' (', 1)$a$, $b$regexp_replace(v.inventory_name, '\s*\(([^()]|\([^()]*\))*\)\s*$', '')$b$);
  elsif position('regexp_replace(v.inventory_name' in d) = 0 then raise exception 'line_variant: patch point not found';
  end if;

  d := pg_get_functiondef('hq.pick_variant(jsonb,text)'::regprocedure);
  if position($a$split_part(v.inventory_name, ' (', 1)$a$ in d) > 0 then
    d := replace(d, $a$split_part(v.inventory_name, ' (', 1)$a$, $b$regexp_replace(v.inventory_name, '\s*\(([^()]|\([^()]*\))*\)\s*$', '')$b$);
  elsif position('regexp_replace(v.inventory_name' in d) = 0 then raise exception 'pick_variant: name patch point not found';
  end if;
  if position($x$(p->>'offer')$x$ in d) = 0 then
    a := array[
      $a$    return jsonb_build_object('status', 'unresolved', 'reason', 'color not offered', 'add', jsonb_build_object('product', pr.name,$a$,
      $a$'color_1', (select name from hq.colors where id = v_c1), 'color_2', (select name from hq.colors where id = v_c2)));
  end if;$a$];
    b := array[
      $b$    if coalesce((p->>'offer')::boolean, false) then
      -- a person picked this color on the order form: that is the decision to make it, so the color is recorded as offered
      if v_make then
        insert into hq.product_colors (product_id, slot, color_id, source, added_by) values (pr.id, 1, v_c1, 'added', p_by) on conflict do nothing;
        if v_c2 is not null then
          insert into hq.product_colors (product_id, slot, color_id, source, added_by) values (pr.id, 2, v_c2, 'added', p_by) on conflict do nothing;
        end if;
      end if;
    else
    return jsonb_build_object('status', 'unresolved', 'reason', 'color not offered', 'add', jsonb_build_object('product', pr.name,$b$,
      $b$'color_1', (select name from hq.colors where id = v_c1), 'color_2', (select name from hq.colors where id = v_c2)));
    end if;
  end if;$b$];
    for i in 1..2 loop
      if position(a[i] in d) = 0 then raise exception 'pick_variant: patch point % not found', i; end if;
      d := replace(d, a[i], b[i]);
    end loop;
  end if;
  execute d;
end $patch$;

create or replace function hq.rematch_open_lines(p_by text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare r record; l record; v_res jsonb; v_var bigint; v_match text; v_prev jsonb; v_lines jsonb; v_done jsonb := '[]'; v_by text := coalesce(p_by, 'rematch');
begin
  for r in select o.id from orders o
            where o.status <> 'Done' and o.deleted_at is null
              and exists (select 1 from order_lines x where x.order_id = o.id and x.match = 'unmatched')
            order by o.ship_by nulls last, o.id
            for update of o skip locked          -- an order someone is saving right now is matched by that save
  loop
    v_prev := null; v_lines := '[]';
    for l in select x.uid, x.text from order_lines x where x.order_id = r.id and x.match = 'unmatched' order by x.line_no loop
      v_res := hq.resolve_line(l.text);
      continue when v_res->>'status' not in ('variant', 'untracked', 'creatable');
      -- a variation that failed to be made is not retried on every save (it is in app_log as variant_auto_failed)
      continue when v_res->>'status' = 'creatable' and exists (select 1 from app_log g where g.kind = 'variant_auto_failed' and g.data->>'text' = l.text and g.at > now() - interval '1 day');
      select lv.variant_id, lv.match into v_var, v_match from hq.line_variant(l.text, v_by) lv;
      continue when v_match = 'unmatched';
      if v_prev is null then v_prev := hq.order_json(r.id); end if;
      update order_lines x set variant_id = v_var, match = v_match, conflict = hq.line_check(x.text, v_var) where x.uid = l.uid and x.match = 'unmatched';
      v_lines := v_lines || jsonb_build_object('uid', l.uid, 'text', l.text, 'variant_id', v_var, 'match', v_match, 'how', v_res->>'status');
    end loop;
    if v_prev is not null then
      update orders o set version = o.version + 1 where o.id = r.id;
      insert into order_history (order_id, op_id, source, before, after, by_user)
      values (r.id, 'rematch-' || replace(gen_random_uuid()::text, '-', ''), 'hq', v_prev, hq.order_json(r.id), v_by);
      v_done := v_done || jsonb_build_object('order_id', r.id, 'lines', v_lines);
    end if;
  end loop;
  if jsonb_array_length(v_done) > 0 then
    insert into app_log (op_id, kind, data, by_user)
    values ('rematch-' || replace(gen_random_uuid()::text, '-', ''), 'rematch', jsonb_build_object('orders', v_done), v_by);
  end if;
  return jsonb_build_object('orders', jsonb_array_length(v_done), 'matched', v_done);
end $function$;

-- Runs once per save, after everything else in it, and can never fail the save: a problem is logged as rematch_failed.
create or replace function hq.rematch_after_change()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
begin
  if coalesce(current_setting('hq.rematch_done', true), '') = txid_current()::text then return null; end if;
  perform set_config('hq.rematch_done', txid_current()::text, true);
  begin
    perform hq.rematch_open_lines(null);
  exception when others then
    insert into app_log (op_id, kind, data) values ('rematch-' || replace(gen_random_uuid()::text, '-', ''), 'rematch_failed', jsonb_build_object('error', sqlerrm));
  end;
  return null;
end $function$;
revoke execute on function hq.rematch_after_change() from public, anon, authenticated;
grant execute on function hq.rematch_open_lines(text) to authenticated;

create constraint trigger rematch_lines after insert or update on hq.variants deferrable initially deferred for each row execute function hq.rematch_after_change();
create constraint trigger rematch_lines after insert or update on hq.line_aliases deferrable initially deferred for each row execute function hq.rematch_after_change();
create constraint trigger rematch_lines after update on hq.products deferrable initially deferred for each row execute function hq.rematch_after_change();
create constraint trigger rematch_lines after insert on hq.product_colors deferrable initially deferred for each row execute function hq.rematch_after_change();
create constraint trigger rematch_lines after insert or update on hq.product_sizes deferrable initially deferred for each row execute function hq.rematch_after_change();
create constraint trigger rematch_lines after insert or update on hq.collection_pieces deferrable initially deferred for each row execute function hq.rematch_after_change();
create constraint trigger rematch_lines after insert or update on hq.colors deferrable initially deferred for each row execute function hq.rematch_after_change();
