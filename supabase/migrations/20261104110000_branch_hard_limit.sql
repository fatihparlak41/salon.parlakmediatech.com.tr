-- Faz SAAS.1C.2a (3/3) - the one-branch HARD limit becomes a real database rule.
--
-- Until now plan_limits (max_branches = 1, hard) was display-only: `authenticated` holds INSERT on public.branches (policy branches_insert_settings_manage,
-- settings.manage) and nothing stopped a second branch, although the product has no multi-branch behaviour. This migration enforces it for every
-- API-reachable path: direct table INSERT / UPDATE through PostgREST, the service-role client, SECURITY DEFINER functions called from them and the
-- public-booking gateway role. Operator sessions (postgres / supabase_admin: migrations, backups, the break-glass procedure) are exempt, exactly like the
-- tenant lifecycle guard.
--
-- "Active" means deleted_at IS NULL (branches have no other status). The limit comes from plan_limits (hard max_branches) and falls back to 1 when a
-- tenant has no subscription row. Concurrency: the trigger locks the TENANT row (SELECT ... FOR UPDATE) before counting, so two concurrent creations
-- for the same tenant serialize and the second sees the first's committed row. Cross-tenant creations never block each other.
--
-- Existing data is never touched: the trigger fires on INSERT and on the two columns that could make a branch active (deleted_at, tenant_id). A tenant
-- that already has more than one active branch can keep editing them (an UPDATE of an already-active branch that does not change deleted_at /
-- tenant_id is not a new active branch), it just cannot add another.
--
-- The STAFF limit stays SOFT by decision; nothing here touches it.
-- ROLLBACK: drop trigger branches_hard_limit on public.branches; drop function private.enforce_branch_hard_limit().

create or replace function private.enforce_branch_hard_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer;
  v_count integer;
begin
  if session_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  -- only a row that is (or becomes) an ACTIVE branch of this tenant can exceed the limit
  if new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is null and old.tenant_id = new.tenant_id then
    return new;
  end if;

  perform 1 from public.tenants t where t.id = new.tenant_id for update;

  select pl.limit_value into v_limit
    from public.subscriptions s
    join public.plan_limits pl on pl.plan_id = s.plan_id and pl.limit_key = 'max_branches' and pl.enforcement = 'hard'
   where s.tenant_id = new.tenant_id;
  v_limit := coalesce(v_limit, 1);

  select count(*) into v_count
    from public.branches b
   where b.tenant_id = new.tenant_id and b.deleted_at is null and b.id <> new.id;

  if v_count >= v_limit then
    raise exception 'branch_limit_reached' using errcode = 'P0001', hint = 'The plan allows a single active branch.';
  end if;
  return new;
end;
$function$;

revoke all on function private.enforce_branch_hard_limit() from public, anon, authenticated, service_role;

drop trigger if exists branches_hard_limit on public.branches;
create trigger branches_hard_limit
  before insert or update of deleted_at, tenant_id on public.branches
  for each row execute function private.enforce_branch_hard_limit();
