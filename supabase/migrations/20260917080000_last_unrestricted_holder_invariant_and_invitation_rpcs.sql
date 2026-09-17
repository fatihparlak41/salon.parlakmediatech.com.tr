-- Faz SAAS.1C.1 — Invitation security core + last-unrestricted-holder
-- invariant.
--
-- =====================================================================
-- PART 1 — LAST UNRESTRICTED HOLDER INVARIANT
-- =====================================================================
--
-- Canonical invariant: a tenant must never reach a COMMITTED state with
-- zero active (status='active', deleted_at is null) tenant_memberships
-- whose effective role holds permissions.manage_unrestricted. This is
-- deliberately a PERMISSION check, never a role-name check (SALON_OWNER,
-- settings.manage+staff.manage are NOT equivalent — SALON_MANAGER
-- already holds both without holding manage_unrestricted).
--
-- "Effective role holds X" is defined identically to how
-- private.has_permission actually computes it: tenant_memberships joined
-- to role_permissions on tm.role_id, joined to permissions — NOT
-- filtered by roles.deleted_at or roles.tenant_id, because has_permission
-- itself never filters on either. Audited both as part of this phase:
--   - roles.deleted_at: has_permission never joins the roles table at
--     all, so soft-deleting a role does not strip any existing holder's
--     computed permission — only blocks *new* assignment into it (see
--     update_membership_role's own "and deleted_at is null" role
--     lookup). No additional guard is structurally necessary here.
--   - hard DELETE of a role: unreachable by `authenticated` today — no
--     DELETE grant on public.roles exists (confirmed via
--     security_audit_table_grants()), and no delete_role RPC exists
--     anywhere in this schema. role_permissions.role_id -> roles.id is
--     ON DELETE CASCADE, but that path is not reachable by any
--     authenticated caller, so it needs no guard either.
--   - NOTE (observation, not fixed here — out of scope for this phase):
--     has_permission also never checks roles.tenant_id, so a role whose
--     tenant_id was directly rescoped via the existing
--     roles_update_staff_manage policy would still silently keep
--     granting its original tenant's members access. This is a
--     pre-existing gap unrelated to the unrestricted-holder invariant
--     and deserves its own dedicated review.
--
-- Enforcement is pure database-level, via DEFERRABLE INITIALLY DEFERRED
-- constraint triggers on the two tables that can actually remove a
-- holder's effective permission:
--   - tenant_memberships: role_id change, status change, deleted_at
--     change, DELETE (INSERT is deliberately NOT covered — a brand new
--     membership can only ever ADD a holder, never remove one, so it can
--     never violate this invariant).
--   - role_permissions: DELETE/UPDATE of the manage_unrestricted row
--     (INSERT likewise excluded for the same reason).
--
-- Because both existing application RPCs (update_membership_role,
-- update_role_permissions) and the existing direct column-level UPDATE
-- grant on tenant_memberships.status all funnel through the SAME
-- underlying table mutations, this protects every one of those paths —
-- present and future — without changing a single line of either
-- existing RPC. A violating UPDATE/DELETE still executes and appears to
-- succeed inside its own statement; the deferred trigger fires at
-- transaction commit and rolls the whole transaction back if the final
-- state would have zero holders, which surfaces as a normal RPC/PostgREST
-- error to the caller.
--
-- Concurrency: private.assert_tenant_has_unrestricted_holder() takes
-- `select 1 from public.tenants where id = p_tenant_id for update`
-- before evaluating the invariant. Two concurrent transactions racing to
-- strip two different holders on the same tenant serialize on this lock:
-- whichever commits first releases the lock; the second transaction's
-- deferred check then re-reads a fresh (READ COMMITTED) snapshot that
-- includes the first transaction's already-committed change, so it
-- correctly observes zero holders and rolls back. At most one of two
-- conflicting removals can ever commit. See
-- tests/last-unrestricted-holder-invariant.test.ts for a real two
-- concurrent-transaction regression, not just a sequential proxy for one.
--
-- Bootstrap safety: private.create_tenant_with_owner inserts the tenant,
-- role, role_permissions and membership entirely via INSERT statements —
-- never UPDATE/DELETE — so none of the new triggers fire during
-- bootstrap at all, deferred or not. Freshly re-tested after this
-- migration (see same test file).
--
-- =====================================================================
-- PART 2 — TEAM INVITATION RPCs
-- =====================================================================
--
-- create / list / resend / revoke / accept on top of the
-- public.team_invitations table from 20260917070000. No outbound email
-- yet (SAAS.1C.2); the raw token is returned once by create/resend for a
-- future server-side-only Server Action to deliver — it must never reach
-- browser UI. Acceptance is strictly email-bound: token possession alone
-- is never sufficient, matching this migration's own header requirement.

-- ---------------------------------------------------------------------
-- 1. Invariant primitives
-- ---------------------------------------------------------------------

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
    join public.role_permissions rp on rp.role_id = tm.role_id
    join public.permissions p on p.id = rp.permission_id
    where tm.tenant_id = p_tenant_id
      and tm.status = 'active'
      and tm.deleted_at is null
      and p.key = 'permissions.manage_unrestricted'
  );
$$;

create or replace function private.assert_tenant_has_unrestricted_holder(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Serializes concurrent invariant checks for this tenant — see the
  -- migration header for the full two-transaction race this closes.
  perform 1 from public.tenants where id = p_tenant_id for update;

  if not private.tenant_has_active_unrestricted_holder(p_tenant_id) then
    raise exception 'tenant_would_lose_last_unrestricted_holder';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. tenant_memberships guard
-- ---------------------------------------------------------------------

create or replace function private.enforce_unrestricted_holder_on_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := coalesce(old.tenant_id, new.tenant_id);

  if tg_op = 'UPDATE'
     and new.role_id is not distinct from old.role_id
     and new.status is not distinct from old.status
     and new.deleted_at is not distinct from old.deleted_at then
    return new;
  end if;

  perform private.assert_tenant_has_unrestricted_holder(v_tenant_id);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_memberships_unrestricted_holder_guard on public.tenant_memberships;
create constraint trigger tenant_memberships_unrestricted_holder_guard
  after update or delete on public.tenant_memberships
  deferrable initially deferred
  for each row
  execute function private.enforce_unrestricted_holder_on_membership_change();

-- ---------------------------------------------------------------------
-- 3. role_permissions guard
-- ---------------------------------------------------------------------

create or replace function private.enforce_unrestricted_holder_on_role_permission_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_permission_key text;
  v_tenant_id uuid;
begin
  select key into v_permission_key from public.permissions where id = old.permission_id;

  if v_permission_key is distinct from 'permissions.manage_unrestricted' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and new.role_id = old.role_id and new.permission_id = old.permission_id then
    return new;
  end if;

  select tenant_id into v_tenant_id from public.roles where id = old.role_id;

  -- v_tenant_id is null only if the owning role itself is gone in the
  -- same operation (unreachable hard-delete cascade today — see header);
  -- nothing to assert against in that case.
  if v_tenant_id is not null then
    perform private.assert_tenant_has_unrestricted_holder(v_tenant_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists role_permissions_unrestricted_holder_guard on public.role_permissions;
create constraint trigger role_permissions_unrestricted_holder_guard
  after update or delete on public.role_permissions
  deferrable initially deferred
  for each row
  execute function private.enforce_unrestricted_holder_on_role_permission_change();

-- ---------------------------------------------------------------------
-- 4. create_team_invitation
-- ---------------------------------------------------------------------

create or replace function private.create_team_invitation(
  p_tenant_id uuid,
  p_email text,
  p_role_id uuid,
  p_staff_member_id uuid default null
)
returns table (
  id uuid,
  tenant_id uuid,
  email text,
  role_id uuid,
  staff_member_id uuid,
  status text,
  expires_at timestamptz,
  created_at timestamptz,
  token text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_role_tenant_id uuid;
  v_staff_tenant_id uuid;
  v_target_permission_keys text[];
  v_existing_user_id uuid;
  v_existing_membership_status text;
  v_raw_token text;
  v_token_hash text;
  v_invitation_id uuid;
  v_expires_at timestamptz;
  v_created_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  -- Bare "tenant_id"/"id" would be ambiguous here: this function's own
  -- RETURNS TABLE(..., tenant_id uuid, id uuid, ...) declares OUT
  -- parameters of those exact names, which plpgsql treats as in-scope
  -- variables inside the function body — every query below qualifies
  -- every column against its table/alias for this reason, even where it
  -- looks redundant.
  select roles.tenant_id into v_role_tenant_id
  from public.roles
  where roles.id = p_role_id and roles.deleted_at is null;

  if v_role_tenant_id is null or v_role_tenant_id <> p_tenant_id then
    raise exception 'role not found in this tenant';
  end if;

  if p_staff_member_id is not null then
    select staff_members.tenant_id into v_staff_tenant_id
    from public.staff_members
    where staff_members.id = p_staff_member_id and staff_members.deleted_at is null;

    if v_staff_tenant_id is null or v_staff_tenant_id <> p_tenant_id then
      raise exception 'staff member not found in this tenant';
    end if;
  end if;

  -- Checked against the target role's FULL permission set, same
  -- ceiling discipline as update_membership_role/update_role_permissions
  -- — never duplicated, always delegated to caller_can_grant_permissions.
  select array_agg(p.key) into v_target_permission_keys
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = p_role_id;

  if not private.caller_can_grant_permissions(p_tenant_id, coalesce(v_target_permission_keys, array[]::text[])) then
    raise exception 'cannot invite into a role with permissions you do not hold';
  end if;

  v_email := private.normalize_email(p_email);
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;

  -- A. Transition stale pending rows for this tenant/email first, so the
  -- partial-pending unique index never collides with a row that is
  -- pending only on paper.
  update public.team_invitations
  set status = 'expired', updated_at = now()
  where team_invitations.tenant_id = p_tenant_id
    and team_invitations.email = v_email
    and team_invitations.status = 'pending'
    and team_invitations.expires_at <= now();

  -- B. Block a genuinely still-pending invitation.
  if exists (
    select 1 from public.team_invitations
    where team_invitations.tenant_id = p_tenant_id
      and team_invitations.email = v_email
      and team_invitations.status = 'pending'
  ) then
    raise exception 'pending_invitation_exists';
  end if;

  -- C. Existing-account checks. Soft-deleted memberships are not
  -- checked here — a genuinely former member can be re-invited.
  select u.id into v_existing_user_id
  from auth.users u
  where private.normalize_email(u.email) = v_email;

  if v_existing_user_id is not null then
    select tenant_memberships.status into v_existing_membership_status
    from public.tenant_memberships
    where tenant_memberships.tenant_id = p_tenant_id
      and tenant_memberships.user_id = v_existing_user_id
      and tenant_memberships.deleted_at is null;

    if v_existing_membership_status = 'active' then
      raise exception 'already_member';
    elsif v_existing_membership_status = 'suspended' then
      raise exception 'membership_suspended';
    end if;
  end if;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.team_invitations (
    tenant_id, email, role_id, staff_member_id, invited_by, status, token_hash, expires_at
  )
  values (
    p_tenant_id, v_email, p_role_id, p_staff_member_id, auth.uid(), 'pending', v_token_hash, now() + interval '7 days'
  )
  returning team_invitations.id, team_invitations.expires_at, team_invitations.created_at
    into v_invitation_id, v_expires_at, v_created_at;

  -- Never the raw token or its hash in the audit payload.
  perform private.log_audit_event(
    p_tenant_id, 'team_invitation.created', 'team_invitation', v_invitation_id,
    null,
    jsonb_build_object('email', v_email, 'role_id', p_role_id, 'staff_member_id', p_staff_member_id)
  );

  return query select
    v_invitation_id, p_tenant_id, v_email, p_role_id, p_staff_member_id, 'pending'::text, v_expires_at, v_created_at, v_raw_token;
end;
$$;

create or replace function public.create_team_invitation(
  p_tenant_id uuid,
  p_email text,
  p_role_id uuid,
  p_staff_member_id uuid default null
)
returns table (
  id uuid,
  tenant_id uuid,
  email text,
  role_id uuid,
  staff_member_id uuid,
  status text,
  expires_at timestamptz,
  created_at timestamptz,
  token text
)
language sql
security definer
set search_path = ''
as $$
  select * from private.create_team_invitation(p_tenant_id, p_email, p_role_id, p_staff_member_id);
$$;

-- ---------------------------------------------------------------------
-- 5. list_team_invitations
-- ---------------------------------------------------------------------

create or replace function private.list_team_invitations(p_tenant_id uuid)
returns table (
  id uuid,
  email text,
  role_id uuid,
  role_name text,
  staff_member_id uuid,
  staff_member_name text,
  status text,
  effective_status text,
  expires_at timestamptz,
  created_at timestamptz,
  invited_by_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  return query
  select
    ti.id,
    ti.email,
    ti.role_id,
    r.name,
    ti.staff_member_id,
    sm.full_name,
    ti.status,
    case when ti.status = 'pending' and ti.expires_at <= now() then 'expired' else ti.status end,
    ti.expires_at,
    ti.created_at,
    pr.full_name
  from public.team_invitations ti
  join public.roles r on r.id = ti.role_id
  left join public.staff_members sm on sm.id = ti.staff_member_id
  left join public.profiles pr on pr.id = ti.invited_by
  where ti.tenant_id = p_tenant_id
  order by ti.created_at desc;
end;
$$;

create or replace function public.list_team_invitations(p_tenant_id uuid)
returns table (
  id uuid,
  email text,
  role_id uuid,
  role_name text,
  staff_member_id uuid,
  staff_member_name text,
  status text,
  effective_status text,
  expires_at timestamptz,
  created_at timestamptz,
  invited_by_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.list_team_invitations(p_tenant_id);
$$;

-- ---------------------------------------------------------------------
-- 6. resend_team_invitation
-- ---------------------------------------------------------------------

create or replace function private.resend_team_invitation(p_invitation_id uuid)
returns table (
  id uuid,
  status text,
  expires_at timestamptz,
  token text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_role_id uuid;
  v_status text;
  v_expires_at timestamptz;
  v_target_permission_keys text[];
  v_raw_token text;
  v_token_hash text;
  v_new_expires_at timestamptz;
begin
  -- Bare "id"/"status" would be ambiguous — see create_team_invitation's
  -- own comment on this function's RETURNS TABLE OUT parameters.
  select team_invitations.tenant_id, team_invitations.role_id, team_invitations.status, team_invitations.expires_at
    into v_tenant_id, v_role_id, v_status, v_expires_at
  from public.team_invitations
  where team_invitations.id = p_invitation_id
  for update;

  if v_tenant_id is null then
    raise exception 'invitation_not_found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  select array_agg(p.key) into v_target_permission_keys
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = v_role_id;

  if not private.caller_can_grant_permissions(v_tenant_id, coalesce(v_target_permission_keys, array[]::text[])) then
    raise exception 'cannot resend an invitation into a role with permissions you do not hold';
  end if;

  if v_status <> 'pending' then
    raise exception 'invitation_not_pending';
  end if;

  if v_expires_at <= now() then
    update public.team_invitations
    set status = 'expired', updated_at = now()
    where team_invitations.id = p_invitation_id;

    return query select p_invitation_id, 'expired'::text, v_expires_at, null::text;
    return;
  end if;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_new_expires_at := now() + interval '7 days';

  update public.team_invitations
  set token_hash = v_token_hash, expires_at = v_new_expires_at, updated_at = now()
  where team_invitations.id = p_invitation_id;

  perform private.log_audit_event(
    v_tenant_id, 'team_invitation.resent', 'team_invitation', p_invitation_id, null, null
  );

  return query select p_invitation_id, 'pending'::text, v_new_expires_at, v_raw_token;
end;
$$;

create or replace function public.resend_team_invitation(p_invitation_id uuid)
returns table (
  id uuid,
  status text,
  expires_at timestamptz,
  token text
)
language sql
security definer
set search_path = ''
as $$
  select * from private.resend_team_invitation(p_invitation_id);
$$;

-- ---------------------------------------------------------------------
-- 7. revoke_team_invitation
-- ---------------------------------------------------------------------

create or replace function private.revoke_team_invitation(p_invitation_id uuid)
returns table (
  id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_role_id uuid;
  v_status text;
  v_expires_at timestamptz;
  v_target_permission_keys text[];
begin
  -- Bare "id"/"status" would be ambiguous — see create_team_invitation's
  -- own comment on this function's RETURNS TABLE OUT parameters.
  select team_invitations.tenant_id, team_invitations.role_id, team_invitations.status, team_invitations.expires_at
    into v_tenant_id, v_role_id, v_status, v_expires_at
  from public.team_invitations
  where team_invitations.id = p_invitation_id
  for update;

  if v_tenant_id is null then
    raise exception 'invitation_not_found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  select array_agg(p.key) into v_target_permission_keys
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = v_role_id;

  if not private.caller_can_grant_permissions(v_tenant_id, coalesce(v_target_permission_keys, array[]::text[])) then
    raise exception 'cannot revoke an invitation into a role with permissions you do not hold';
  end if;

  if v_status <> 'pending' then
    raise exception 'invitation_not_pending';
  end if;

  if v_expires_at <= now() then
    update public.team_invitations
    set status = 'expired', updated_at = now()
    where team_invitations.id = p_invitation_id;

    return query select p_invitation_id, 'expired'::text;
    return;
  end if;

  update public.team_invitations
  set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), updated_at = now()
  where team_invitations.id = p_invitation_id;

  perform private.log_audit_event(
    v_tenant_id, 'team_invitation.revoked', 'team_invitation', p_invitation_id, null, null
  );

  return query select p_invitation_id, 'revoked'::text;
end;
$$;

create or replace function public.revoke_team_invitation(p_invitation_id uuid)
returns table (
  id uuid,
  status text
)
language sql
security definer
set search_path = ''
as $$
  select * from private.revoke_team_invitation(p_invitation_id);
$$;

-- ---------------------------------------------------------------------
-- 8. accept_team_invitation
-- ---------------------------------------------------------------------

create or replace function private.accept_team_invitation(p_token text)
returns table (
  membership_id uuid,
  tenant_id uuid,
  role_id uuid,
  outcome text,
  staff_linked boolean,
  staff_link_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
  v_caller_email text;
  v_token_hash text;
  v_invitation_id uuid;
  v_tenant_id uuid;
  v_email text;
  v_role_id uuid;
  v_staff_member_id uuid;
  v_invited_by uuid;
  v_status text;
  v_expires_at timestamptz;
  v_accepted_by uuid;
  v_membership_id uuid;
  v_outcome text;
  v_staff_linked boolean := false;
  v_staff_link_reason text := null;
  v_existing_membership_id uuid;
  v_existing_membership_status text;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'authentication required';
  end if;

  select private.normalize_email(u.email) into v_caller_email
  from auth.users u
  where u.id = v_caller_id;

  if v_caller_email is null then
    raise exception 'authentication required';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception 'invitation_not_found';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- Bare "tenant_id"/"role_id" would be ambiguous — see
  -- create_team_invitation's own comment on this function's RETURNS
  -- TABLE OUT parameters (this function's OUT list also includes
  -- tenant_id and role_id).
  --
  -- Locate by hash and lock for the duration of this transaction so a
  -- concurrent resend/revoke/accept on the same invitation can't race
  -- this one — see PART 1's concurrency note for the same pattern.
  select team_invitations.id, team_invitations.tenant_id, team_invitations.email, team_invitations.role_id,
         team_invitations.staff_member_id, team_invitations.invited_by, team_invitations.status,
         team_invitations.expires_at, team_invitations.accepted_by
    into v_invitation_id, v_tenant_id, v_email, v_role_id, v_staff_member_id, v_invited_by, v_status, v_expires_at, v_accepted_by
  from public.team_invitations
  where team_invitations.token_hash = v_token_hash
  for update;

  if v_invitation_id is null then
    raise exception 'invitation_not_found';
  end if;

  -- References must still resolve before they're trusted below.
  if not exists (select 1 from public.tenants where tenants.id = v_tenant_id) then
    raise exception 'invitation_not_found';
  end if;
  if not exists (select 1 from public.roles where roles.id = v_role_id and roles.deleted_at is null) then
    raise exception 'invitation_not_found';
  end if;
  if v_staff_member_id is not null
     and not exists (select 1 from public.staff_members where staff_members.id = v_staff_member_id and staff_members.tenant_id = v_tenant_id) then
    raise exception 'invitation_not_found';
  end if;

  if v_status = 'revoked' then
    raise exception 'invitation_revoked';
  end if;

  if v_status = 'accepted' then
    -- One-time state transition with safe same-user idempotent replay:
    -- the mutation already happened. A different caller hard-fails —
    -- token possession alone was never sufficient; only the original
    -- accepted_by user may replay this.
    if v_accepted_by is distinct from v_caller_id then
      raise exception 'invitation_already_accepted';
    end if;

    select tm.id into v_membership_id
    from public.tenant_memberships tm
    where tm.tenant_id = v_tenant_id
      and tm.user_id = v_caller_id
      and tm.deleted_at is null;

    v_outcome := 'already_accepted';
  else
    -- Schema CHECK allows no value here other than 'pending'.
    if v_expires_at <= now() then
      update public.team_invitations
      set status = 'expired', updated_at = now()
      where team_invitations.id = v_invitation_id;
      raise exception 'invitation_expired';
    end if;

    -- Email-bound acceptance — no mismatch bypass, no platform-admin
    -- bypass, no service-role bypass in this user-facing path.
    -- v_email is already normalized at insert time
    -- (team_invitations_email_normalized), so a direct comparison of two
    -- normalized values is correct.
    if v_email <> v_caller_email then
      raise exception 'invitation_email_mismatch';
    end if;

    select tm.id, tm.status into v_existing_membership_id, v_existing_membership_status
    from public.tenant_memberships tm
    where tm.tenant_id = v_tenant_id
      and tm.user_id = v_caller_id
      and tm.deleted_at is null;

    if v_existing_membership_id is not null and v_existing_membership_status = 'suspended' then
      raise exception 'membership_suspended';
    end if;

    if v_existing_membership_id is not null then
      -- Membership appeared through another legitimate path after this
      -- invitation was created — accept without a second membership row.
      v_membership_id := v_existing_membership_id;
      v_outcome := 'already_member';
    else
      insert into public.tenant_memberships (tenant_id, user_id, role_id, status, invited_by)
      values (v_tenant_id, v_caller_id, v_role_id, 'active', v_invited_by)
      returning id into v_membership_id;

      v_outcome := 'accepted';
    end if;

    update public.team_invitations
    set status = 'accepted', accepted_at = now(), accepted_by = v_caller_id, updated_at = now()
    where team_invitations.id = v_invitation_id;

    perform private.log_audit_event(
      v_tenant_id, 'team_invitation.accepted', 'team_invitation', v_invitation_id,
      null, jsonb_build_object('membership_id', v_membership_id, 'outcome', v_outcome)
    );
  end if;

  -- Optional staff linking — concurrency-safe conditional update, never
  -- overwrites an existing link, never fails the already-created
  -- membership if the link can't be applied. Re-checked (read-only) on
  -- the idempotent-replay branch too, so a replay's response still
  -- reflects the current link state.
  if v_staff_member_id is not null and v_membership_id is not null then
    if exists (
      select 1 from public.staff_members
      where staff_members.id = v_staff_member_id and staff_members.tenant_membership_id = v_membership_id
    ) then
      v_staff_linked := true;
    else
      update public.staff_members
      set tenant_membership_id = v_membership_id, updated_at = now()
      where staff_members.id = v_staff_member_id
        and staff_members.tenant_id = v_tenant_id
        and staff_members.tenant_membership_id is null;

      if found then
        v_staff_linked := true;

        perform private.log_audit_event(
          v_tenant_id, 'team_invitation.staff_linked', 'staff_member', v_staff_member_id,
          null, jsonb_build_object('tenant_membership_id', v_membership_id)
        );
      else
        v_staff_linked := false;
        v_staff_link_reason := 'already_linked';
      end if;
    end if;
  end if;

  -- Safe result only — never the token, never PII beyond what the
  -- caller already knows about themselves.
  return query select v_membership_id, v_tenant_id, v_role_id, v_outcome, v_staff_linked, v_staff_link_reason;
end;
$$;

create or replace function public.accept_team_invitation(p_token text)
returns table (
  membership_id uuid,
  tenant_id uuid,
  role_id uuid,
  outcome text,
  staff_linked boolean,
  staff_link_reason text
)
language sql
security definer
set search_path = ''
as $$
  select * from private.accept_team_invitation(p_token);
$$;

-- ---------------------------------------------------------------------
-- 9. Grants — public wrappers only, authenticated only, no anon.
-- ---------------------------------------------------------------------
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default unless explicitly
-- revoked (the blanket "revoke execute on all functions in schema
-- private from public" in 20260815120014 only covered functions that
-- existed at that moment — every migration since has had to repeat this
-- per new function, e.g. 20260816090003). Every function this migration
-- adds — both invariant primitives/triggers and every invitation RPC,
-- private and public — gets that same explicit per-function revoke.

revoke execute on function private.tenant_has_active_unrestricted_holder(uuid) from public;
revoke execute on function private.assert_tenant_has_unrestricted_holder(uuid) from public;
revoke execute on function private.enforce_unrestricted_holder_on_membership_change() from public;
revoke execute on function private.enforce_unrestricted_holder_on_role_permission_change() from public;
revoke execute on function private.create_team_invitation(uuid, text, uuid, uuid) from public;
revoke execute on function private.list_team_invitations(uuid) from public;
revoke execute on function private.resend_team_invitation(uuid) from public;
revoke execute on function private.revoke_team_invitation(uuid) from public;
revoke execute on function private.accept_team_invitation(text) from public;

revoke execute on function public.create_team_invitation(uuid, text, uuid, uuid) from public;
revoke execute on function public.list_team_invitations(uuid) from public;
revoke execute on function public.resend_team_invitation(uuid) from public;
revoke execute on function public.revoke_team_invitation(uuid) from public;
revoke execute on function public.accept_team_invitation(text) from public;

grant execute on function public.create_team_invitation(uuid, text, uuid, uuid) to authenticated;
grant execute on function public.list_team_invitations(uuid) to authenticated;
grant execute on function public.resend_team_invitation(uuid) to authenticated;
grant execute on function public.revoke_team_invitation(uuid) to authenticated;
grant execute on function public.accept_team_invitation(text) to authenticated;
