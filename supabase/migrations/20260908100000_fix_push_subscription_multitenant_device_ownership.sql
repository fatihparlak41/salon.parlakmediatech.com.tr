-- Faz NOTIF.2A.1 — corrects a real architecture gap in 20260908090000
-- (already applied to DEV, deliberately not edited — this is a
-- forward-only fix). Minimum necessary change only: one constraint swap
-- and one function body, both scoped to push_subscriptions. Nothing
-- about notification_preferences, remove_push_subscription's body, or
-- list_my_devices's body needs to change — see below for exactly why.
--
-- =====================================================================
-- THE PROBLEM, CONFIRMED, NOT ASSUMED
-- =====================================================================
-- push_subscriptions.endpoint was globally UNIQUE, and
-- save_push_subscription's ON CONFLICT (endpoint) reassigned a row's
-- tenant_membership_id outright on every save. That correctly handles
-- one real case (a different auth user claiming the same physical
-- device) but silently breaks another real, already-supported case:
-- freshly confirmed against live DEV that tenant_memberships already
-- enforces "at most one active membership per (tenant_id, user_id)"
-- (tenant_memberships_tenant_user_idx, a UNIQUE INDEX on (tenant_id,
-- user_id) WHERE deleted_at IS NULL — see 20260815120008) but places NO
-- limit on how many DIFFERENT tenants one user_id can hold active
-- memberships in, and NOTIF.2A's own tests (#28) already exercise
-- exactly that shape. A single browser has exactly one physical Web
-- Push endpoint per origin — so the same auth user, active in two
-- tenants, subscribing from the same phone, was having their SECOND
-- tenant's save silently steal the endpoint away from the first. Not a
-- security hole (both sides were still the same real user), but a real
-- correctness bug: Tenant A would stop receiving pushes the moment the
-- same person subscribed while looking at Tenant B.
--
-- =====================================================================
-- THE CORRECTED MODEL
-- =====================================================================
-- UNIQUE (endpoint, tenant_membership_id), not UNIQUE (endpoint) alone.
-- Because tenant_membership_id already uniquely identifies one
-- (tenant, user) pair (the constraint confirmed above), this composite
-- key is sufficient on its own — no third mapping table is needed, and
-- none is added. It allows exactly the right shape: the same endpoint
-- may have one row per membership the SAME user legitimately holds, but
-- still exactly one row per (endpoint, membership) pair (re-subscribing
-- the same tenant from the same device upserts in place, never
-- duplicates).
--
-- save_push_subscription now revokes a DIFFERENT auth user's active
-- rows for this exact endpoint (across every tenant that other user had
-- registered it for — the physical device no longer belongs to them at
-- all once someone else claims it) before upserting the caller's own
-- (endpoint, their own membership) row. Rows belonging to the CALLER's
-- OTHER tenant memberships are never touched — that is the entire point
-- of this correction.
--
-- =====================================================================
-- WHY remove_push_subscription AND list_my_devices NEED NO BODY CHANGE
-- =====================================================================
-- Re-read both against the corrected table shape before touching
-- anything, per this phase's own instruction not to accept the fix
-- blindly: remove_push_subscription already operates on ONE ROW by its
-- own id (`where id = p_subscription_id`), and list_my_devices already
-- filters by joining to tenant_memberships on `tm.tenant_id =
-- p_tenant_id` — neither ever matched or grouped by endpoint. Once a
-- shared endpoint can back two DIFFERENT rows (one per membership), a
-- device id returned by list_my_devices(tenantA) was ALWAYS the
-- tenantA-scoped row specifically, and revoking it by that id was
-- always going to leave the (different-id) tenantB row untouched. The
-- bug lived entirely in the table's uniqueness rule and the ON CONFLICT
-- target that assumed it — both functions' own logic was already
-- correctly tenant-scoped and needed no change, only their comments
-- below are refreshed to state this explicitly, per this phase's "keep
-- the RPC semantics tenant-scoped and document this clearly"
-- instruction. The distinction between "disable notifications for this
-- salon" (this RPC, unchanged) and "remove this device entirely" (a
-- future client-side concern — revoking every row for an endpoint the
-- browser itself is unsubscribing) is deliberately left to whichever
-- phase first builds the client, not decided here.

alter table public.push_subscriptions
  drop constraint push_subscriptions_endpoint_key;

alter table public.push_subscriptions
  add constraint push_subscriptions_endpoint_membership_key unique (endpoint, tenant_membership_id);

comment on table public.push_subscriptions is
  'Faz NOTIF.2A, corrected in NOTIF.2A.1 — one row per (endpoint, tenant_membership_id): the same physical browser endpoint may back multiple rows when the same auth user holds active memberships in more than one tenant, but never more than one row for the same (endpoint, membership) pair. No direct grant to authenticated/anon whatsoever — save/remove/list only via the SECURITY DEFINER RPCs. Never exposes endpoint/p256dh/auth_key outside those RPCs; list_my_devices deliberately omits all three.';

create or replace function private.save_push_subscription(
  p_tenant_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth_key text,
  p_device_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'NF001';
  end if;

  if p_endpoint is null or length(btrim(p_endpoint)) = 0
     or p_p256dh is null or length(btrim(p_p256dh)) = 0
     or p_auth_key is null or length(btrim(p_auth_key)) = 0 then
    raise exception 'endpoint, p256dh, and auth_key are required' using errcode = 'NF002';
  end if;

  select id into v_membership_id
  from public.tenant_memberships
  where tenant_id = p_tenant_id
    and user_id = auth.uid()
    and status = 'active'
    and deleted_at is null;

  if v_membership_id is null then
    raise exception 'active tenant membership required' using errcode = 'NF003';
  end if;

  -- Faz NOTIF.2A.1 — the corrected account-switch step: revoke every
  -- OTHER auth user's active row for this exact endpoint, across every
  -- tenant that other user had it registered for. Deliberately NOT
  -- scoped to p_tenant_id — the device no longer belongs to that other
  -- user at all, in any of their tenants, once this caller claims it.
  -- Rows whose membership belongs to THIS caller (their own other
  -- memberships) never match tm.user_id <> auth.uid() and are left
  -- alone — that preservation is the entire point of this migration.
  update public.push_subscriptions ps
  set revoked_at = now()
  from public.tenant_memberships tm
  where tm.id = ps.tenant_membership_id
    and ps.endpoint = p_endpoint
    and ps.revoked_at is null
    and tm.user_id <> auth.uid();

  insert into public.push_subscriptions (
    tenant_membership_id, endpoint, p256dh, auth_key, device_label, last_seen_at, revoked_at
  )
  values (
    v_membership_id, p_endpoint, p_p256dh, p_auth_key, p_device_label, now(), null
  )
  on conflict (endpoint, tenant_membership_id) do update
  set p256dh = excluded.p256dh,
      auth_key = excluded.auth_key,
      device_label = excluded.device_label,
      updated_at = now(),
      last_seen_at = now(),
      revoked_at = null
  returning id into v_subscription_id;

  return jsonb_build_object('id', v_subscription_id, 'deviceLabel', p_device_label);
end;
$$;

comment on function private.save_push_subscription(uuid, text, text, text, text) is
  'Faz NOTIF.2A, corrected in NOTIF.2A.1. Derives the caller''s own active membership for p_tenant_id from auth.uid() — never accepts one as input. Before upserting, revokes any OTHER auth user''s active rows for this exact endpoint (every tenant they had it in, not just p_tenant_id) — the account-switch safety property. Rows belonging to the CALLER''s own other tenant memberships are never touched, so the same physical device can legitimately hold one active row per tenant the same user is active in. ON CONFLICT (endpoint, tenant_membership_id) upserts in place for a re-subscribe of the same tenant from the same device. Returns only the row''s id and label, never endpoint/p256dh/auth_key.';

-- Faz NOTIF.2A.1 — comment-only refresh; neither function body below
-- changed (see this migration's own header for why the fix lived
-- entirely in the table constraint and save_push_subscription above).
comment on function private.remove_push_subscription(uuid) is
  'Faz NOTIF.2A, semantics confirmed correct as-is in NOTIF.2A.1. Soft-revoke (revoked_at, not a delete) of exactly the one row named by p_subscription_id — since NOTIF.2A.1, a given endpoint may back one row per tenant membership the caller holds, so this was always, and remains, tenant-scoped: revoking the row for Tenant A''s membership never touches a different row backing the same physical endpoint for Tenant B. This is "disable notifications for this salon", not "remove this device entirely" — a future client-side flow that wants the latter would need to revoke every row for an endpoint, which is not what this RPC does and not decided here. Ownership proven via a join back through tenant_memberships.user_id; never trusts a caller-supplied membership or tenant id because none is accepted.';

comment on function private.list_my_devices(uuid) is
  'Faz NOTIF.2A, semantics confirmed correct as-is in NOTIF.2A.1. Scoped by tm.tenant_id = p_tenant_id, so it was always, and remains, per-membership: if the same physical endpoint backs rows for two of the caller''s tenants, each tenant''s own call to this RPC returns only that tenant''s row (its own id), never the other tenant''s. Returns id/deviceLabel/createdAt/lastSeenAt/revoked only — never endpoint, p256dh, or auth_key. Empty array for no active membership (no side channel), same convention as this project''s public-booking RPCs.';
