-- Faz SAAS.1C.1R — Pre-release role integrity hardening.
--
-- Fresh audit finding, ahead of PROD release: public.roles granted
-- `authenticated` a full table-level UPDATE (every column, gated only by
-- the roles_update_staff_manage RLS policy's staff.manage check — no
-- column-level restriction, unlike tenant_memberships' own narrower
-- status-only grant). private.has_permission() never joins public.roles
-- at all, so it does not independently enforce roles.tenant_id =
-- tenant_memberships.tenant_id or roles.deleted_at is null — those are
-- left entirely to whatever the mutation surface happens to allow.
--
-- Audit results (DEV, fresh, not assumed):
--   - Application call-site audit: zero application code anywhere calls
--     .from("roles").update(...) or any equivalent. Every real usage is
--     read-only (embedded `roles(name)` selects in lib/auth/session.ts
--     and lib/modules/staff/queries.ts). No role-renaming/editing UI or
--     Server Action exists. The UPDATE grant and its RLS policy are
--     dead weight with zero legitimate dependency.
--   - tenant_memberships.role_id -> roles.id was a PLAIN FK only — no
--     composite (role_id, tenant_id) -> roles(id, tenant_id) FK existed,
--     unlike staff_members.tenant_membership_id's own established
--     tenant-safe composite shape. Checked all 9 existing DEV
--     tenant_memberships rows against the composite before adding it
--     below: zero violations, so no backfill was needed.
--   - Role soft-delete is not a real supported product operation today:
--     zero roles in DEV currently have deleted_at set, no UI/RPC ever
--     sets it, and create_role/create_tenant_with_owner both always set
--     tenant_id to the caller's own already-validated tenant_id at
--     INSERT time (never caller-supplied independently). The only
--     reachable path that could ever have set roles.tenant_id or
--     roles.deleted_at to something unexpected was the table-level
--     UPDATE grant this migration revokes.
--
-- Given the above, private.has_permission() is judged safe to leave
-- unchanged: once the UPDATE grant is gone and no RPC ever writes
-- roles.tenant_id/deleted_at, those two columns become immutable for
-- the life of a role from any authenticated-reachable path, so
-- has_permission's join (which never touches roles at all) can no
-- longer observe a "wrong" tenant_id or a role that was soft-deleted
-- out from under existing holders. This is a smaller-blast-radius fix
-- than touching has_permission, which every RLS policy and permission
-- check in the application depends on.
--
-- Chosen hardening (narrowest safe fix, per the structural-preference
-- over an application-only patch):
--   1. Tenant-safe composite FK: tenant_memberships(role_id, tenant_id)
--      -> roles(id, tenant_id), reusing roles_id_tenant_id_key from
--      SAAS.1B — mirrors staff_members' own established two-constraint
--      shape. This is now a DB-level guarantee, not merely an
--      application-level check (update_membership_role and
--      create_team_invitation already validated this themselves, but a
--      structural constraint holds regardless of which code path writes
--      the row).
--   2. `revoke update on public.roles from authenticated` and drop the
--      now-dead roles_update_staff_manage policy. authenticated retains
--      SELECT (read) and the (already grant-less, RPC-only) INSERT path
--      via create_role — nothing else changes.
--   3. private.accept_team_invitation's existing role-validity check
--      (added deleted_at is null in 20260917080000) is extended to also
--      require roles.tenant_id = the invitation's own tenant — closing
--      the one genuine remaining gap: a pending invitation must not
--      become a way to activate a role that is no longer valid for that
--      tenant, and the prior check only covered "not deleted", not
--      "still this tenant's role". (In practice this was already
--      unreachable in DEV — nothing could change roles.tenant_id once
--      the UPDATE grant above is revoked — but the RPC's own check
--      should not depend on that being true elsewhere; it is now
--      explicit and self-contained, and the composite FK above would
--      also have caught it structurally at the membership INSERT even
--      without this.) create_team_invitation, resend_team_invitation
--      and revoke_team_invitation needed no change: create already
--      checked both tenant_id and deleted_at at invitation-creation
--      time; resend/revoke only mutate the invitation row itself and
--      never create a membership or grant access, so a stale role
--      reference there carries no reachable exploit.

-- ---------------------------------------------------------------------
-- 1. Tenant-safe composite FK on tenant_memberships.role_id
-- ---------------------------------------------------------------------

alter table public.tenant_memberships
  add constraint tenant_memberships_role_same_tenant
  foreign key (role_id, tenant_id) references public.roles (id, tenant_id);

-- ---------------------------------------------------------------------
-- 2. Remove authenticated's direct UPDATE access to roles
-- ---------------------------------------------------------------------

revoke update on public.roles from authenticated;
drop policy if exists roles_update_staff_manage on public.roles;

-- ---------------------------------------------------------------------
-- 3. accept_team_invitation: role-validity check now also requires the
--    role still belongs to the invitation's own tenant, not only that
--    it isn't soft-deleted.
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
  if not exists (select 1 from public.tenants where tenants.id = v_tenant_id) then
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
