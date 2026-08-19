-- CREATE EXTENSION btree_gist (20260819052514) installed ~150 GiST
-- operator support functions into public — and, per that extension's own
-- installation script, granted EXECUTE on all of them to PUBLIC (which
-- implicitly covers anon/authenticated/service_role, since PUBLIC means
-- "everyone"). Found by tests/security-grants-regression.test.ts on DEV:
-- "authenticated's function execute grants exactly match the whitelist"
-- and the equivalent anon/PUBLIC/service_role checks all failed with
-- ~150 unexpected gbt_*/*_dist/gbtreekey* entries.
--
-- Same class of finding as Faz 1.9 (Supabase's own project bootstrap
-- silently grants broad access outside any migration) — here it's a
-- Postgres extension's bootstrap doing the same thing. Safe to revoke
-- unconditionally: these are GiST operator-class support functions,
-- invoked by the query executor's internal index machinery when
-- evaluating appointment_items_no_staff_overlap, not through a
-- caller-facing EXECUTE check — nothing in this project ever calls
-- gbt_int4_compress() or similar directly, by design.
--
-- Enumerated dynamically via pg_depend (deptype = 'e' = "member of an
-- extension") rather than hand-listed, so this stays correct if
-- btree_gist's own function set ever changes across a Postgres version.
do $$
declare
  v_func record;
begin
  for v_func in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_depend d
    join pg_extension e on e.oid = d.refobjid
    join pg_proc p on p.oid = d.objid
    join pg_namespace n on n.oid = p.pronamespace
    where e.extname = 'btree_gist'
      and d.deptype = 'e'
      and n.nspname = 'public'
  loop
    execute format(
      'revoke execute on function public.%I(%s) from public, anon, authenticated, service_role',
      v_func.proname, v_func.args
    );
  end loop;
end $$;
