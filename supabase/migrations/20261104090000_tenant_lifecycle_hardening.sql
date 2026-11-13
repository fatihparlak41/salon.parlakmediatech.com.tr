-- Faz SAAS.1C.2a (1/3) - tenant lifecycle hardening.
--
-- THE HOLE (found by the SAAS.1C.2 discovery, proven on the PROD-parity schema): `authenticated` held UPDATE on public.tenants as a whole table,
-- the only control was the RLS policy `tenants_update_settings_manage` (settings.manage OR any platform admin) and there was no column guard.
-- So a salon Owner could set tenants.status back to 'active' on a suspended salon, clear deleted_at, rename the slug (breaking its public booking
-- URL) and change name/created_by, and ANY platform admin - including the `support` role - could do the same to any tenant, with no audit.
-- The derived access mode `blocked` (suspended / canceled / deleted) is built from exactly those columns.
--
-- THE FIX (three independent layers):
--   1. column privileges: authenticated may UPDATE only the genuine salon-profile columns (name, timezone, currency, the two customer self-service
--      policies). status, deleted_at, slug, trial_ends_at, created_by, created_at, id, updated_at and the new lifecycle_version are platform-controlled.
--   2. the RLS policy no longer lets a platform admin write tenants. Platform-admin AUTHORIZATION (read access) is unchanged; a mutation authority is
--      the platform OWNER acting through the audited RPCs added in the next migration.
--   3. a BEFORE UPDATE guard trigger refuses any change to the platform-controlled columns unless it comes from the sanctioned RPC (a transaction-local
--      marker) or from an operator session (postgres / supabase_admin: migrations, backups, the break-glass procedure). It also owns the new
--      tenants.lifecycle_version counter (bumped whenever status or deleted_at changes), which the RPCs use for stale-write detection.
-- Existing salon-profile editing keeps working: update_salon_profile is SECURITY DEFINER and only touches name, timezone, currency; the settings page
-- only updates the four policy columns that stay granted.
--
-- No data is changed. Existing tenants: lifecycle_version starts at 1.
--
-- ROLLBACK (see the 1C.2a rollback script): drop the trigger and its function, drop the column, restore the policy and the table-level UPDATE grant.

alter table public.tenants add column if not exists lifecycle_version integer not null default 1;
comment on column public.tenants.lifecycle_version is
  'Revision of the platform-controlled lifecycle columns (status, deleted_at). Maintained by the tenants_lifecycle_guard trigger; compared by the owner-only lifecycle RPC (expected_version).';

-- 1. column privileges ------------------------------------------------------------------------------------------------------------------------
revoke update on public.tenants from authenticated;
grant update (name, timezone, currency, customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled, customer_reschedule_cutoff_minutes)
  on public.tenants to authenticated;

-- 2. the policy: a salon member with settings.manage only (no platform-admin write path) ------------------------------------------------------
drop policy if exists tenants_update_settings_manage on public.tenants;
create policy tenants_update_settings_manage on public.tenants
  for update to authenticated
  using (private.has_permission(id, 'settings.manage'))
  with check (private.has_permission(id, 'settings.manage'));

-- 3. the guard trigger ------------------------------------------------------------------------------------------------------------------------
create or replace function private.tenants_lifecycle_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
     or new.status is distinct from old.status
     or new.deleted_at is distinct from old.deleted_at
     or new.slug is distinct from old.slug
     or new.trial_ends_at is distinct from old.trial_ends_at
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    -- operator sessions (migrations, backups, break-glass) are the only direct writers; every API-reachable path (authenticator / service_role /
    -- SECURITY DEFINER functions called from them) must come through the sanctioned RPC, which sets the transaction-local marker.
    if session_user not in ('postgres', 'supabase_admin')
       and coalesce(current_setting('salonos.sanctioned_lifecycle', true), 'off') <> 'on' then
      raise exception 'tenant_lifecycle_protected' using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status or new.deleted_at is distinct from old.deleted_at then
    new.lifecycle_version := old.lifecycle_version + 1;
  else
    new.lifecycle_version := old.lifecycle_version;
  end if;
  return new;
end;
$function$;

revoke all on function private.tenants_lifecycle_guard() from public, anon, authenticated, service_role;

drop trigger if exists tenants_lifecycle_guard on public.tenants;
create trigger tenants_lifecycle_guard
  before update on public.tenants
  for each row execute function private.tenants_lifecycle_guard();
