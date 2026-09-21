-- Faz SAAS.1E.0 (part 5) — a caller below "unrestricted" can never hand out
-- authority EQUAL to their own: they cannot create a peer.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- SAAS.1E.0 part 2 (20260921083417) made create_/resend_/revoke_team_invitation
-- refuse a role whose permissions are not a STRICT subset of the caller's, so
-- a Yönetici can no longer invite another Yönetici. Review of that change
-- found the same peer-creation reachable in two steps through the two other
-- places where authority is handed out, which still used the older
-- containment rule (target set CONTAINED in the caller's, equality allowed):
--
--   1. invite someone into a strictly LOWER role (allowed), then
--      update_membership_role that member to a role EQUAL to the caller's
--      own — the "grant ceiling on the new role" accepted equality;
--   2. update_role_permissions on a strictly lower editable role, rewriting
--      it to EXACTLY the caller's own permission set — the "grant ceiling on
--      the new set" accepted equality — and then assigning it.
--
-- Either way a Yönetici mints a Yönetici that they can no longer manage (the
-- strict-subset rule then protects the new peer from them) while the Owner
-- has to find and undo it. That would make the invitation rule cosmetic.
--
-- =====================================================================
-- WHAT CHANGES
-- =====================================================================
--
-- The single rule the whole authority model now follows: a caller who does
-- NOT hold permissions.manage_unrestricted may put a member into, or shape a
-- role into, authority that is a STRICT subset of their own effective
-- permissions — never equal, never larger. Unrestricted callers are exempt,
-- exactly as everywhere else.
--
--   update_membership_role : after the pre-existing grant ceiling on the new
--       role (unchanged rule, unchanged message), a NON-unrestricted caller
--       whose target role is not a strict subset gets `insufficient_authority`.
--   update_role_permissions: after the pre-existing grant ceiling on the new
--       permission set (unchanged rule, unchanged message), a NON-unrestricted
--       caller whose new set is not a strict subset of their own gets
--       `insufficient_authority`.
--
-- Everything else in both functions is byte-for-byte the definition in
-- 20260921085707 (target authority, role-edit authority, tenant lock with its
-- pre-lock gate, no-op rule, audit, last-holder assertion). Nothing else
-- changes: no table, grant, policy, other function or TypeScript; no data.
-- create_role is deliberately untouched: a role that nobody below
-- "unrestricted" can assign, invite into or edit into existence hands out no
-- authority by itself.

-- =====================================================================
-- update_membership_role
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
-- update_role_permissions
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
