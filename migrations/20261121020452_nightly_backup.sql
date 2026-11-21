-- Nightly backup inside the database (Nov 20, 2026).
--
-- Why: the project is on the Free plan (no built-in backups) and the only backup was the Backup button, which
-- someone has to remember to press. This takes a full copy of every hq table every night without anyone doing anything.
--
-- What it is: hq_nightly.take() copies every table in hq, one jsonb document per table, into hq_nightly.snapshot_tables.
--   * All hq tables are locked against writes for the few seconds it runs, so the copy is one consistent moment
--     (an order and its lines can't be caught half-saved).
--   * Every table is checked straight away: the copy is turned back into rows and compared with the live table, both ways.
--     A snapshot is marked verified only when every table comes back identical.
--   * The newest 14 snapshots are kept (about 5 MB each today). Older ones are removed only after a new verified one exists.
--   * It is logged in hq.app_log as backup_nightly, or backup_nightly_failed with the error. A failure never raises.
--
-- What it is not: a copy outside this Supabase project. It protects against a bad edit, a bad migration or a bad import.
-- It does not protect against losing the project itself. The off-site copy (pg_dump to a private repo) is still to do.
--
-- Restore: hq_nightly.restore_to_schema(snapshot id, 'restore_<name>') rebuilds every table of a snapshot in a side schema,
-- where it can be inspected and copied back by hand. It never touches hq.

create schema if not exists hq_nightly;
revoke all on schema hq_nightly from public;
revoke all on schema hq_nightly from anon, authenticated;

create table if not exists hq_nightly.snapshots (
  id bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  migration text,
  counts jsonb not null default '{}'::jsonb,
  bytes bigint not null default 0,
  verified boolean not null default false,
  problems jsonb not null default '[]'::jsonb,
  note text
);

create table if not exists hq_nightly.snapshot_tables (
  snapshot_id bigint not null references hq_nightly.snapshots (id) on delete cascade,
  table_name text not null,
  n integer not null,
  rows jsonb not null,
  primary key (snapshot_id, table_name)
);

alter table hq_nightly.snapshots enable row level security;
alter table hq_nightly.snapshot_tables enable row level security;
revoke all on all tables in schema hq_nightly from public;
revoke all on all tables in schema hq_nightly from anon, authenticated;

create or replace function hq_nightly.take(p_keep integer default 14, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  t record;
  v_id bigint;
  v_rows jsonb;
  v_n integer;
  v_diff bigint;
  v_counts jsonb := '{}'::jsonb;
  v_bad jsonb := '[]'::jsonb;
  v_bytes bigint := 0;
  v_migration text;
  v_locks text;
  v_removed integer := 0;
  v_out jsonb;
begin
  begin
    perform set_config('lock_timeout', '15s', true);

    select string_agg(format('hq.%I', c.relname), ', ' order by c.relname) into v_locks
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'hq' and c.relkind in ('r', 'p');
    if v_locks is null then raise exception 'no tables found in hq'; end if;
    execute 'lock table ' || v_locks || ' in share mode';

    select max(version) into v_migration from supabase_migrations.schema_migrations;
    insert into hq_nightly.snapshots (migration, note) values (v_migration, p_note) returning id into v_id;

    for t in
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'hq' and c.relkind in ('r', 'p') order by c.relname
    loop
      execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from hq.%I x', t.relname) into v_rows;
      v_n := jsonb_array_length(v_rows);
      insert into hq_nightly.snapshot_tables (snapshot_id, table_name, n, rows) values (v_id, t.relname, v_n, v_rows);
      v_counts := v_counts || jsonb_build_object(t.relname, v_n);
      v_bytes := v_bytes + pg_column_size(v_rows);

      -- round trip: the copy, turned back into rows of this table, must equal the live table in both directions
      execute format(
        'select count(*) from ('
        || '(select to_jsonb(r) from jsonb_populate_recordset(null::hq.%1$I, $1) r except select to_jsonb(x) from hq.%1$I x)'
        || ' union all '
        || '(select to_jsonb(x) from hq.%1$I x except select to_jsonb(r) from jsonb_populate_recordset(null::hq.%1$I, $1) r)'
        || ') d', t.relname)
      into v_diff using v_rows;
      if v_diff > 0 then v_bad := v_bad || jsonb_build_object('table', t.relname, 'rows', v_diff); end if;
    end loop;

    update hq_nightly.snapshots
    set counts = v_counts, bytes = v_bytes, verified = (v_bad = '[]'::jsonb), problems = v_bad
    where id = v_id;

    -- older snapshots go only once a new verified one exists
    if v_bad = '[]'::jsonb then
      with gone as (
        delete from hq_nightly.snapshots
        where id in (select id from hq_nightly.snapshots order by id desc offset greatest(coalesce(p_keep, 14), 1))
        returning 1
      ) select count(*) into v_removed from gone;
    end if;

    v_out := jsonb_build_object('ok', v_bad = '[]'::jsonb, 'snapshot', v_id, 'tables', (select count(*) from jsonb_object_keys(v_counts)),
                                'bytes', v_bytes, 'migration', v_migration, 'problems', v_bad, 'removed', v_removed, 'counts', v_counts);
    insert into hq.app_log (op_id, kind, data, by_user)
    values ('nightly-' || gen_random_uuid(), case when v_bad = '[]'::jsonb then 'backup_nightly' else 'backup_nightly_failed' end,
            case when v_bad = '[]'::jsonb then v_out else v_out || jsonb_build_object('error', 'copy does not match the live tables') end, 'nightly');
    return v_out;
  exception when others then
    -- everything above is undone; say so where people look
    v_out := jsonb_build_object('ok', false, 'error', sqlerrm, 'state', sqlstate);
    insert into hq.app_log (op_id, kind, data, by_user)
    values ('nightly-' || gen_random_uuid(), 'backup_nightly_failed', v_out, 'nightly');
    return v_out;
  end;
end
$fn$;

create or replace function hq_nightly.restore_to_schema(p_snapshot bigint, p_schema text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  t record;
  v_n bigint;
  v_counts jsonb := '{}'::jsonb;
begin
  if p_schema is null or p_schema !~ '^restore_[a-z0-9_]{1,40}$' then
    raise exception 'the target schema must be named restore_<name> (lower case letters, digits, underscore)';
  end if;
  if exists (select 1 from pg_namespace where nspname = p_schema) then
    raise exception 'schema % already exists', p_schema;
  end if;
  if not exists (select 1 from hq_nightly.snapshots where id = p_snapshot) then
    raise exception 'snapshot % not found', p_snapshot;
  end if;

  execute format('create schema %I', p_schema);
  execute format('revoke all on schema %I from public', p_schema);

  for t in select table_name, rows from hq_nightly.snapshot_tables where snapshot_id = p_snapshot order by table_name loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'hq' and c.relname = t.table_name and c.relkind in ('r', 'p')) then
      -- the table no longer exists in hq: keep its rows as they were saved
      execute format('create table %I.%I (row_data jsonb)', p_schema, t.table_name);
      execute format('insert into %I.%I select e from jsonb_array_elements($1) e', p_schema, t.table_name) using t.rows;
    else
      execute format('create table %I.%I (like hq.%I)', p_schema, t.table_name, t.table_name);
      execute format('insert into %I.%I select * from jsonb_populate_recordset(null::hq.%I, $1)', p_schema, t.table_name, t.table_name) using t.rows;
    end if;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(t.table_name, v_n);
  end loop;

  return jsonb_build_object('snapshot', p_snapshot, 'schema', p_schema, 'counts', v_counts);
end
$fn$;

revoke all on function hq_nightly.take(integer, text) from public;
revoke all on function hq_nightly.take(integer, text) from anon, authenticated;
revoke all on function hq_nightly.restore_to_schema(bigint, text) from public;
revoke all on function hq_nightly.restore_to_schema(bigint, text) from anon, authenticated;

-- what the app reads to warn when the nightly copy is missing, late or failed (signed-in users only)
create or replace function hq.backup_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'last_at', s.taken_at,
    'age_hours', round((extract(epoch from (now() - s.taken_at)) / 3600.0)::numeric, 1),
    'kept', (select count(*) from hq_nightly.snapshots),
    'bytes', s.bytes,
    'failed', (select jsonb_build_object('at', l.at, 'error', l.data ->> 'error')
               from hq.app_log l where l.kind = 'backup_nightly_failed' and l.at > s.taken_at order by l.id desc limit 1)
  ) into v
  from hq_nightly.snapshots s where s.verified order by s.id desc limit 1;
  if v is null then
    v := jsonb_build_object('last_at', null, 'kept', 0,
      'failed', (select jsonb_build_object('at', l.at, 'error', l.data ->> 'error')
                 from hq.app_log l where l.kind = 'backup_nightly_failed' order by l.id desc limit 1));
  end if;
  return v;
end
$fn$;

revoke all on function hq.backup_status() from public;
revoke all on function hq.backup_status() from anon;
grant execute on function hq.backup_status() to authenticated, service_role;
