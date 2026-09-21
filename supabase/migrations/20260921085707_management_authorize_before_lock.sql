-- Faz SAAS.1E.0 (part 4) — authorize BEFORE taking the tenant lock.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- Every management RPC of 20260921061657 (update_membership_role,
-- update_role_permissions, suspend_membership, reactivate_membership,
-- remove_membership_access, link_staff_membership, unlink_staff_membership)
-- serializes on the tenant by locking the tenants row FOR UPDATE as its
-- FIRST step — before it has checked anything about the caller. The tenant
-- id (or the id of a membership/role in it) is all a caller needs to supply.
-- So any signed-in user, including a member of a different tenant or a
-- member without staff.manage, could make a call that is refused a
-- millisecond later but holds the lock meanwhile. FOR UPDATE conflicts with
-- the KEY SHARE lock that every foreign-key insert takes on the tenants row
-- (appointments, customers, audit rows, ...), so a stream of such calls
-- could intermittently stall writes for that one tenant. Nothing is
-- disclosed and nothing is changed by such calls — it is a
-- contention/availability weakness, found in the SAAS.1E.0 release review.
--
-- =====================================================================
-- WHAT CHANGES
-- =====================================================================
--
-- private.lock_tenant_for_management(tenant, not_member_msg, no_permission_msg)
-- now runs an UNLOCKED, read-only gate first: the caller must be an ACTIVE
-- member of the tenant AND hold staff.manage, otherwise the RPC's own
-- denial message is raised and the lock is never touched. Only then is the
-- row locked. Each RPC still authorizes again on the locked state exactly as
-- before (the gate is a cheap pre-filter, never the decision), and the lock
-- order is unchanged: tenant row first, then target rows.
--
-- Denial messages are unchanged for every case except one that only got
-- LESS revealing: a member WITHOUT staff.manage who targets an id that
-- does not exist used to be told the id does not exist; now they are told
-- staff.manage is required, whatever they target.

-- =====================================================================
-- PART 1 — the gate lives in the lock helper
-- =====================================================================

-- The one-argument form is replaced by a three-argument form whose extra
-- arguments have defaults, so every existing call site
-- (private.lock_tenant_for_management(tenant)) keeps resolving; the RPCs
-- whose denial messages are not the defaults pass their own below.
drop function if exists private.lock_tenant_for_management(uuid);

create or replace function private.lock_tenant_for_management(
  p_tenant_id uuid,
  p_not_member_message text default 'membership_not_found',
  p_no_permission_message text default 'staff_manage_required'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Unlocked, read-only gate FIRST: a caller who is not an active member
  -- of this tenant, or who lacks staff.manage, is refused with the
  -- calling RPC's own message and never contends for the lock.
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception '%', p_not_member_message;
  end if;

  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception '%', p_no_permission_message;
  end if;

  perform 1 from public.tenants where id = p_tenant_id for update;
  if not found then
    raise exception '%', p_not_member_message;
  end if;
end;
$$;

revoke execute on function private.lock_tenant_for_management(uuid, text, text) from public;

-- =====================================================================
-- PART 2 — the three RPCs whose denial messages are not the defaults
-- =====================================================================
--
-- Each is the 20260921061657 definition with exactly ONE line changed:
-- the lock call passes that RPC's own not-a-member / no-permission
-- messages. suspend_membership, reactivate_membership,
-- remove_membership_access and link_staff_membership already use the
-- defaults and are not redefined.

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

  -- Explicitly defined no-op: assigning the role the member already has
  -- succeeds silently — no write, no audit row, no updated_at bump. It
  -- comes AFTER every authorization check, so an unauthorized caller
  -- never gets a silent success.
  if p_new_role_id = v_old_role_id then
    return;
  end if;

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

create or replace function private.update_role_permissions(p_role_id uuid, p_permission_keys text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_before jsonb;
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

  select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) into v_before
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = p_role_id;

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

create or replace function private.unlink_staff_membership(p_tenant_id uuid, p_staff_member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_link uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  perform private.lock_tenant_for_management(p_tenant_id, 'staff_member_not_found', 'staff_manage_required');

  if not private.is_tenant_member(p_tenant_id) then
    raise exception 'staff_member_not_found';
  end if;

  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception 'staff_manage_required';
  end if;

  select sm.tenant_membership_id
    into v_current_link
  from public.staff_members sm
  where sm.id = p_staff_member_id
    and sm.tenant_id = p_tenant_id
    and sm.deleted_at is null
  for update;

  if not found then
    raise exception 'staff_member_not_found';
  end if;

  if v_current_link is null then
    raise exception 'staff_not_linked';
  end if;

  -- Authority over the linked login — but only while that login still
  -- exists; a link left pointing at a removed membership can always be
  -- cleared by anyone holding staff.manage.
  if exists (
    select 1 from public.tenant_memberships tm
    where tm.id = v_current_link and tm.tenant_id = p_tenant_id and tm.deleted_at is null
  ) then
    perform private.assert_can_manage_membership(p_tenant_id, v_current_link, 'unlink');
  end if;

  -- Recorded once by audit_staff_member_change (staff_member.updated).
  update public.staff_members
  set tenant_membership_id = null
  where id = p_staff_member_id and tenant_id = p_tenant_id;
end;
$$;
