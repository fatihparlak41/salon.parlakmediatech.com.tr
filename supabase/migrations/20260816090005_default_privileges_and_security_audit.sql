-- Faz 1.5: from here on, a newly created function in public/private does
-- NOT automatically get PUBLIC execute (Postgres's actual default) —
-- every future function needs an explicit grant, matching the pattern
-- already used by hand in every migration so far. Scoped to the role that
-- runs migrations (the session executing this statement), so it applies
-- to `db push` going forward without needing FOR ROLE.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

-- Read-only operator diagnostics — deliberately public schema (private.*
-- is not reachable via RPC at all, see 20260815120014, and that's exactly
-- why these live here instead) but with no grant to anon/authenticated:
-- only service_role can call them. Not part of the app's client-facing
-- API surface; re-run these after any future migration that touches
-- functions, grants or RLS.

create or replace function public.security_audit_functions()
returns table (
  schema_name text,
  function_name text,
  arguments text,
  is_security_definer boolean,
  search_path_setting text,
  owner_role text
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    n.nspname::text,
    p.proname::text,
    pg_get_function_identity_arguments(p.oid),
    p.prosecdef,
    (
      select string_agg(cfg, ', ')
      from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
      where cfg like 'search_path=%'
    ),
    pg_get_userbyid(p.proowner)::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
  order by n.nspname, p.proname;
$$;

create or replace function public.security_audit_function_grants()
returns table (
  schema_name text,
  function_name text,
  grantee text,
  privilege_type text
)
language sql
security definer
stable
set search_path = ''
as $$
  select r.routine_schema, r.routine_name, rp.grantee, rp.privilege_type
  from information_schema.routines r
  join information_schema.routine_privileges rp
    on rp.routine_schema = r.routine_schema and rp.routine_name = r.routine_name
  where r.routine_schema in ('public', 'private')
  order by r.routine_schema, r.routine_name, rp.grantee;
$$;

create or replace function public.security_audit_table_grants()
returns table (
  schema_name text,
  table_name text,
  grantee text,
  privilege_type text
)
language sql
security definer
stable
set search_path = ''
as $$
  select table_schema, table_name, grantee, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
  order by table_name, grantee, privilege_type;
$$;

create or replace function public.security_audit_rls_status()
returns table (
  schema_name text,
  table_name text,
  rls_enabled boolean,
  rls_forced boolean,
  policy_count bigint
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    n.nspname::text,
    c.relname::text,
    c.relrowsecurity,
    c.relforcerowsecurity,
    (
      select count(*) from pg_policies pol
      where pol.schemaname = n.nspname and pol.tablename = c.relname
    )
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname;
$$;

revoke execute on function public.security_audit_functions() from public;
revoke execute on function public.security_audit_function_grants() from public;
revoke execute on function public.security_audit_table_grants() from public;
revoke execute on function public.security_audit_rls_status() from public;
