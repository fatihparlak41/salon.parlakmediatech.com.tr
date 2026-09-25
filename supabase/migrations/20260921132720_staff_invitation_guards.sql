-- Faz SAAS.1E.1 (part 12) — F: explicit, DB-enforced staff-invitation guards.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- create_team_invitation's optional p_staff_member_id only checked "does
-- this staff row exist, in THIS tenant, not deleted" — three gaps, all now
-- closed with explicit, non-leaking semantics:
--
--   * an INACTIVE staff member was a silently valid target (no different
--     from an active one) — now treated as invalid, same generic message as
--     "doesn't exist" (deleted / wrong tenant / inactive / nonexistent are
--     deliberately indistinguishable to the caller — no NEW leakage);
--   * an ALREADY-LINKED staff member (one with a live login already) could
--     receive a second invitation — now refused with a distinct, useful
--     message; useful because the caller is already staff.manage-authorized
--     to see the whole roster's link state (get_staff_management_details,
--     part 8), so "already linked" tells them nothing they couldn't already
--     see through the authorized management path;
--   * nothing stopped TWO pending invitations targeting the SAME staff
--     member (under different e-mails) — now one live pending invitation per
--     (tenant, staff member), enforced by a real unique index, not just an
--     application check (see below for why both layers exist).
--
-- A cross-tenant or forged staff uuid was already rejected without leakage
-- (the same generic "staff member not found in this tenant") and stays that
-- way — unaffected by this migration.
--
-- "Another staff's link cannot be taken over" was already true before this
-- migration: accept_team_invitation's staff-link UPDATE has always carried
-- `and staff_members.tenant_membership_id is null`, so accepting an
-- invitation never overwrites an existing link — it reports
-- staff_link_reason = 'already_linked' and still completes the membership.
-- This migration's one-pending-per-staff rule makes the RACE that used to
-- reach that path (two pending invitations for one staff member) impossible
-- to create in the first place; the no-overwrite guard remains as the
-- second, independent layer for any invitation that predates this release.
--
-- =====================================================================
-- WHY BOTH AN APPLICATION CHECK AND A UNIQUE INDEX
-- =====================================================================
--
-- The application check (an EXISTS lookup before the INSERT) gives a clean
-- error to the ordinary sequential caller. Two truly CONCURRENT invitations
-- for the same staff member both pass that check before either commits — a
-- classic check-then-act race — so the real guarantee is the new partial
-- unique index below: exactly one INSERT can ever win, and the other's
-- unique_violation is caught and turned into the same clean error, never a
-- raw constraint-violation leaking to the caller. The email-scoped guard
-- (team_invitations_tenant_email_pending_idx, 20260917070000) already
-- follows this same two-layer pattern; this mirrors it for staff.
--
-- Valid invite-WITHOUT-staff is untouched (every new check is guarded by
-- `p_staff_member_id is not null`). Acceptance's own no-overwrite behavior
-- is untouched.
--
-- =====================================================================
-- STAGED-RELEASE GATE (added during the SAAS.1E.1 expand/contract split)
-- =====================================================================
--
-- private.release_gates and the shared private.assert_role_activation_allowed
-- helper are defined earlier, in release_gate_foundation (20260921132660) —
-- that same migration also applies the identical gate to update_membership_role
-- and reactivate_membership, the two already-on-PROD paths that could
-- otherwise bypass this entirely (invite a second Owner, then downgrade
-- them; or reactivate a suspended non-unrestricted membership). The check
-- here is PERMISSION-based (does the target role hold
-- permissions.manage_unrestricted), never role-key-based — a tenant's own
-- pre-existing custom role is judged the same way a brand-new Personel
-- would be, not exempted merely because its key differs.

create unique index if not exists team_invitations_tenant_staff_pending_idx
  on public.team_invitations (tenant_id, staff_member_id)
  where status = 'pending' and staff_member_id is not null;

create or replace function private.create_team_invitation(p_tenant_id uuid, p_email text, p_role_id uuid, p_staff_member_id uuid default null)
returns table(id uuid, tenant_id uuid, email text, role_id uuid, staff_member_id uuid, status text, expires_at timestamptz, created_at timestamptz, token text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_email text;
  v_role_tenant_id uuid;
  v_staff_tenant_id uuid;
  v_staff_membership_id uuid;
  v_existing_user_id uuid;
  v_existing_membership_status text;
  v_raw_token text;
  v_token_hash text;
  v_invitation_id uuid;
  v_expires_at timestamptz;
  v_created_at timestamptz;
  v_constraint text;
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

  -- Staged-release gate — see this migration's own header and
  -- release_gate_foundation. Permission-based: exempts any role that holds
  -- permissions.manage_unrestricted (a tenant's own unrestricted role, or a
  -- pre-existing custom role that happens to be unrestricted), regardless
  -- of key; blocks everything else while the gate is closed.
  --
  -- Concurrency: lock the ROLE row itself (not lock_tenant_for_management —
  -- this caller only needs staff.manage to be HERE at all, already checked
  -- above; a bare row lock, no extra authority check, is what actually
  -- matters) so a concurrent update_role_permissions on the SAME role
  -- (which takes this exact lock too) cannot interleave between this check
  -- and the INSERT below.
  --
  -- Qualified as roles.id, not bare id: this function's own RETURNS TABLE
  -- declares an id OUT parameter (see this function's opening comment on
  -- ambiguity), and a bare id here resolves to that OUT parameter instead
  -- of the table column, raising "column reference is ambiguous."
  perform 1 from public.roles where roles.id = p_role_id for update;
  perform private.assert_role_activation_allowed(p_tenant_id, p_role_id);

  if p_staff_member_id is not null then
    -- Faz SAAS.1E.1 (F) — explicit, non-leaking target validity: must exist,
    -- in THIS tenant, not deleted, and ACTIVE. Deleted / wrong-tenant /
    -- inactive / nonexistent all collapse to the same generic message, same
    -- as before this migration — inactive is simply now included in "not a
    -- valid target" rather than silently accepted.
    select staff_members.tenant_id, staff_members.tenant_membership_id
      into v_staff_tenant_id, v_staff_membership_id
    from public.staff_members
    where staff_members.id = p_staff_member_id
      and staff_members.deleted_at is null
      and staff_members.status = 'active';

    if v_staff_tenant_id is null or v_staff_tenant_id <> p_tenant_id then
      raise exception 'staff member not found in this tenant';
    end if;

    -- Faz SAAS.1E.1 (F) — an already-linked staff member cannot receive a
    -- second access invitation. Distinct message: the caller is already
    -- staff.manage-authorized to see this fact through the roster.
    if v_staff_membership_id is not null then
      raise exception 'staff_already_linked';
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

  -- A. Transition stale pending rows for this tenant/email OR this
  -- tenant/staff member first, so neither partial-pending unique index
  -- ever collides with a row that is pending only on paper.
  update public.team_invitations
  set status = 'expired', updated_at = now()
  where team_invitations.tenant_id = p_tenant_id
    and team_invitations.status = 'pending'
    and team_invitations.expires_at <= now()
    and (
      team_invitations.email = v_email
      or (p_staff_member_id is not null and team_invitations.staff_member_id = p_staff_member_id)
    );

  -- B. Block a genuinely still-pending invitation to the same e-mail.
  if exists (
    select 1 from public.team_invitations
    where team_invitations.tenant_id = p_tenant_id
      and team_invitations.email = v_email
      and team_invitations.status = 'pending'
  ) then
    raise exception 'pending_invitation_exists';
  end if;

  -- B2 (Faz SAAS.1E.1, F) — one live pending invitation per staff member,
  -- application-layer half of the guard (see header for why both layers
  -- exist).
  if p_staff_member_id is not null and exists (
    select 1 from public.team_invitations
    where team_invitations.tenant_id = p_tenant_id
      and team_invitations.staff_member_id = p_staff_member_id
      and team_invitations.status = 'pending'
  ) then
    raise exception 'staff_pending_invitation_exists';
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

  -- Faz SAAS.1E.1 (F) — the DB-level half of the one-pending-per-staff
  -- guard: two truly concurrent calls can both pass the B2 check above
  -- before either commits; team_invitations_tenant_staff_pending_idx lets
  -- exactly one INSERT win, and the loser's unique_violation is turned
  -- into the same clean error a sequential caller would have seen, never a
  -- raw constraint-violation. (The pre-existing per-email index is
  -- guarded the same way — see the pending_invitation_exists branch.)
  begin
    insert into public.team_invitations (
      tenant_id, email, role_id, staff_member_id, invited_by, status, token_hash, expires_at
    )
    values (
      p_tenant_id, v_email, p_role_id, p_staff_member_id, auth.uid(), 'pending', v_token_hash, now() + interval '7 days'
    )
    returning team_invitations.id, team_invitations.expires_at, team_invitations.created_at
      into v_invitation_id, v_expires_at, v_created_at;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'team_invitations_tenant_staff_pending_idx' then
        raise exception 'staff_pending_invitation_exists';
      else
        raise exception 'pending_invitation_exists';
      end if;
  end;

  -- Never the raw token or its hash in the audit payload.
  perform private.log_audit_event(
    p_tenant_id, 'team_invitation.created', 'team_invitation', v_invitation_id,
    null,
    jsonb_build_object('email', v_email, 'role_id', p_role_id, 'staff_member_id', p_staff_member_id)
  );

  return query select
    v_invitation_id, p_tenant_id, v_email, p_role_id, p_staff_member_id, 'pending'::text, v_expires_at, v_created_at, v_raw_token;
end;
$function$;
