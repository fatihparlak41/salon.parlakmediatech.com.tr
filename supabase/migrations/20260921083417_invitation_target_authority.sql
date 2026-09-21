-- Faz SAAS.1E.0 (part 2) — Invitation TARGET authority.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- 20260921061657 made every MEMBER-management RPC judge the authority
-- over the TARGET on effective permissions (a caller may act on a member
-- only when the target's permission set is a STRICT subset of the
-- caller's, or the caller holds permissions.manage_unrestricted). The
-- invitation RPCs were left on the older, weaker rule: create_,
-- resend_ and revoke_team_invitation only checked the GRANT CEILING
-- (the invitation's role permissions must be CONTAINED in the caller's).
-- Containment includes EQUALITY, so once a non-owner holds staff.manage:
--   - a Yönetici could create, resend and revoke invitations into a role
--     with EXACTLY their own permission set — minting or destroying
--     peers of equal authority, which the member RPCs already forbid
--     ("a Yönetici may not manage another Yönetici");
--   - any caller who merely held staff.manage in ANOTHER tenant was told
--     `staff.manage required` for a foreign invitation id, which proves
--     the id exists (an existence oracle across tenants);
--   - resend accepted an invitation whose role had since been deleted,
--     mailing a link that can never be accepted.
--
-- This migration closes those gaps with the SAME authority primitives the
-- member RPCs use (private.caller_permission_keys, role_permission_keys,
-- is_strict_subset), never with role names or keys.
--
-- =====================================================================
-- DESIGN
-- =====================================================================
--
-- One decision, private.invitation_role_authority_decision(tenant, role,
-- action), used by create, resend and revoke alike:
--
--   caller not an ACTIVE member of the tenant            -> not_a_member
--   caller lacks staff.manage                            -> staff_manage_required
--   role is deleted / not of this tenant                 -> role_not_found
--        (revoke is exempt: see below)
--   caller holds permissions.manage_unrestricted         -> ok
--   role permissions NOT contained in the caller's       -> permission_ceiling
--        (the pre-existing grant-ceiling rule, unchanged)
--   role permissions a STRICT subset of the caller's     -> ok
--   otherwise (equal sets: a peer or the caller's own    -> insufficient_authority
--   level)
--
-- Matrix (Owner = unrestricted; Manager = staff.manage + others):
--   Owner       -> any role incl. Owner and peers ......... ALLOW
--   Manager     -> role with fewer permissions ............ ALLOW
--   Manager     -> role with EQUAL permissions ............ DENY (insufficient_authority)
--   Manager     -> Owner role / any role with a permission
--                  the Manager lacks ...................... DENY (ceiling message, unchanged)
--   no staff.manage / not a member / other tenant ......... DENY
--
-- A role that is deleted grants nothing (SAAS.1E.0 part 1), so an
-- invitation into it can never be accepted (accept_team_invitation
-- already refuses it). Resend therefore refuses it (role_not_found).
-- Revoke deliberately still works for it: revoking only removes access,
-- and without it the stale pending row would block re-inviting that
-- e-mail (pending_invitation_exists) until it expires.
--
-- The invitation's TENANT is never client-supplied: resend/revoke take
-- only the invitation id and derive the tenant from the row, and
-- team_invitations_role_same_tenant ties the role to that same tenant.
--
-- Lock protocol (unchanged shape, cheaper gate): the invitation row is
-- still locked FOR UPDATE and the decision is taken on the locked row, so
-- the optimistic expires_at fence and every state transition behave
-- exactly as before. Only ACTIVE staff.manage members of the
-- invitation's tenant ever reach the row lock (an unlocked gate runs
-- first), so a stranger holding a leaked invitation id cannot contend
-- for it. NO tenant-row lock is taken here on purpose: accept_team_invitation
-- holds the invitation row and then needs a KEY SHARE on the tenant row
-- (foreign-key checks), so a tenant lock taken before the invitation row
-- could deadlock against it. The invitation RPCs never lock any row the
-- member-management RPCs lock, and vice versa, so no wait cycle exists.
--
-- Error contract (all previous messages are kept for the previous
-- conditions, so the deployed mappers keep working):
--   create: `authentication required`, `staff.manage required`,
--           `role not found in this tenant`,
--           `cannot invite into a role with permissions you do not hold`,
--           and NEW `insufficient_authority` (equal permission set).
--   resend: `invitation_not_found` (now also for any caller who is not an
--           active member of the invitation's tenant), `staff.manage
--           required`, `cannot resend an invitation into a role with
--           permissions you do not hold`, NEW `insufficient_authority`,
--           NEW `role_not_found`, `invitation_not_pending`,
--           `invitation_changed`.
--   revoke: same family; no role_not_found.
--
-- Audit is unchanged and exactly once per success: team_invitation.created
-- / .resent / .revoked, with no raw token, hash or e-mail in resend/revoke
-- (created keeps its email/role_id/staff_member_id payload). A refused call
-- raises before any write, so it leaves no audit row and no state change.
-- The raw token is returned only to the authorized caller of create and
-- resend.
--
-- Not changed: invitation acceptance, list_team_invitations,
-- log_team_invitation_email_delivery, every table, grant and policy.
--
-- One hardening beyond the authority rule, in resend only: a NULL
-- p_expected_expires_at used to skip the optimistic fence silently
-- (NULL <> x is NULL). It now raises invitation_changed like any other
-- stale observation. The deployed client always sends the observed value.

-- =====================================================================
-- PART 1 — the shared decision
-- =====================================================================

create or replace function private.invitation_role_authority_decision(
  p_tenant_id uuid,
  p_role_id uuid,
  p_action text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role_keys text[];
  v_caller_keys text[];
begin
  if auth.uid() is null then
    return 'authentication_required';
  end if;

  if p_action is null or p_action not in ('create', 'resend', 'revoke') then
    return 'invalid_action';
  end if;

  if not private.is_tenant_member(p_tenant_id) then
    return 'not_a_member';
  end if;

  if not private.has_permission(p_tenant_id, 'staff.manage') then
    return 'staff_manage_required';
  end if;

  if not exists (
    select 1
    from public.roles r
    where r.id = p_role_id
      and r.tenant_id = p_tenant_id
      and r.deleted_at is null
  ) then
    if p_action = 'revoke' then
      return 'ok';
    end if;
    return 'role_not_found';
  end if;

  if private.has_permission(p_tenant_id, 'permissions.manage_unrestricted') then
    return 'ok';
  end if;

  v_role_keys := private.role_permission_keys(p_role_id);
  v_caller_keys := private.caller_permission_keys(p_tenant_id);

  if not (v_role_keys <@ v_caller_keys) then
    return 'permission_ceiling';
  end if;

  if private.is_strict_subset(v_role_keys, v_caller_keys) then
    return 'ok';
  end if;

  return 'insufficient_authority';
end;
$$;

-- Raises the message each RPC has always used for the conditions it has
-- always had, and the new stable code for the new ones.
create or replace function private.assert_invitation_role_authority(
  p_tenant_id uuid,
  p_role_id uuid,
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
  v_decision := private.invitation_role_authority_decision(p_tenant_id, p_role_id, p_action);

  if v_decision = 'ok' then
    return;
  end if;

  raise exception '%', case v_decision
    when 'authentication_required' then 'authentication required'
    when 'not_a_member' then
      case when p_action = 'create' then 'staff.manage required' else 'invitation_not_found' end
    when 'staff_manage_required' then 'staff.manage required'
    when 'role_not_found' then
      case when p_action = 'create' then 'role not found in this tenant' else 'role_not_found' end
    when 'permission_ceiling' then
      case p_action
        when 'create' then 'cannot invite into a role with permissions you do not hold'
        when 'resend' then 'cannot resend an invitation into a role with permissions you do not hold'
        else 'cannot revoke an invitation into a role with permissions you do not hold'
      end
    else v_decision
  end;
end;
$$;

-- =====================================================================
-- PART 2 — create_team_invitation (only the ceiling step changes)
-- =====================================================================

create or replace function private.create_team_invitation(
  p_tenant_id uuid,
  p_email text,
  p_role_id uuid,
  p_staff_member_id uuid default null
)
returns table(
  id uuid,
  tenant_id uuid,
  email text,
  role_id uuid,
  staff_member_id uuid,
  status text,
  expires_at timestamp with time zone,
  created_at timestamp with time zone,
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

  -- Authority over the target ROLE: the pre-existing grant ceiling (the
  -- role's full permission set must be contained in the caller's) PLUS
  -- the strict-subset rule, or permissions.manage_unrestricted. Same
  -- decision as resend/revoke — never duplicated here.
  perform private.assert_invitation_role_authority(p_tenant_id, p_role_id, 'create');

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

-- =====================================================================
-- PART 3 — resend_team_invitation
-- =====================================================================

create or replace function private.resend_team_invitation(
  p_invitation_id uuid,
  p_expected_expires_at timestamp with time zone
)
returns table(id uuid, status text, expires_at timestamp with time zone, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_locked_tenant_id uuid;
  v_role_id uuid;
  v_status text;
  v_expires_at timestamptz;
  v_raw_token text;
  v_token_hash text;
  v_new_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Unlocked gate. The tenant is DERIVED from the invitation — there is no
  -- client-supplied tenant to forge — and only an ACTIVE staff.manage
  -- member of THAT tenant may go on to lock the row. Everyone else gets
  -- the answer for a nonexistent invitation, so an invitation id cannot be
  -- probed across tenants.
  select team_invitations.tenant_id into v_tenant_id
  from public.team_invitations
  where team_invitations.id = p_invitation_id;

  if v_tenant_id is null or not private.is_tenant_member(v_tenant_id) then
    raise exception 'invitation_not_found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  -- Bare "id"/"status" would be ambiguous — see create_team_invitation's
  -- own comment on this function's RETURNS TABLE OUT parameters.
  select team_invitations.tenant_id, team_invitations.role_id, team_invitations.status, team_invitations.expires_at
    into v_locked_tenant_id, v_role_id, v_status, v_expires_at
  from public.team_invitations
  where team_invitations.id = p_invitation_id
  for update;

  if v_locked_tenant_id is distinct from v_tenant_id then
    raise exception 'invitation_not_found';
  end if;

  -- The authoritative decision, on the locked row: membership, staff.manage,
  -- role still live, and authority over the role's CURRENT permissions.
  perform private.assert_invitation_role_authority(v_tenant_id, v_role_id, 'resend');

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

  -- Optimistic fencing — a stale (or missing) observation never rotates
  -- the token. See 20260918070000 for the full concurrency argument.
  if p_expected_expires_at is null or v_expires_at <> p_expected_expires_at then
    raise exception 'invitation_changed';
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

-- =====================================================================
-- PART 4 — revoke_team_invitation
-- =====================================================================

create or replace function private.revoke_team_invitation(p_invitation_id uuid)
returns table(id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_locked_tenant_id uuid;
  v_role_id uuid;
  v_status text;
  v_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Unlocked gate — see resend_team_invitation.
  select team_invitations.tenant_id into v_tenant_id
  from public.team_invitations
  where team_invitations.id = p_invitation_id;

  if v_tenant_id is null or not private.is_tenant_member(v_tenant_id) then
    raise exception 'invitation_not_found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  -- Bare "id"/"status" would be ambiguous — see create_team_invitation's
  -- own comment on this function's RETURNS TABLE OUT parameters.
  select team_invitations.tenant_id, team_invitations.role_id, team_invitations.status, team_invitations.expires_at
    into v_locked_tenant_id, v_role_id, v_status, v_expires_at
  from public.team_invitations
  where team_invitations.id = p_invitation_id
  for update;

  if v_locked_tenant_id is distinct from v_tenant_id then
    raise exception 'invitation_not_found';
  end if;

  -- Revoking an invitation into a DELETED role stays possible (cleanup);
  -- see the migration header.
  perform private.assert_invitation_role_authority(v_tenant_id, v_role_id, 'revoke');

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

-- =====================================================================
-- PART 5 — grants for the two NEW helpers only
-- =====================================================================
--
-- create or replace keeps the existing ACLs of create/resend/revoke.
-- The helpers are called only from SECURITY DEFINER functions that run as
-- their owner, so no role needs EXECUTE on them.

revoke execute on function private.invitation_role_authority_decision(uuid, uuid, text) from public;
revoke execute on function private.assert_invitation_role_authority(uuid, uuid, text) from public;
