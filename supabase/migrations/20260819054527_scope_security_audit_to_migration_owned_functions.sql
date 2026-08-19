-- CREATE EXTENSION btree_gist (20260819052514) installed ~150 GiST
-- operator support functions into public, owned by supabase_admin (the
-- role Supabase's platform runs CREATE EXTENSION as internally), with
-- EXECUTE granted to PUBLIC as part of the extension's own install
-- script — outside migration control, same class of platform-bootstrap
-- artifact as the anon/authenticated table-grant default found in Faz
-- 1.5 and rls_auto_enable found in Faz 1.9's PROD parity check.
--
-- Confirmed NOT fixable by revoking here: `postgres` (the role every
-- migration runs as) is not the owner and gets `42501: must be owner of
-- function` on both REVOKE and ALTER OWNER. Confirmed harmless to leave
-- granted: functions taking an `internal`-typed argument (most of them)
-- cannot be invoked via any SQL client at all —
-- `ERROR 0A000: cannot accept a value of type internal` — verified
-- directly. The remainder (int4_dist, cash_dist, date_dist, ...) are
-- pure, stateless, side-effect-free comparison functions with no table
-- access — calling int4_dist(5, 10) is exactly as harmless as calling
-- abs(5 - 10). Relocating the extension to the `extensions` schema
-- doesn't help either — anon/authenticated already hold USAGE there by
-- Supabase's own default, confirmed via has_schema_privilege().
--
-- security_audit_function_grants()/security_audit_functions() exist to
-- hold OUR migrations accountable for exactly-the-right grants — an
-- object neither owned nor grantable by postgres was never something a
-- migration could have controlled, so it was never meaningfully in
-- scope. Narrowing to proowner = postgres makes that scope explicit
-- instead of accidentally catching platform-installed extension noise.
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
    and pg_get_userbyid(p.proowner) = 'postgres'
  order by n.nspname, p.proname, a.grantee, a.privilege_type;
$$;

-- Reproduces 20260816090005's original 6-column shape exactly (arguments,
-- owner_role included) — CREATE OR REPLACE cannot change an existing
-- function's return columns, and this migration's only actual change is
-- the added proowner filter in the WHERE clause below.
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
    and pg_get_userbyid(p.proowner) = 'postgres'
  order by n.nspname, p.proname;
$$;

revoke execute on function public.security_audit_function_grants() from public, anon, authenticated;
revoke execute on function public.security_audit_functions() from public, anon, authenticated;
