-- Faz 1.5 follow-up, found while writing the standing
-- tests/security-grants-regression.test.ts guard: security_audit_
-- function_grants()/table_grants() (20260816090005) were built on
-- information_schema.routine_privileges/role_table_grants, which wrap an
-- expensive whole-catalog visibility check per grantee per object —
-- information_schema.routine_privileges intermittently hit statement
-- timeout under this project's connection pooler even with only ~25
-- functions in public+private, because the view still has to consider
-- every routine in the database (including the few thousand pg_catalog
-- builtins) before filtering down. Rewritten to query pg_proc/pg_class
-- directly via aclexplode() — the standard low-level approach, and the
-- one pg_catalog itself uses internally.
--
-- CREATE OR REPLACE FUNCTION preserves an existing function's grants as
-- long as the signature is unchanged, so security_audit_function_grants
-- and security_audit_table_grants keep their existing "service_role
-- only" ACL from 20260816090005/090006 through this replace. The
-- explicit revokes below are redundant with that but kept for the same
-- reason every migration in this project states its grants explicitly
-- rather than relying on inherited state.

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
  select
    n.nspname::text,
    p.proname::text,
    (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)::text,
    a.privilege_type
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
  where n.nspname in ('public', 'private')
  order by n.nspname, p.proname, a.grantee, a.privilege_type;
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
  select
    n.nspname::text,
    c.relname::text,
    (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)::text,
    a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as a
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname, a.grantee, a.privilege_type;
$$;

-- New: table-level ACLs (above) never surface column-restricted grants —
-- Postgres stores those separately on pg_attribute.attacl, and
-- tenant_memberships.status (20260816090002/090006) is exactly that case
-- (`grant update (status) ... to authenticated`, deliberately narrower
-- than a table-level UPDATE). Only returns columns that actually carry
-- an explicit column-level ACL, i.e. only the deliberate exceptions.
create or replace function public.security_audit_column_grants()
returns table (
  schema_name text,
  table_name text,
  column_name text,
  grantee text,
  privilege_type text
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    n.nspname::text,
    c.relname::text,
    att.attname::text,
    (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)::text,
    a.privilege_type
  from pg_attribute att
  join pg_class c on c.oid = att.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(att.attacl) as a
  where n.nspname = 'public'
    and c.relkind = 'r'
    and att.attnum > 0
    and not att.attisdropped
    and att.attacl is not null
  order by c.relname, att.attname, a.grantee, a.privilege_type;
$$;

revoke execute on function public.security_audit_function_grants() from public, anon, authenticated;
revoke execute on function public.security_audit_table_grants() from public, anon, authenticated;
revoke execute on function public.security_audit_column_grants() from public, anon, authenticated;
