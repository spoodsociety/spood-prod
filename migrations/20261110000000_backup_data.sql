-- Download backup: every table in schema hq as one JSON document, for the Inventory "Backup" button.
-- Tables are listed from the catalog at run time, so a table added later is included without a change here.
-- The functions and migrations live in this repo; this file plus the repo is a full rebuild.
create or replace function hq.backup_data(p_by text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'hq', 'pg_temp'
as $function$
declare
  t record;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_migration text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;

  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'hq' and c.relkind in ('r', 'p') order by c.relname
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from hq.%I x', t.relname) into v_rows;
    v_tables := v_tables || jsonb_build_object(t.relname, v_rows);
    v_counts := v_counts || jsonb_build_object(t.relname, jsonb_array_length(v_rows));
  end loop;

  select max(version) into v_migration from supabase_migrations.schema_migrations;

  insert into app_log (op_id, kind, data, by_user)
  values ('backup-' || gen_random_uuid(), 'backup_downloaded', jsonb_build_object('counts', v_counts, 'migration', v_migration), p_by);

  return jsonb_build_object(
    'format', 'spood-hq-backup/1',
    'project', 'hkllbpipcfzzppbgkzrh',
    'schema', 'hq',
    'taken_at', now(),
    'by', p_by,
    'migration', v_migration,
    'counts', v_counts,
    'tables', v_tables
  );
end $function$;

revoke all on function hq.backup_data(text) from public, anon;
grant execute on function hq.backup_data(text) to authenticated;
