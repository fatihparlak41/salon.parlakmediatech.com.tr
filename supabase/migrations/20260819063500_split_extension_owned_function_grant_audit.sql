-- Phase 2A.1 review: the Phase 2A report claimed "PUBLIC function grants =
-- 0" unqualified. That was only ever true for migration/application-owned
-- functions — 20260819054527 scoped security_audit_function_grants() to
-- proowner = 'postgres' specifically because btree_gist's ~150-188
-- extension-installed functions (owned by supabase_admin, granted to
-- PUBLIC by the extension's own install script, not fixable — see that
-- migration's comment) would otherwise permanently fail it. The scoping
-- was correct; the REPORTING was not precise about what it excluded and
-- why, which reads as quietly making the audit green rather than
-- explaining its boundary.
--
-- This adds the other half explicitly: a SEPARATE audit function that
-- reports ONLY extension-owned PUBLIC grants (via pg_depend, deptype =
-- 'e' — "this object is owned by this extension" — not by ownership role,
-- which is a proxy that happens to work today but isn't what the
-- exclusion is actually about). Tests assert two independent things: (A)
-- security_audit_function_grants() [migration-owned] stays at zero, same
-- as before — a new application function that picks up a PUBLIC grant
-- still fails the suite; (B) every row from this new function belongs to
-- a NAME on an explicit allowlist (today: only 'btree_gist') — so an
-- entirely different extension being installed later, or something
-- non-extension-owned slipping through, is still caught, not silently
-- lumped in with the known baseline.
create or replace function public.security_audit_extension_function_grants()
returns table (
  schema_name text,
  function_name text,
  extension_name text,
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
    e.extname::text,
    (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)::text,
    a.privilege_type
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_depend d on d.objid = p.oid and d.deptype = 'e'
  join pg_extension e on e.oid = d.refobjid
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
  where n.nspname in ('public', 'private')
  order by e.extname, n.nspname, p.proname, a.grantee, a.privilege_type;
$$;

comment on function public.security_audit_extension_function_grants() is
  'The explicit companion to security_audit_function_grants(): reports PUBLIC/other grants on functions owned by a Postgres EXTENSION (pg_depend deptype=''e''), not by this project''s migrations. Never expected to be empty — see tests/security-grants-regression.test.ts for the allowlist this is checked against. Read security_audit_function_grants()''s own comment for why postgres cannot revoke these.';

revoke execute on function public.security_audit_extension_function_grants() from public, anon, authenticated;
