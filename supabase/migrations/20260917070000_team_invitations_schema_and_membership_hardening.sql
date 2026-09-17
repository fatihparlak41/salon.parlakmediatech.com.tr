-- Faz SAAS.1B — team invitation schema foundation, plus a real security
-- hardening found while freshly re-verifying tenant_memberships' actual
-- live grants/RLS for this phase (not re-read from migration source,
-- which is exactly what let this gap go unnoticed in the SAAS.1A audit).
--
-- =====================================================================
-- STEP 1 FINDING — tenant_memberships direct INSERT bypasses the
-- permission ceiling
-- =====================================================================
-- Freshly queried DEV's actual live grants (security_audit_table_grants/
-- security_audit_column_grants), not assumed from migration source:
--
--   authenticated: table-level INSERT + SELECT on tenant_memberships,
--   plus a column-level UPDATE grant on `status` ONLY (confirmed via
--   security_audit_column_grants() — matches security-grants-
--   regression.test.ts's own existing "only column-level grant" test).
--   No table-level UPDATE, no DELETE grant at all.
--
-- UPDATE and DELETE are therefore ALREADY safe: role_id cannot be
-- changed by a direct browser UPDATE (no grant on that column — proven
-- by the existing tests/permission-ceiling.test.ts "cannot update
-- tenant_memberships.role_id directly" case), and only `status` is
-- directly writable (proven safe-but-real by tests/cross-tenant-
-- isolation.test.ts's "a member cannot escalate by updating their own
-- membership row" case — RLS excludes user_id = auth.uid(), and status
-- alone grants no additional permission regardless of value).
--
-- INSERT is the real gap. Policy tenant_memberships_insert_staff_manage
-- (20260815120016) is genuinely live and reachable:
--   with check (private.has_permission(tenant_id, 'staff.manage'))
-- — nothing here calls private.caller_can_grant_permissions() against
-- the inserted row's own role_id, the exact check create_role/
-- update_role_permissions/update_membership_role (20260816090003) all
-- already enforce for every OTHER role/membership mutation path.
--
-- Freshly confirmed exploitable, not hypothetical: SALON_MANAGER (a
-- default template) holds staff.manage but NOT permissions.
-- manage_unrestricted (re-verified this phase — see this phase's own
-- final report for the exact current 23-key catalog and per-template
-- mapping). A Manager — or the holder of any tenant-custom role with
-- staff.manage alone — could today INSERT a tenant_memberships row
-- directly via PostgREST for any other existing auth.users id, with any
-- role_id in the tenant, including one carrying permissions.
-- manage_unrestricted, bypassing the ceiling entirely.
--
-- Confirmed safe to close before adding any new write path: a
-- repo-wide search of lib/, app/, components/ found zero application
-- call sites performing a direct .insert() into tenant_memberships. The
-- only existing write path is private.create_tenant_with_owner
-- (SECURITY DEFINER, unaffected by this revoke — SECURITY DEFINER
-- functions run as their owner, not the calling role). The policy
-- becomes permanently unreachable once the grant is gone; dropped here
-- rather than left as inert, confusing cruft — matching this project's
-- own established hygiene (e.g. 20260816090004 removing the broader
-- platform_admin bypass it superseded, rather than leaving it inert).
--
-- Target posture after this migration: the ONLY ways a
-- tenant_memberships row can ever be created are private.create_tenant_
-- with_owner (bootstrap) and, once built in Faz SAAS.1C, private.
-- accept_team_invitation — both SECURITY DEFINER, both gated by
-- caller_can_grant_permissions() at invitation-creation time, neither
-- reachable via a raw grant.
revoke insert on public.tenant_memberships from authenticated;

drop policy tenant_memberships_insert_staff_manage on public.tenant_memberships;

-- =====================================================================
-- STEP 3 (documentation only, no code this phase) — the "last
-- unrestricted holder" invariant for Faz SAAS.1C
-- =====================================================================
-- Canonical invariant: a tenant must never lose its LAST active
-- membership whose effective role contains permissions.
-- manage_unrestricted. Never defined by role name, never merely
-- settings.manage + staff.manage (SALON_MANAGER already holds both
-- without holding manage_unrestricted — proven above).
--
-- Every EXISTING mutation path that could violate this invariant today,
-- freshly identified by reading each function's actual current body
-- (none of the three currently perform this check):
--
--   1. private.update_membership_role (20260816090003) — reassigns a
--      membership to a different role. If that membership held the
--      tenant's only manage_unrestricted-bearing role, reassignment to
--      any role without it would violate the invariant. No check exists
--      today.
--   2. Direct column-level UPDATE of tenant_memberships.status (the
--      live, narrow grant described above) — suspending the tenant's
--      last manage_unrestricted holder violates the invariant just as
--      surely as reassigning their role would, and requires no RPC at
--      all today. No check exists today (has_permission(tenant_id,
--      'staff.manage') AND user_id <> auth.uid() is the only gate).
--   3. private.update_role_permissions (20260816090003) — editing the
--      specific role that currently carries manage_unrestricted for a
--      tenant, removing that permission, with no other active
--      membership holding a role that also carries it. No check exists
--      today.
--
-- No membership soft-delete/removal RPC exists yet in this codebase (so
-- there is nothing to retroactively fix there) — but any future one
-- must include this same check from the moment it is built, as must
-- Faz SAAS.1C's own accept_team_invitation and any future
-- revoke/removal RPC this phase does not yet build.
--
-- Not implemented this phase, per this phase's own explicit instruction
-- ("do not implement last-owner protection yet unless required by the
-- membership-hardening change above") — the INSERT hardening above does
-- not itself require it, since INSERT can only ever ADD a membership,
-- never remove the last unrestricted holder. Left as a locked
-- requirement for Faz SAAS.1C to implement against all paths above
-- (plus its own new ones) in one pass, rather than partially covering
-- it here.

-- =====================================================================
-- STEP 5 — roles needs the same (id, tenant_id) unique constraint
-- staff_members already has (staff_members_id_tenant_id_key,
-- 20260905090000) — confirmed fresh via pg_constraint, not assumed;
-- staff_members' own constraint is reused as-is below, no duplicate.
-- =====================================================================
alter table public.roles
  add constraint roles_id_tenant_id_key unique (id, tenant_id);

-- =====================================================================
-- STEP 4/5/6/7/8 — public.team_invitations
-- =====================================================================
-- Deliberately separate from tenant_memberships, which cannot represent
-- a pre-registration invitee (user_id is NOT NULL — see the SAAS.1A
-- report). One row per invitation, insert/update-able only through
-- SECURITY DEFINER RPCs built in Faz SAAS.1C — never direct browser
-- access (Step 9 below).
create table public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),

  -- Normalized at the DB boundary, not only in future application code
  -- (Step 7's own explicit preference): a value that isn't already
  -- lower(btrim(...)) is rejected outright, so a future RPC bug that
  -- forgets to normalize fails loudly instead of silently storing an
  -- inconsistent value.
  email text not null,

  -- Both a plain FK (baseline referential integrity in isolation) and
  -- the composite same-tenant FK below — exactly the established
  -- two-constraint shape staff_members.tenant_membership_id already
  -- uses for the identical "optional link, must be this tenant's own
  -- row" requirement.
  role_id uuid not null references public.roles (id),
  staff_member_id uuid references public.staff_members (id),

  invited_by uuid not null references auth.users (id),

  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'expired', 'revoked')),

  -- Raw token is NEVER stored — only its hash. Faz SAAS.1C generates the
  -- token server-side and returns it exactly once; nothing in this
  -- schema can ever hold it in plaintext.
  token_hash text not null,

  expires_at timestamptz not null,

  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),

  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint team_invitations_role_same_tenant
    foreign key (role_id, tenant_id) references public.roles (id, tenant_id),
  constraint team_invitations_staff_member_same_tenant
    foreign key (staff_member_id, tenant_id) references public.staff_members (id, tenant_id),

  constraint team_invitations_email_normalized
    check (email = lower(btrim(email)) and char_length(email) > 0),

  -- Reasonable, not brittle (Step 8's own explicit instruction): only
  -- guarantees the row was never born already-expired. Says nothing
  -- about accepted_at/revoked_at relative ordering, which later state
  -- transitions don't need constrained here.
  constraint team_invitations_expires_after_created
    check (expires_at > created_at)
);

comment on table public.team_invitations is
  'Faz SAAS.1B — pending/accepted/expired/revoked email invitations to join a tenant. Deliberately separate from tenant_memberships (whose user_id is NOT NULL and so cannot represent a pre-registration invitee). RLS enabled, zero grants to anon/authenticated — every access goes through SECURITY DEFINER RPCs built in Faz SAAS.1C, never direct browser table access (Step 9). No invitation RPCs exist yet as of this migration; the table exists so their design has a stable target.';

comment on column public.team_invitations.email is
  'Always lower(btrim(...)) — enforced by team_invitations_email_normalized, not only by application code.';

comment on column public.team_invitations.role_id is
  'The tenant''s OWN roles row (never a role_template) — permissions derive transitively via role_permissions, exactly like tenant_memberships.role_id already works. No separate permissions column: a role already fully encodes both "which template it started from" and "its actual current permission set."';

comment on column public.team_invitations.staff_member_id is
  'Optional pre-link: if set, Faz SAAS.1C''s acceptance RPC links the resulting new membership to this staff_members row (subject to staff_members'' own existing unique-per-membership constraint at acceptance time). NULL is the common case — most invitations create a login-only membership with no staff record.';

comment on column public.team_invitations.token_hash is
  'sha256 of the raw invitation token, hash-then-compare — same discipline as lib/modules/notifications/cron-auth.ts''s CRON_SECRET verification. The raw token is never persisted anywhere.';

comment on column public.team_invitations.status is
  'pending -> accepted | revoked (both terminal). "expired" is a real persisted state for revoke/resend bookkeeping, but Faz SAAS.1C''s UI/API should treat status=''pending'' AND expires_at <= now() as effectively expired for display without waiting for any sweep — see this migration''s own header for why no cron is needed. Acceptance must independently re-check expires_at > now() regardless of the stored status.';

-- One-time token: a hash can never identify two different invitations.
create unique index team_invitations_token_hash_idx
  on public.team_invitations (token_hash);

-- At most one PENDING invitation per (tenant, normalized email) at a
-- time — mirrors tenant_memberships' own partial-unique-index
-- precedent ("a removed member can be re-invited later") exactly.
-- Historical accepted/revoked/expired rows never block a fresh
-- invitation, by construction (the partial WHERE excludes them).
--
-- Because this is scoped to status='pending' specifically: Faz SAAS.1C's
-- resend-after-expiry rule (documented above and in the final report)
-- must transactionally flip an expired-but-still-'pending' row to
-- 'expired' before inserting its replacement, never insert a second
-- 'pending' row alongside it — that transactional requirement is
-- exactly what this index exists to force at the database level, not
-- just document in a comment.
create unique index team_invitations_tenant_email_pending_idx
  on public.team_invitations (tenant_id, email)
  where status = 'pending';

-- Plain (unfiltered) index for the future "list every invitation for
-- this tenant, any status" query Faz SAAS.1D's team-management UI needs
-- — the partial index above only serves the pending-lookup case.
create index team_invitations_tenant_id_idx on public.team_invitations (tenant_id);

create trigger set_updated_at
  before update on public.team_invitations
  for each row execute function public.set_updated_at();

alter table public.team_invitations enable row level security;
-- Deliberately zero policies, zero grants to anon/authenticated (and no
-- grant to service_role either, beyond the standard schema-maintenance
-- baseline every table gets) — same double-lock posture as
-- notification_event_display_snapshots (Faz NOTIF.2F.1). Read/write
-- happens exclusively inside SECURITY DEFINER function bodies, none of
-- which exist yet as of this migration (Faz SAAS.1C). No raw invitation
-- row (token_hash, email, or otherwise) is ever exposed through a
-- browser SELECT.
