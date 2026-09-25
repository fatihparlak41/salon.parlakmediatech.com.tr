-- Faz SAAS.1E.1 (part 11) — A: invitation-list privacy by authority, not role
-- name. B/C: acceptance revalidates the INVITER's CURRENT authority before
-- granting a new membership, not just their authority at invite-creation time.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- create_team_invitation / resend_team_invitation / revoke_team_invitation
-- already gate on the ACTING caller's current, effective permission set
-- (private.assert_invitation_role_authority, via auth.uid()) — every one of
-- them re-evaluates authority live because the caller IS the actor. Two gaps
-- remained, both proven on DEV against the real provisioned roles:
--
--   A. list_team_invitations returned EVERY invitation of the tenant to any
--      staff.manage holder, including invitations into the Owner role and
--      into an equal (peer) role — a Yönetici could read who was invited to
--      become Owner, and their e-mail.
--
--   B. accept_team_invitation is called by the INVITEE, not the inviter, and
--      trusted whatever authority the inviter had at CREATE time. Removing,
--      suspending or demoting the inviter after the invitation was sent did
--      not stop it from still minting a full membership.
--
--   C. The invited role's permission set can change after the invitation was
--      created (an owner edits it, or a template sync adds a key). Acceptance
--      granted the role's CURRENT set, which could by then exceed what the
--      original inviter was ever allowed to grant.
--
-- =====================================================================
-- A — list_team_invitations: same authority rule as create/resend/revoke
-- =====================================================================
--
-- An unrestricted caller (permissions.manage_unrestricted) sees every
-- invitation, exactly as before. A normal staff.manage caller now sees only
-- invitations whose target role's permission set is a STRICT SUBSET of their
-- own — the identical ceiling create_team_invitation already enforces before
-- letting them create one, so "can I see this invitation" and "could I have
-- created this invitation" are the same question. No role name or key is
-- compared, only effective permission sets (private.is_strict_subset, the
-- same primitive SAAS.1E.0 built for exactly this). Consequences, all
-- confirmed by the new tests: a Yönetici (16 keys) sees Resepsiyon and
-- Personel invitations, never Owner, another Yönetici, or a role with an
-- incomparable key. Existence of the invitation ROW is unaffected by this
-- change either way — a non-member still gets 'staff.manage required' from
-- the unlocked top-level gate, exactly as before, so a tenant/invitation
-- cannot be probed by an outsider.
--
-- =====================================================================
-- B/C — accept_team_invitation: the inviter's authority, revalidated
-- =====================================================================
--
-- private.membership_permission_keys(tenant, user) and
-- private.has_permission_as(tenant, user, key) are the arbitrary-actor
-- generalizations of the existing auth.uid()-only
-- private.caller_permission_keys / private.has_permission. Both existing
-- functions are redefined (CREATE OR REPLACE, IDENTICAL signature and
-- therefore identical OID, ACL and every RLS policy that references them by
-- OID) to simply call the new ones with auth.uid() — pure refactor, zero
-- behavior change for every existing caller. has_permission keeps its
-- existing EXECUTE grant to authenticated (used directly by app code and by
-- RLS policies); the two new functions get none, same as
-- caller_permission_keys and role_permission_keys already have none.
--
-- accept_team_invitation gains, in the branch that is ABOUT TO GRANT A NEW
-- MEMBERSHIP (the invitee has no existing active membership yet — the
-- already_member / already_accepted replay branches change NOTHING and
-- create no new access, so re-checking a historical inviter's authority
-- there would refuse a harmless no-op for no security benefit):
--
--   1. the tenant is checked live (deleted_at is null), not merely existing;
--   2. the inviter (invited_by) still holds a live, ACTIVE membership in
--      this tenant;
--   3. the inviter is CURRENTLY unrestricted, OR the invited role's CURRENT
--      permission set is still a strict subset of the inviter's CURRENT
--      permission set — the exact same ceiling assert_invitation_role_
--      authority applies at create/resend/revoke time, evaluated fresh.
--
-- Any failure raises the SAME 'invitation_not_found' the token-not-found /
-- wrong-tenant / deleted-role paths already raise — indistinguishable from
-- "this invitation cannot be used," on purpose (no detail about the inviter,
-- another tenant, or why is ever returned to the invitee), no new audit row
-- (matching every other silent failure branch of this function), and no
-- token mutation — an invitation whose inviter later regains sufficient
-- authority (or is re-authorized by someone else with the same role) simply
-- starts working again, because the check is re-evaluated fresh on every
-- attempt rather than baked in once. Token secrecy, the email-match rule,
-- idempotent replay-by-the-same-user, and the no-overwrite staff-link
-- behavior are all untouched.

-- ---------------------------------------------------------------------
-- helpers: arbitrary-actor generalizations, existing ones now delegate
-- ---------------------------------------------------------------------

create or replace function private.has_permission_as(p_tenant_id uuid, p_user_id uuid, p_permission_key text)
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
      and tm.user_id = p_user_id
      and tm.status = 'active'
      and tm.deleted_at is null
      and p.key = p_permission_key
  );
$$;

create or replace function private.membership_permission_keys(p_tenant_id uuid, p_user_id uuid)
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
    and tm.user_id = p_user_id
    and tm.status = 'active'
    and tm.deleted_at is null;
$$;

-- Pure refactor: same signature, same OID, same ACL, same behavior for
-- every existing caller (RLS policies included — they hold the OID, not the
-- name, and CREATE OR REPLACE never changes either the OID or the grants of
-- a function whose signature is unchanged).
create or replace function private.has_permission(p_tenant_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission_as(p_tenant_id, auth.uid(), p_permission_key);
$$;

create or replace function private.caller_permission_keys(p_tenant_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select private.membership_permission_keys(p_tenant_id, auth.uid());
$$;

-- A brand-new function defaults to EXECUTE granted to PUBLIC (and therefore
-- to authenticated, a member of PUBLIC) until explicitly revoked — the
-- revokes must run BEFORE the grant is asserted away, not after.
revoke execute on function private.has_permission_as(uuid, uuid, text) from public;
revoke execute on function private.membership_permission_keys(uuid, uuid) from public;

do $$
begin
  if not has_function_privilege('authenticated', 'private.has_permission(uuid, text)', 'execute') then
    raise exception 'refactor changed a grant: authenticated lost EXECUTE on private.has_permission';
  end if;
  if has_function_privilege('authenticated', 'private.has_permission_as(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'private.membership_permission_keys(uuid, uuid)', 'execute') then
    raise exception 'a new arbitrary-actor helper is reachable by authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- A — list_team_invitations
-- ---------------------------------------------------------------------

create or replace function private.list_team_invitations(p_tenant_id uuid)
returns table(id uuid, email text, role_id uuid, role_name text, staff_member_id uuid, staff_member_name text, status text, effective_status text, expires_at timestamptz, created_at timestamptz, invited_by_name text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_is_unrestricted boolean;
  v_caller_keys text[];
begin
  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  v_is_unrestricted := private.has_permission(p_tenant_id, 'permissions.manage_unrestricted');
  v_caller_keys := private.caller_permission_keys(p_tenant_id);

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
    and (
      v_is_unrestricted
      or private.is_strict_subset(private.role_permission_keys(r.id), v_caller_keys)
    )
  order by ti.created_at desc;
end;
$function$;

-- ---------------------------------------------------------------------
-- B/C — accept_team_invitation
-- ---------------------------------------------------------------------

create or replace function private.accept_team_invitation(p_token text)
returns table(membership_id uuid, tenant_id uuid, role_id uuid, outcome text, staff_linked boolean, staff_link_reason text)
language plpgsql
security definer
set search_path = ''
as $function$
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
  -- this one — see PART 1's concurrency note in 20260917080000.
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

  -- References must still resolve before they're trusted below. The
  -- role check now requires BOTH not-deleted AND still this invitation's
  -- own tenant — a pending invitation must never become a way to
  -- activate a role that is no longer valid for that tenant (Faz
  -- SAAS.1C.1R). tenant_memberships_role_same_tenant (added by this same
  -- migration) would also catch a cross-tenant role structurally at the
  -- INSERT below, but this check gives a clean, explicit error instead
  -- of a raw constraint-violation leaking to the caller.
  --
  -- Faz SAAS.1E.1 (B/C item 2) — "target tenant is live": a soft-deleted
  -- tenant is treated exactly like a nonexistent one, not merely a
  -- missing row.
  if not exists (select 1 from public.tenants where tenants.id = v_tenant_id and tenants.deleted_at is null) then
    raise exception 'invitation_not_found';
  end if;
  if not exists (
    select 1 from public.roles
    where roles.id = v_role_id and roles.tenant_id = v_tenant_id and roles.deleted_at is null
  ) then
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
    -- accepted_by user may replay this. Already-granted access is not
    -- re-examined against the inviter's CURRENT authority (see the
    -- header) — nothing new is being granted on this path.
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
      -- No NEW access is granted here, so the inviter-authority gate
      -- below does not apply to this branch (see the header).
      v_membership_id := v_existing_membership_id;
      v_outcome := 'already_member';
    else
      -- Faz SAAS.1E.1 (B/C items 4+5) — revalidate the INVITER's CURRENT
      -- authority right before it is actually exercised: a live, active
      -- membership in this tenant, and either unrestricted or the
      -- invited role's CURRENT permission set still a strict subset of
      -- the inviter's CURRENT permission set. A since-removed/suspended
      -- inviter, one who lost the permission that justified the invite,
      -- or a role that grew past what they could ever grant, all fail
      -- here — safely, with the same generic error the caller already
      -- gets for a dead invitation, no detail leaked, no audit row.
      if not (
        exists (
          select 1 from public.tenant_memberships im
          where im.tenant_id = v_tenant_id
            and im.user_id = v_invited_by
            and im.status = 'active'
            and im.deleted_at is null
        )
        and (
          private.has_permission_as(v_tenant_id, v_invited_by, 'permissions.manage_unrestricted')
          or private.is_strict_subset(
            private.role_permission_keys(v_role_id),
            private.membership_permission_keys(v_tenant_id, v_invited_by)
          )
        )
      ) then
        raise exception 'invitation_not_found';
      end if;

      -- Staged-release gate (private.release_gates, defined in
      -- release_gate_foundation) — this is the exact moment a genuinely
      -- NEW membership is about to be created. A pending invitation that
      -- predates this release entirely (targeting an existing custom
      -- non-unrestricted role) must not bypass the gate just because it
      -- was never touched by create_team_invitation's own check.
      --
      -- Concurrency: lock the ROLE row itself before checking it — this
      -- caller (the invitee) has no staff.manage in this tenant, so
      -- lock_tenant_for_management is not usable here; a bare row lock on
      -- public.roles needs no such authority and is exactly what
      -- update_role_permissions's own "for update" on the same row
      -- contends against, closing the window between this read and the
      -- INSERT below.
      perform 1 from public.roles where id = v_role_id for update;
      perform private.assert_role_activation_allowed(v_tenant_id, v_role_id);

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
$function$;
