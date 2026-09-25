-- Faz SAAS.1E.1 staged release — the release-gate table and its shared
-- assertion helper, plus every EXISTING (already-on-PROD) membership-
-- activation path this gate must also cover.
--
-- =====================================================================
-- WHY THIS EXISTS, AND WHY IT IS BROADER THAN "the three new role keys"
-- =====================================================================
--
-- A first version of this gate only blocked create_team_invitation from
-- targeting SALON_MANAGER/RECEPTIONIST/STYLIST by KEY. Review found two real
-- bypasses:
--
--   1. Role-KEY matching is wrong in principle: a tenant's own pre-existing
--      CUSTOM role (created under SAAS.1E.0, before this release existed)
--      has a different key but can carry the exact same low authority a
--      Personel would — the gate must be about EFFECTIVE PERMISSIONS
--      (specifically: does the role hold permissions.manage_unrestricted),
--      never about which literal key a role happens to have.
--   2. Gating ONLY invitation creation leaves every OTHER membership-
--      activation path wide open: an Owner can invite a SECOND Owner (an
--      unrestricted-to-unrestricted invite, never blocked by any version of
--      this gate), have it accepted, and then call update_membership_role
--      to move that brand-new membership down to Personel — a completely
--      different RPC, never touched by the invitation-side check at all.
--      reactivate_membership (bringing a SUSPENDED membership back to
--      'active') is the same shape of gap: a membership already holding a
--      non-unrestricted role could be reactivated during the gate-closed
--      window even though it was never activated FRESH.
--
-- The fix: ONE shared assertion, called from every path that can result in
-- an ACTIVE membership holding a non-unrestricted role — invitation
-- acceptance, a role change, and reactivation — never from paths that only
-- affect an ALREADY-ACTIVE membership's continued operation (has_permission
-- checks elsewhere are completely unaffected; an existing Personel keeps
-- working normally). Unrestricted roles are always exempt: Owner-level
-- access, and normal tenant creation (which only ever creates an
-- unrestricted Owner membership), are never touched by this gate at any
-- point.
--
-- update_membership_role and reactivate_membership are ALREADY on PROD
-- (20260921092226 and 20260921061657 respectively, both part of the 101
-- migrations already live) — this migration's CREATE OR REPLACE bodies are
-- copied byte-for-byte from those live definitions with exactly one
-- addition each (the new assertion call), same pattern this whole phase
-- has already used for has_permission/caller_permission_keys.

create table if not exists private.release_gates (
  key text primary key,
  enabled boolean not null default false,
  enabled_at timestamptz
);
comment on table private.release_gates is
  'Platform-wide (not per-tenant) release-sequencing flags for staged migrations. private schema: no grant to anon/authenticated — never client-readable or client-writable, flipped only by a later migration''s own DDL.';

insert into private.release_gates (key, enabled)
values ('saas_1e1_non_owner_roles_safe', false)
on conflict (key) do nothing;

create or replace function private.release_gate_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select enabled from private.release_gates where key = 'saas_1e1_non_owner_roles_safe'), false);
$$;

-- Refuses unless the gate is open OR the target role is itself unrestricted
-- (permission-based, never role-name/key-based). Called at the exact moment
-- a membership would become newly ACTIVE with this role — never for a mere
-- permission check against an already-active membership.
create or replace function private.assert_role_activation_allowed(p_tenant_id uuid, p_role_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.release_gate_open() then
    return;
  end if;
  if 'permissions.manage_unrestricted' = any (private.role_permission_keys(p_role_id)) then
    return;
  end if;
  raise exception 'non_owner_roles_not_yet_available';
end;
$$;

revoke execute on function private.release_gate_open() from public;
revoke execute on function private.assert_role_activation_allowed(uuid, uuid) from public;

-- =====================================================================
-- update_membership_role — byte-for-byte the live 20260921092226 body,
-- plus one assert_role_activation_allowed call before the UPDATE.
-- =====================================================================

create or replace function private.update_membership_role(p_membership_id uuid, p_new_role_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_member_user_id uuid;
  v_old_role_id uuid;
  v_new_role_tenant_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- The target's tenant is DERIVED, never client-supplied; then serialize
  -- on that tenant and re-read the target under the lock.
  select tenant_id into v_tenant_id
  from public.tenant_memberships
  where id = p_membership_id and deleted_at is null;

  if v_tenant_id is null then
    raise exception 'membership not found';
  end if;

  perform private.lock_tenant_for_management(v_tenant_id, 'membership not found', 'staff.manage required');

  select user_id, role_id
    into v_member_user_id, v_old_role_id
  from public.tenant_memberships
  where id = p_membership_id and tenant_id = v_tenant_id and deleted_at is null
  for update;

  if v_member_user_id is null then
    raise exception 'membership not found';
  end if;

  -- A caller who is not an active member of the target's tenant gets the
  -- same answer as for a nonexistent membership.
  if not private.is_tenant_member(v_tenant_id) then
    raise exception 'membership not found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  -- A staff.manage holder may change anyone's role except their own.
  if v_member_user_id = auth.uid() then
    raise exception 'cannot change your own role';
  end if;

  select tenant_id into v_new_role_tenant_id
  from public.roles
  where id = p_new_role_id and deleted_at is null;

  if v_new_role_tenant_id is null or v_new_role_tenant_id <> v_tenant_id then
    raise exception 'role not found in this tenant';
  end if;

  -- Authority over the TARGET, judged on the target's CURRENT permissions
  -- (raises insufficient_authority for an Owner or a peer of equal rank).
  perform private.assert_can_manage_membership(v_tenant_id, p_membership_id, 'role_change');

  -- Grant ceiling on the NEW role's FULL permission set, not a delta from
  -- the old role — unchanged rule, unchanged message.
  if not private.caller_can_grant_permissions(v_tenant_id, private.role_permission_keys(p_new_role_id)) then
    raise exception 'cannot assign a role with permissions you do not hold';
  end if;

  -- Faz SAAS.1E.0 (part 5): a caller below "unrestricted" may only put the
  -- member into a role STRICTLY below their own authority — never a peer.
  if not private.has_permission(v_tenant_id, 'permissions.manage_unrestricted')
     and not private.is_strict_subset(private.role_permission_keys(p_new_role_id), private.caller_permission_keys(v_tenant_id)) then
    raise exception 'insufficient_authority';
  end if;

  -- Explicitly defined no-op: assigning the role the member already has
  -- succeeds silently — no write, no audit row, no updated_at bump. It
  -- comes AFTER every authorization check, so an unauthorized caller
  -- never gets a silent success.
  if p_new_role_id = v_old_role_id then
    return;
  end if;

  -- Staged-release gate: a role CHANGE that moves this membership onto a
  -- non-unrestricted role is exactly as much a new "activation" as
  -- accepting a fresh invitation would be (see this migration's header —
  -- this call is what closes the invite-an-Owner-then-downgrade bypass).
  perform private.assert_role_activation_allowed(v_tenant_id, p_new_role_id);

  update public.tenant_memberships
  set role_id = p_new_role_id
  where id = p_membership_id and tenant_id = v_tenant_id;

  perform private.log_audit_event(
    v_tenant_id, 'membership.role_changed', 'tenant_membership', p_membership_id,
    jsonb_build_object('role_id', v_old_role_id),
    jsonb_build_object('role_id', p_new_role_id)
  );

  perform private.assert_tenant_has_unrestricted_holder(v_tenant_id);
end;
$$;

-- =====================================================================
-- reactivate_membership — byte-for-byte the live 20260921061657 body,
-- plus one assert_role_activation_allowed call before the UPDATE.
-- =====================================================================

create or replace function private.reactivate_membership(p_tenant_id uuid, p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_role_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  perform private.lock_tenant_for_management(p_tenant_id);
  perform private.assert_can_manage_membership(p_tenant_id, p_membership_id, 'reactivate');

  select tm.status, tm.role_id
    into v_status, v_role_id
  from public.tenant_memberships tm
  where tm.id = p_membership_id and tm.tenant_id = p_tenant_id and tm.deleted_at is null
  for update;

  if v_status is distinct from 'suspended' then
    raise exception 'membership_not_suspended';
  end if;

  -- Re-check the target's role NOW, not as it was when they were
  -- suspended: it must still be a live role of this tenant, and the
  -- caller must still be able to grant its CURRENT permissions.
  if not exists (
    select 1 from public.roles r
    where r.id = v_role_id and r.tenant_id = p_tenant_id and r.deleted_at is null
  ) then
    raise exception 'role_not_found';
  end if;

  if not private.caller_can_grant_permissions(p_tenant_id, private.role_permission_keys(v_role_id)) then
    raise exception 'insufficient_authority';
  end if;

  -- Staged-release gate: reactivating a suspended membership makes it
  -- active again under its existing role — the same "newly active with a
  -- non-unrestricted role" moment the gate exists to cover.
  perform private.assert_role_activation_allowed(p_tenant_id, v_role_id);

  update public.tenant_memberships
  set status = 'active'
  where id = p_membership_id and tenant_id = p_tenant_id;

  perform private.log_audit_event(
    p_tenant_id, 'membership.reactivated', 'tenant_membership', p_membership_id,
    jsonb_build_object('status', 'suspended'),
    jsonb_build_object('status', 'active')
  );

  perform private.assert_tenant_has_unrestricted_holder(p_tenant_id);
end;
$$;


-- =====================================================================
-- update_role_permissions — byte-for-byte the live 20260921092226 body,
-- plus the same staged-release gate, guarding the indirect bypass where a
-- role's OWN permissions are edited out from under an already-active
-- member instead of going through any activation path directly.
-- =====================================================================

create or replace function private.update_role_permissions(p_role_id uuid, p_permission_keys text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_before jsonb;
  v_before_keys text[];
  v_decision text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select tenant_id into v_tenant_id
  from public.roles
  where id = p_role_id and deleted_at is null;

  if v_tenant_id is null then
    raise exception 'role not found';
  end if;

  perform private.lock_tenant_for_management(v_tenant_id, 'role not found', 'staff.manage required');

  perform 1
  from public.roles
  where id = p_role_id and tenant_id = v_tenant_id and deleted_at is null
  for update;

  if not found then
    raise exception 'role not found';
  end if;

  if not private.is_tenant_member(v_tenant_id) then
    raise exception 'role not found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  -- Authority over the role's CURRENT permissions (never its name).
  v_decision := private.role_edit_decision(v_tenant_id, p_role_id);
  if v_decision <> 'ok' then
    raise exception '%', v_decision;
  end if;

  -- Grant ceiling on the NEW set — unchanged rule, unchanged message.
  if not private.caller_can_grant_permissions(v_tenant_id, p_permission_keys) then
    raise exception 'cannot grant a permission you do not hold';
  end if;

  -- Faz SAAS.1E.0 (part 5): a caller below "unrestricted" may only shape the
  -- role into a set STRICTLY below their own authority — never a peer.
  if not private.has_permission(v_tenant_id, 'permissions.manage_unrestricted')
     and not private.is_strict_subset(p_permission_keys, private.caller_permission_keys(v_tenant_id)) then
    raise exception 'insufficient_authority';
  end if;

  select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) into v_before
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = p_role_id;

  -- Staged-release gate: this role's CURRENT (pre-edit) permission set,
  -- read before the delete below removes it.
  v_before_keys := private.role_permission_keys(p_role_id);

  -- Staged-release gate: block only the UNRESTRICTED -> non-unrestricted
  -- transition on a role that already has an active member. A member
  -- activated into a custom unrestricted role (itself exempt from the
  -- gate at activation time) must not be silently downgraded to
  -- non-unrestricted authority by a permission edit that never passes
  -- through any of the four activation-gated functions. Editing a role
  -- that was ALREADY non-unrestricted (a genuine pre-existing custom
  -- role) is completely unaffected — this checks the TRANSITION, not
  -- the destination alone.
  if not private.release_gate_open()
     and 'permissions.manage_unrestricted' = any (v_before_keys)
     and not ('permissions.manage_unrestricted' = any (coalesce(p_permission_keys, array[]::text[])))
     and exists (
       select 1 from public.tenant_memberships tm
       where tm.role_id = p_role_id and tm.status = 'active' and tm.deleted_at is null
     )
  then
    raise exception 'non_owner_roles_not_yet_available';
  end if;

  delete from public.role_permissions where role_id = p_role_id;

  insert into public.role_permissions (role_id, permission_id)
  select p_role_id, p.id
  from public.permissions p
  where p.key = any (coalesce(p_permission_keys, array[]::text[]));

  perform private.log_audit_event(
    v_tenant_id, 'role.permissions_updated', 'role', p_role_id,
    jsonb_build_object('permissions', v_before),
    jsonb_build_object('permissions', p_permission_keys)
  );

  perform private.assert_tenant_has_unrestricted_holder(v_tenant_id);
end;
$$;

-- post-conditions: grants preserved on all three pre-existing functions
-- (CREATE OR REPLACE with an identical signature preserves OID and ACL),
-- new helpers not reachable by any client.
do $$
begin
  if not has_function_privilege('authenticated', 'public.update_membership_role(uuid, uuid)', 'execute') then
    raise exception 'grant-preservation check failed: authenticated lost EXECUTE on public.update_membership_role';
  end if;
  if not has_function_privilege('authenticated', 'public.reactivate_membership(uuid, uuid)', 'execute') then
    raise exception 'grant-preservation check failed: authenticated lost EXECUTE on public.reactivate_membership';
  end if;
  if not has_function_privilege('authenticated', 'public.update_role_permissions(uuid, text[])', 'execute') then
    raise exception 'grant-preservation check failed: authenticated lost EXECUTE on public.update_role_permissions';
  end if;
  if has_function_privilege('authenticated', 'private.assert_role_activation_allowed(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'private.release_gate_open()', 'execute') then
    raise exception 'a new gate helper is reachable by authenticated';
  end if;
end $$;
