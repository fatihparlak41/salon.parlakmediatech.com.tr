-- Faz SAAS.1E.0 — Team authority security hardening.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- The SAAS.1E architecture audit proved, with rolled-back probes on DEV,
-- that today's authority surfaces are safe ONLY because every PROD tenant
-- has exactly one kind of member: the Owner. The moment a non-owner is
-- given staff.manage (the Yönetici role SAAS.1E.1 will provision) that
-- member could:
--   - demote an owner-level member: update_membership_role checked only
--     what may be GRANTED, never who the TARGET is;
--   - rewrite an owner-level role's permissions: update_role_permissions
--     had the same blind spot;
--   - suspend any other member with a raw PATCH of
--     tenant_memberships.status (a column-level grant): no ceiling, no
--     audit row;
--   - link or unlink any staff row to any login through raw writes to
--     staff_members.tenant_membership_id;
-- and a soft-deleted role kept granting permissions and kept counting as
-- an unrestricted holder.
--
-- This migration closes those surfaces BEFORE any such role exists. It
-- provisions NO roles and it changes NO existing role, membership, staff
-- row or invitation (Faz SAAS.1E.1 provisions the standard roles later).
--
-- =====================================================================
-- DESIGN
-- =====================================================================
--
-- 1. Authority is judged on EFFECTIVE PERMISSIONS, never on role names.
--    A caller may manage another member only if the caller holds
--    staff.manage AND the target's CURRENT permission set is a STRICT
--    subset of the caller's — or the caller holds
--    permissions.manage_unrestricted, which bypasses the subset test. So
--    a Yönetici can manage lower roles but never an Owner and never a
--    peer with equal authority. The target's set is the permission set of
--    its live role regardless of the membership's status: a SUSPENDED
--    Owner is still an Owner (otherwise anyone could reactivate one).
--
-- 2. Role editing follows the same rule: a role may be rewritten only by
--    an unrestricted caller, or by a caller whose own permissions are a
--    strict superset of the role's CURRENT permissions and only for a
--    non-system-default role. The grant ceiling on the NEW permission set
--    (caller_can_grant_permissions) is unchanged.
--
-- 3. The last-unrestricted-holder invariant is unchanged in shape and now
--    ignores soft-deleted roles: has_permission and the holder calculation
--    join roles with deleted_at is null, and a third DEFERRABLE INITIALLY
--    DEFERRED constraint trigger covers roles.deleted_at (soft delete).
--    Every management RPC below additionally calls
--    assert_tenant_has_unrestricted_holder() itself, so a violation
--    surfaces as a clean tenant_would_lose_last_unrestricted_holder from
--    the RPC instead of at commit.
--
-- 4. Concurrency: every management RPC takes the tenant row lock FIRST
--    (select ... from tenants for update — the same lock the holder
--    assertion takes), THEN re-reads and authorizes on the locked state.
--    Two concurrent management calls on one tenant therefore serialize;
--    the second decides on the first one's committed result. Lock order
--    is always tenant -> membership/role/staff row.
--
-- 5. Membership lifecycle is RPC-only. The only column-level grant in the
--    schema (tenant_memberships.status) is revoked together with its
--    now-dead RLS policy; suspend_membership, reactivate_membership and
--    remove_membership_access are the only paths, each audited exactly
--    once under its own event name.
--
-- 6. staff_members.tenant_membership_id is written only from trusted
--    (definer) context. Instead of restructuring the table-level grants
--    of staff_members — which would break the CURRENTLY DEPLOYED
--    application, whose Personnel forms always resend this column — a
--    BEFORE INSERT/UPDATE OF trigger rejects any write that CHANGES the
--    link unless it runs as a member of the `postgres` role. PostgREST
--    executes every client request as `authenticated`/`anon` (never a
--    member of `postgres`), and the SECURITY DEFINER functions that may
--    legitimately write the link (accept_team_invitation, and the RPCs
--    below) run as their owner, so the check needs no flag that a client
--    could try to spoof. A write that leaves the value UNCHANGED still
--    passes, which is what keeps the live Personnel screen working while
--    this ships. link_staff_membership / unlink_staff_membership are the
--    RPC surface; both enforce: same tenant, live staff row, live
--    membership, never overwrite an existing link, one login -> at most
--    one live staff row.
--
-- Auditing: each lifecycle RPC writes exactly one event of its own name
-- (membership.suspended / .reactivated / .removed) and nothing on a
-- refused or no-op call. Staff link changes are recorded exactly once by
-- the pre-existing audit_staff_member_change trigger (staff_member.updated
-- with the full before/after row), so the link RPCs deliberately add no
-- second event for the same change.
--
-- Error contract: new RPCs raise stable snake_case codes as the message
-- (membership_not_found, staff_manage_required, cannot_manage_self,
-- insufficient_authority, ...). update_membership_role and
-- update_role_permissions keep every pre-existing message for every
-- pre-existing condition and add the new codes only for the new checks.

-- =====================================================================
-- PART 1 — DELETED-ROLE SEMANTICS + role soft-delete guard
-- =====================================================================

create or replace function private.has_permission(p_tenant_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.roles r
      on r.id = tm.role_id
     and r.tenant_id = tm.tenant_id
     and r.deleted_at is null
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where tm.tenant_id = p_tenant_id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and tm.deleted_at is null
      and p.key = p_permission_key
  );
$$;

create or replace function private.tenant_has_active_unrestricted_holder(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.roles r
      on r.id = tm.role_id
     and r.tenant_id = tm.tenant_id
     and r.deleted_at is null
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where tm.tenant_id = p_tenant_id
      and tm.status = 'active'
      and tm.deleted_at is null
      and p.key = 'permissions.manage_unrestricted'
  );
$$;

create or replace function private.enforce_unrestricted_holder_on_role_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null then
    perform private.assert_tenant_has_unrestricted_holder(new.tenant_id);
  end if;
  return new;
end;
$$;

-- Deferred, exactly like the two existing holder guards, so a transaction
-- that soft-deletes a role AND re-homes its members is judged on its final
-- state. INSERT is deliberately not covered (a new role can only ever add
-- a holder); hard DELETE stays unreachable for authenticated and is
-- already blocked by the tenant_memberships.role_id foreign key.
drop trigger if exists roles_unrestricted_holder_guard on public.roles;
create constraint trigger roles_unrestricted_holder_guard
  after update of deleted_at on public.roles
  deferrable initially deferred
  for each row
  execute function private.enforce_unrestricted_holder_on_role_soft_delete();

-- =====================================================================
-- PART 2 — AUTHORITY PRIMITIVES
-- =====================================================================

-- The caller's effective permission keys in one tenant: active, live
-- membership attached to a live role of that tenant. Empty otherwise.
create or replace function private.caller_permission_keys(p_tenant_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct p.key order by p.key), array[]::text[])
  from public.tenant_memberships tm
  join public.roles r
    on r.id = tm.role_id
   and r.tenant_id = tm.tenant_id
   and r.deleted_at is null
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions p on p.id = rp.permission_id
  where tm.tenant_id = p_tenant_id
    and tm.user_id = auth.uid()
    and tm.status = 'active'
    and tm.deleted_at is null;
$$;

-- The permission keys of a LIVE role; empty for a deleted or unknown role.
create or replace function private.role_permission_keys(p_role_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct p.key order by p.key), array[]::text[])
  from public.roles r
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions p on p.id = rp.permission_id
  where r.id = p_role_id
    and r.deleted_at is null;
$$;

-- candidate is a PROPER subset of container (contained, and not equal).
create or replace function private.is_strict_subset(p_candidate text[], p_container text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_candidate, array[]::text[]) <@ coalesce(p_container, array[]::text[])
     and not (coalesce(p_container, array[]::text[]) <@ coalesce(p_candidate, array[]::text[]));
$$;

-- The single authority decision for acting on a member. Returns 'ok' or
-- the stable error code the calling RPC raises. p_action is one of:
-- role_change, suspend, reactivate, remove (all forbid acting on
-- yourself) and link, unlink (allowed on yourself: they change which
-- staff record a login is attributed to, never anyone's privileges).
create or replace function private.membership_authority_decision(
  p_tenant_id uuid,
  p_target_membership_id uuid,
  p_action text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_target_user uuid;
  v_target_role uuid;
begin
  if v_caller is null then
    return 'authentication_required';
  end if;

  if p_action is null or p_action not in ('role_change', 'suspend', 'reactivate', 'remove', 'link', 'unlink') then
    return 'invalid_action';
  end if;

  select tm.user_id, tm.role_id
    into v_target_user, v_target_role
  from public.tenant_memberships tm
  where tm.id = p_target_membership_id
    and tm.tenant_id = p_tenant_id
    and tm.deleted_at is null;

  -- Nonexistent, removed and other-tenant targets — and callers who are
  -- not active members of this tenant at all — all get the same answer,
  -- so a UUID can never be probed across tenants.
  if v_target_user is null or not private.is_tenant_member(p_tenant_id) then
    return 'membership_not_found';
  end if;

  if not private.has_permission(p_tenant_id, 'staff.manage') then
    return 'staff_manage_required';
  end if;

  if v_target_user = v_caller then
    if p_action in ('link', 'unlink') then
      return 'ok';
    end if;
    return 'cannot_manage_self';
  end if;

  if private.has_permission(p_tenant_id, 'permissions.manage_unrestricted') then
    return 'ok';
  end if;

  if private.is_strict_subset(private.role_permission_keys(v_target_role), private.caller_permission_keys(p_tenant_id)) then
    return 'ok';
  end if;

  return 'insufficient_authority';
end;
$$;

create or replace function private.can_manage_membership(
  p_tenant_id uuid,
  p_target_membership_id uuid,
  p_action text default 'role_change'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.membership_authority_decision(p_tenant_id, p_target_membership_id, p_action) = 'ok';
$$;

create or replace function private.assert_can_manage_membership(
  p_tenant_id uuid,
  p_target_membership_id uuid,
  p_action text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_decision text;
begin
  v_decision := private.membership_authority_decision(p_tenant_id, p_target_membership_id, p_action);
  if v_decision <> 'ok' then
    raise exception '%', v_decision;
  end if;
end;
$$;

-- The authority decision for rewriting a role's permissions.
create or replace function private.role_edit_decision(p_tenant_id uuid, p_role_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_is_system_default boolean;
begin
  if auth.uid() is null then
    return 'authentication_required';
  end if;

  select r.is_system_default
    into v_is_system_default
  from public.roles r
  where r.id = p_role_id
    and r.tenant_id = p_tenant_id
    and r.deleted_at is null;

  if not found or not private.is_tenant_member(p_tenant_id) then
    return 'role_not_found';
  end if;

  if not private.has_permission(p_tenant_id, 'staff.manage') then
    return 'staff_manage_required';
  end if;

  if private.has_permission(p_tenant_id, 'permissions.manage_unrestricted') then
    return 'ok';
  end if;

  if v_is_system_default then
    return 'system_role_edit_not_permitted';
  end if;

  if private.is_strict_subset(private.role_permission_keys(p_role_id), private.caller_permission_keys(p_tenant_id)) then
    return 'ok';
  end if;

  return 'insufficient_authority';
end;
$$;

create or replace function private.can_edit_role(p_tenant_id uuid, p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.role_edit_decision(p_tenant_id, p_role_id) = 'ok';
$$;

-- Serializes management calls on one tenant. See DESIGN 4.
create or replace function private.lock_tenant_for_management(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'membership_not_found';
  end if;
end;
$$;

-- =====================================================================
-- PART 3 — HARDENED update_membership_role / update_role_permissions
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

  perform private.lock_tenant_for_management(v_tenant_id);

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

  perform private.lock_tenant_for_management(v_tenant_id);

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

-- =====================================================================
-- PART 4 — MEMBERSHIP LIFECYCLE RPCs (status is RPC-only from here on)
-- =====================================================================

create or replace function private.suspend_membership(p_tenant_id uuid, p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  perform private.lock_tenant_for_management(p_tenant_id);
  perform private.assert_can_manage_membership(p_tenant_id, p_membership_id, 'suspend');

  select tm.status into v_status
  from public.tenant_memberships tm
  where tm.id = p_membership_id and tm.tenant_id = p_tenant_id and tm.deleted_at is null
  for update;

  if v_status is distinct from 'active' then
    raise exception 'membership_not_active';
  end if;

  -- Only the status changes: the linked staff row, appointments,
  -- schedules and performance history are not touched in any way.
  update public.tenant_memberships
  set status = 'suspended'
  where id = p_membership_id and tenant_id = p_tenant_id;

  perform private.log_audit_event(
    p_tenant_id, 'membership.suspended', 'tenant_membership', p_membership_id,
    jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'suspended')
  );

  perform private.assert_tenant_has_unrestricted_holder(p_tenant_id);
end;
$$;

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

-- Soft-deletes the membership (deleted_at) and, in the SAME transaction,
-- clears the staff link. The staff row itself, its appointments,
-- schedules and performance history, and the auth user are untouched.
-- Clearing the link is what keeps a later re-invite structurally
-- possible: accept_team_invitation only links a staff row whose link is
-- NULL, and the (tenant_id, user_id) uniqueness only covers live rows, so
-- the person can be invited again into a brand-new membership.
create or replace function private.remove_membership_access(p_tenant_id uuid, p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_role_id uuid;
  v_unlinked jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  perform private.lock_tenant_for_management(p_tenant_id);
  perform private.assert_can_manage_membership(p_tenant_id, p_membership_id, 'remove');

  select tm.status, tm.role_id
    into v_status, v_role_id
  from public.tenant_memberships tm
  where tm.id = p_membership_id and tm.tenant_id = p_tenant_id and tm.deleted_at is null
  for update;

  if v_status is null then
    raise exception 'membership_not_found';
  end if;

  with unlinked as (
    update public.staff_members
    set tenant_membership_id = null
    where tenant_id = p_tenant_id and tenant_membership_id = p_membership_id
    returning id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_unlinked from unlinked;

  update public.tenant_memberships
  set deleted_at = now()
  where id = p_membership_id and tenant_id = p_tenant_id;

  perform private.log_audit_event(
    p_tenant_id, 'membership.removed', 'tenant_membership', p_membership_id,
    jsonb_build_object('role_id', v_role_id, 'status', v_status, 'unlinked_staff_member_ids', v_unlinked),
    jsonb_build_object('deleted', true)
  );

  perform private.assert_tenant_has_unrestricted_holder(p_tenant_id);
end;
$$;

-- The only column-level grant in the schema, and the RLS policy that
-- gated it, go away: status is now written only by the RPCs above.
revoke update (status) on public.tenant_memberships from authenticated;
drop policy if exists tenant_memberships_update_staff_manage on public.tenant_memberships;

-- =====================================================================
-- PART 5 — STAFF <-> MEMBERSHIP LINK (RPC-only writes)
-- =====================================================================

-- SECURITY INVOKER on purpose: current_user must be the role the write
-- actually runs as. Direct PostgREST writes run as authenticated/anon;
-- SECURITY DEFINER functions run as their owner (postgres).
create or replace function private.guard_staff_membership_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.tenant_membership_id is not null)
     or (tg_op = 'UPDATE' and new.tenant_membership_id is distinct from old.tenant_membership_id) then
    if not pg_has_role(current_user, 'postgres', 'member') then
      raise exception 'staff_membership_link_via_rpc_only' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists staff_members_membership_link_guard on public.staff_members;
create trigger staff_members_membership_link_guard
  before insert or update of tenant_membership_id on public.staff_members
  for each row
  execute function private.guard_staff_membership_link();

create or replace function private.link_staff_membership(
  p_tenant_id uuid,
  p_staff_member_id uuid,
  p_membership_id uuid
)
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

  perform private.lock_tenant_for_management(p_tenant_id);
  perform private.assert_can_manage_membership(p_tenant_id, p_membership_id, 'link');

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

  -- Never overwrite: an existing link (even to this same login) must be
  -- removed first with unlink_staff_membership.
  if v_current_link is not null then
    raise exception 'staff_already_linked';
  end if;

  if exists (
    select 1 from public.staff_members sm
    where sm.tenant_membership_id = p_membership_id
      and sm.deleted_at is null
  ) then
    raise exception 'membership_already_linked';
  end if;

  -- Recorded once by audit_staff_member_change (staff_member.updated).
  update public.staff_members
  set tenant_membership_id = p_membership_id
  where id = p_staff_member_id and tenant_id = p_tenant_id;
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

  perform private.lock_tenant_for_management(p_tenant_id);

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

-- =====================================================================
-- PART 6 — PUBLIC WRAPPERS AND GRANTS
-- =====================================================================
--
-- A public.* wrapper around a private.* function MUST be security
-- definer (see this directory's README: PostgREST only exposes public,
-- and authenticated has no USAGE on private). Every function this
-- migration adds gets the explicit per-function revoke from PUBLIC —
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default.

create or replace function public.suspend_membership(p_tenant_id uuid, p_membership_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.suspend_membership(p_tenant_id, p_membership_id);
$$;

create or replace function public.reactivate_membership(p_tenant_id uuid, p_membership_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.reactivate_membership(p_tenant_id, p_membership_id);
$$;

create or replace function public.remove_membership_access(p_tenant_id uuid, p_membership_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.remove_membership_access(p_tenant_id, p_membership_id);
$$;

create or replace function public.link_staff_membership(p_tenant_id uuid, p_staff_member_id uuid, p_membership_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.link_staff_membership(p_tenant_id, p_staff_member_id, p_membership_id);
$$;

create or replace function public.unlink_staff_membership(p_tenant_id uuid, p_staff_member_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.unlink_staff_membership(p_tenant_id, p_staff_member_id);
$$;

revoke execute on function private.enforce_unrestricted_holder_on_role_soft_delete() from public;
revoke execute on function private.caller_permission_keys(uuid) from public;
revoke execute on function private.role_permission_keys(uuid) from public;
revoke execute on function private.is_strict_subset(text[], text[]) from public;
revoke execute on function private.membership_authority_decision(uuid, uuid, text) from public;
revoke execute on function private.can_manage_membership(uuid, uuid, text) from public;
revoke execute on function private.assert_can_manage_membership(uuid, uuid, text) from public;
revoke execute on function private.role_edit_decision(uuid, uuid) from public;
revoke execute on function private.can_edit_role(uuid, uuid) from public;
revoke execute on function private.lock_tenant_for_management(uuid) from public;
revoke execute on function private.suspend_membership(uuid, uuid) from public;
revoke execute on function private.reactivate_membership(uuid, uuid) from public;
revoke execute on function private.remove_membership_access(uuid, uuid) from public;
revoke execute on function private.guard_staff_membership_link() from public;
revoke execute on function private.link_staff_membership(uuid, uuid, uuid) from public;
revoke execute on function private.unlink_staff_membership(uuid, uuid) from public;

revoke execute on function public.suspend_membership(uuid, uuid) from public;
revoke execute on function public.reactivate_membership(uuid, uuid) from public;
revoke execute on function public.remove_membership_access(uuid, uuid) from public;
revoke execute on function public.link_staff_membership(uuid, uuid, uuid) from public;
revoke execute on function public.unlink_staff_membership(uuid, uuid) from public;

grant execute on function public.suspend_membership(uuid, uuid) to authenticated;
grant execute on function public.reactivate_membership(uuid, uuid) to authenticated;
grant execute on function public.remove_membership_access(uuid, uuid) to authenticated;
grant execute on function public.link_staff_membership(uuid, uuid, uuid) to authenticated;
grant execute on function public.unlink_staff_membership(uuid, uuid) to authenticated;
