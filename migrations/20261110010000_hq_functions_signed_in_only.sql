-- Signed-in only: no hq function can be run by PUBLIC or anon.
-- 22 functions still had Postgres's default "PUBLIC can execute" (anon included). anon has no usage on schema hq,
-- so none were reachable signed-out, but one schema grant away from being open. Signed-in (authenticated) and
-- service_role keep exactly the access they had; only PUBLIC/anon lose it.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'hq' and has_function_privilege('public', p.oid, 'execute')
  loop
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;

-- New functions in hq: callable by signed-in users, never by PUBLIC/anon, without each migration having to say so.
-- Postgres's built-in PUBLIC execute can only be removed globally (a per-schema revoke has no effect);
-- schema public keeps Supabase's explicit grants, so its functions are unchanged.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema hq grant execute on functions to authenticated, service_role;
