-- Faz NOTIF.2E.2 — durable Web Push delivery WORKER foundation. Builds
-- notification_deliveries -> device targets -> Web Push -> retry/stale
-- cleanup -> durable result. Remains completely INACTIVE: no cron, no
-- webhook, no API route, no trigger calls anything in this file. See
-- the activation-watermark section below for the mechanism that keeps
-- it off by construction, not by convention alone.
--
-- =====================================================================
-- FRESH AUDIT FINDINGS THIS MIGRATION IS BUILT FROM (not assumed —
-- confirmed by reading 20260908090000/20260908100000 (push_subscriptions),
-- 20260909100000/20260909110000 (notification_events), 20260914130000/
-- 20260914140000 (notification_deliveries + materialize_notification_
-- deliveries), 20260914120000/20260914121000 (test-send RPC), lib/pwa/
-- web-push-server.ts, lib/pwa/push-subscription.ts, public/sw.js,
-- public/sw-helpers.js, lib/supabase/admin.ts, lib/modules/settings/
-- actions.ts's sendTestPushNotificationAction, and tests/helpers.ts,
-- directly, in full, this session)
-- =====================================================================
--
-- 1. push_subscriptions.endpoint is UNIQUE (endpoint, tenant_membership_
--    id), not per-endpoint globally — CONFIRMED one tenant_membership_id
--    can already legitimately own MULTIPLE active (revoked_at is null)
--    rows, one per distinct physical device/endpoint. Multi-device
--    fanout is therefore a real, already-possible shape today, not a
--    hypothetical this migration invents a reason for.
--
-- 2. notification_deliveries (20260914130000) is the existing durable,
--    idempotent MEMBERSHIP-level outbox — one row per (event, membership,
--    channel), status in ('pending','processing','retry','sent','failed',
--    'skipped'), already carrying attempt_count/next_attempt_at/locked_at/
--    delivered_at/last_error_code/last_error_message. That table's OWN
--    comment already anticipated exactly this phase: "processing (a
--    future worker has claimed it, e.g. via locked_at)" — but a single
--    locked_at on the MEMBERSHIP row cannot safely represent "iPhone
--    already sent, iPad still retrying" at the same time, which is
--    exactly the gap Step 2 of this phase's own instructions names. This
--    migration does NOT repurpose notification_deliveries' own attempt_
--    count/locked_at/next_attempt_at columns for anything — they are left
--    exactly as NOTIF.2E.1 shipped them (unused by the new per-device
--    flow going forward; removing already-shipped columns is out of
--    scope and no future reader should assume they still drive delivery
--    processing — status is the one column this migration continues to
--    mutate, and only via the aggregation rule in private.finalize_
--    notification_delivery_status below).
--
-- 3. private.materialize_notification_deliveries(p_event_id) already
--    exists, is already idempotent (notification_event_materializations
--    completion marker, checked first) and already resolves eligible
--    RECIPIENT MEMBERSHIPS correctly (including the NOTIF.2E.1A event-
--    time staff snapshot fix). This phase reuses it completely unchanged
--    — private.materialize_pending_notification_events below is a thin
--    driver that discovers eligible event ids and calls this existing
--    function per id; it does not reimplement recipient resolution.
--
-- 4. lib/pwa/web-push-server.ts's sendTestPush is a FIXED-payload, single-
--    purpose function by its own explicit header comment: "NOT a general-
--    purpose push sender... A future automatic-delivery phase... should
--    still funnel through web-push's setVapidDetails/sendNotification the
--    same way, but that is a new function to add then, not a reason to
--    widen this one now." This migration's own TS counterpart (added in
--    the same phase, not in this SQL file) adds sendDeliveryPush as that
--    new function, reusing the module's already-private ensureConfigured
--    — sendTestPush itself is untouched, confirmed by diff.
--
-- 5. public/sw.js's push/notificationclick handlers (Faz NOTIF.2C) are
--    ALREADY generic: self.SalonOSPush.parsePushPayload already yields
--    {title, body, path} with safe fallbacks, and safeNotificationTargetPath
--    already restricts any click target to a same-origin, single-slash-
--    rooted relative path. Zero Service Worker changes are needed for
--    this phase — confirmed by reading both files in full — the worker
--    this migration enables just needs to send that exact {title,body,
--    path} JSON shape, which the existing SW already parses correctly.
--
-- 6. get_push_subscriptions_for_test_send (20260914121000) is the
--    established precedent for "a server-only, service_role-only RPC
--    that reads raw endpoint/p256dh/auth_key for the Node process to use,
--    never returned to a browser" — private.claim_notification_delivery_
--    targets below follows the identical shape (p_user_id-less here,
--    since there is no per-request user at all under a worker; identity
--    is the recipient's own tenant_membership_id already captured on the
--    notification_deliveries row at materialization time).
--
-- =====================================================================
-- WHY A NEW notification_delivery_targets TABLE (Step 2)
-- =====================================================================
-- A membership-level notification_deliveries row cannot safely represent
-- independent per-device retry state (iPhone succeeds, iPad transiently
-- fails -> naive whole-delivery retry would double-send the iPhone).
-- notification_delivery_targets is the durable per-(delivery,
-- subscription) state Step 2 asks for. It NEVER stores endpoint/p256dh/
-- auth_key — only push_subscription_id, a pointer; the secret material
-- stays exclusively in push_subscriptions, read only at claim time via
-- the same service_role-only pattern get_push_subscriptions_for_test_send
-- already established.
--
-- Tenant-safety: notification_deliveries and push_subscriptions both gain
-- purely additive UNIQUE(id, tenant_id)/UNIQUE(id, tenant_membership_id)
-- constraints below (id alone is already each table's PK, so every
-- existing row already trivially satisfies these) so that
-- notification_delivery_targets can carry THREE independent composite
-- tenant/membership-safe FKs — matching this project's own established
-- "plain + composite, for every independently-set tenant-scoped column"
-- precedent (staff_members_membership_same_tenant, notification_
-- deliveries_event_same_tenant/membership_same_tenant, ...) rather than
-- trusting application code alone to keep a denormalized tenant_id/
-- tenant_membership_id pair consistent with its parent rows.
--
-- =====================================================================
-- WHY A SEPARATE notification_delivery_activation SINGLETON (Step 3)
-- =====================================================================
-- "id integer primary key default 1 check (id = 1)" makes "at most one
-- row, ever" a structural guarantee enforced by Postgres itself (a second
-- INSERT violates the PK), not a convention a future caller could
-- accidentally violate. The table ships EMPTY (no seed INSERT anywhere
-- in this file) — every processing function below independently reads
-- this table first and fails closed (returns a zero-progress result,
-- never raises) when no row exists, at EVERY layer that could otherwise
-- do unsolicited work (materialize / prepare / claim), not just once at
-- the top — matching this schema's own established "double-lock, defense
-- in depth" philosophy (RLS-with-no-policies AND zero grants, e.g.)
-- rather than trusting a single top-level check.
--
-- =====================================================================
-- WHY event_type's PREFERENCE-COLUMN MAPPING IS DUPLICATED, NOT SHARED,
-- BETWEEN materialize_notification_deliveries AND claim_notification_
-- delivery_targets
-- =====================================================================
-- Both need "which notification_preferences boolean gates this
-- event_type" — extracting that into a shared function was considered
-- and rejected: it is a single 4-branch CASE, cheaper to duplicate
-- verbatim (as this project already duplicates whole eligibility
-- predicates rather than factoring them prematurely — see NOTIF.2E.1's
-- own header on why candidate_memberships/eligible_memberships are
-- written directly rather than composed from smaller named pieces) than
-- to introduce a new shared private function whose only two callers
-- already live in the same file and are easy to keep in sync by reading
-- both.
--
-- =====================================================================
-- DELIVERY AGGREGATION RULE (Step 13) — the one case the phase's own
-- 5 stated rules leave ambiguous, resolved explicitly here
-- =====================================================================
-- Given: "any non-terminal -> not final", "any sent (once all terminal)
-- -> sent", "no target -> skipped", "every stale/skipped -> skipped",
-- "every failed -> failed" — undefined for a TERMINAL mix with zero sent
-- that is neither "every stale/skipped" nor "every failed" (e.g. one
-- failed + one stale, neither sent). private.finalize_notification_
-- delivery_status below resolves this deliberately: once every target is
-- terminal, status is 'sent' if any target sent; else 'skipped' only if
-- EVERY remaining target is stale/skipped (zero failed); else 'failed' —
-- i.e. a single real failure among otherwise-stale/skipped targets still
-- marks the whole delivery failed, never silently downgraded to skipped.
-- This is a deliberate completion of the stated rules, not an oversight;
-- flagged explicitly in this phase's own final report.

-- =====================================================================
-- 1. Additive tenant/membership-safety constraints on EXISTING tables.
--    Zero behavior change to either table — every existing row already
--    satisfies these trivially (id is already each table's PK).
-- =====================================================================
alter table public.notification_deliveries
  add constraint notification_deliveries_id_tenant_id_key unique (id, tenant_id);

alter table public.notification_deliveries
  add constraint notification_deliveries_id_membership_key unique (id, tenant_membership_id);

comment on constraint notification_deliveries_id_tenant_id_key on public.notification_deliveries is
  'Faz NOTIF.2E.2 — purely additive. Lets notification_delivery_targets carry a genuine composite tenant-safe FK to this table.';
comment on constraint notification_deliveries_id_membership_key on public.notification_deliveries is
  'Faz NOTIF.2E.2 — purely additive. Lets notification_delivery_targets carry a genuine composite membership-safe FK to this table, so a target''s tenant_membership_id can never disagree with its own parent delivery''s.';

alter table public.push_subscriptions
  add constraint push_subscriptions_id_membership_key unique (id, tenant_membership_id);

comment on constraint push_subscriptions_id_membership_key on public.push_subscriptions is
  'Faz NOTIF.2E.2 — purely additive. Lets notification_delivery_targets carry a genuine composite FK proving a claimed subscription truly belongs to the membership it is being fanned out for.';

-- Faz NOTIF.2E.2 — durable "device targets already fanned out" marker
-- for a delivery. NULL = not yet attempted (the only state every
-- existing/NOTIF.2E.1-materialized row starts in); set exactly once, by
-- private.prepare_notification_delivery_targets, and never revisited —
-- Step 8's own "if another device is added after the event, do not
-- resurrect old terminal notifications automatically" rule is satisfied
-- by this being a one-time stamp, not a re-scan condition.
alter table public.notification_deliveries
  add column targets_prepared_at timestamptz;

comment on column public.notification_deliveries.targets_prepared_at is
  'Faz NOTIF.2E.2 — set once, by private.prepare_notification_delivery_targets, the first (and only) time this delivery''s device targets are fanned out from that moment''s active push_subscriptions. NULL means "not yet prepared" — the only worker-visible queue condition for this step. A device added later never re-triggers preparation for an already-prepared delivery.';

-- =====================================================================
-- 2. public.notification_delivery_activation — durable, platform-level,
--    fail-closed-by-absence activation watermark. Ships EMPTY. Not
--    tenant-scoped: this gates the WORKER MECHANISM globally, before any
--    per-tenant concern applies.
-- =====================================================================
create table public.notification_delivery_activation (
  id integer primary key default 1 check (id = 1),
  activated_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.notification_delivery_activation is
  'Faz NOTIF.2E.2 — true singleton (id integer primary key default 1 check (id = 1): a second row is structurally impossible). Empty = automatic delivery OFF. Every processing function in this migration (materialize_pending_notification_events, prepare_notification_delivery_targets, claim_notification_delivery_targets) independently reads this table first and fails closed (returns a zero-progress result, never an error) when it is empty. Historical cutover: future event discovery only ever considers notification_events.created_at >= activated_at, never deployment/migration/process-start time. Populated only by a later, separate, controlled activation phase (NOTIF.2E.3+) — for DEV tests only, a row may be inserted/deleted directly as fixture setup/cleanup, exactly like every other DEV-only fixture row in tests/helpers.ts.';

alter table public.notification_delivery_activation enable row level security;
-- Zero policies, zero grants to anon/authenticated/service_role below —
-- same double-lock as every other notification_* infrastructure table.
-- Read only via the SECURITY DEFINER RPCs in this file.

-- =====================================================================
-- 3. public.notification_delivery_targets — durable per-(delivery,
--    subscription) device fanout + retry state. Never stores endpoint/
--    p256dh/auth_key — push_subscription_id only, a pointer.
-- =====================================================================
create table public.notification_delivery_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  notification_delivery_id uuid not null,
  tenant_membership_id uuid not null,
  push_subscription_id uuid not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  delivered_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_delivery_targets_status_check
    check (status in ('pending', 'processing', 'retry', 'sent', 'stale', 'failed', 'skipped')),
  constraint notification_delivery_targets_attempt_count_check check (attempt_count >= 0),
  constraint notification_delivery_targets_error_code_check
    check (last_error_code is null or char_length(last_error_code) <= 100),
  constraint notification_delivery_targets_error_message_check
    check (last_error_message is null or char_length(last_error_message) <= 500),

  -- Step 2's own explicit "add a uniqueness contract preventing
  -- duplicate target creation for the same delivery + subscription".
  constraint notification_delivery_targets_dedup_key
    unique (notification_delivery_id, push_subscription_id),

  constraint notification_delivery_targets_tenant_id_fkey
    foreign key (tenant_id) references public.tenants (id),

  constraint notification_delivery_targets_delivery_id_fkey
    foreign key (notification_delivery_id) references public.notification_deliveries (id),
  constraint notification_delivery_targets_delivery_same_tenant
    foreign key (notification_delivery_id, tenant_id)
    references public.notification_deliveries (id, tenant_id),
  constraint notification_delivery_targets_delivery_same_membership
    foreign key (notification_delivery_id, tenant_membership_id)
    references public.notification_deliveries (id, tenant_membership_id),

  constraint notification_delivery_targets_subscription_id_fkey
    foreign key (push_subscription_id) references public.push_subscriptions (id),
  constraint notification_delivery_targets_subscription_same_membership
    foreign key (push_subscription_id, tenant_membership_id)
    references public.push_subscriptions (id, tenant_membership_id)
);

comment on table public.notification_delivery_targets is
  'Faz NOTIF.2E.2 — durable per-(notification_delivery, push_subscription) device fanout and retry state. status: pending -> processing (claimed, leased) -> sent | stale (404/410, subscription revoked, never retried) | retry (transient, next_attempt_at scheduled) -> ... -> sent|failed, or skipped (recipient no longer eligible at claim time, or the parent delivery had zero active devices). Never stores endpoint/p256dh/auth_key — those remain exclusively in push_subscriptions, read only via private.claim_notification_delivery_targets. Infrastructure data: RLS enabled with zero policies, zero grants to anon/authenticated — same posture as every other notification_* table. Composite FKs into notification_deliveries (id,tenant_id)/(id,tenant_membership_id) and push_subscriptions (id,tenant_membership_id) make a cross-tenant or cross-membership target structurally impossible to insert, not merely application-checked.';

comment on column public.notification_delivery_targets.locked_at is
  'Lease start, not a boolean lock. A target is claimable when status in (pending,retry) AND (locked_at is null OR locked_at <= now() - lease_interval) — a crashed worker''s lease expires on its own; no separate reclaim sweep is needed.';

comment on column public.notification_delivery_targets.lock_token is
  'Fencing token, reissued fresh on every successful claim. private.record_notification_delivery_target_result only applies a result WHERE lock_token matches what it was handed — if a lease already expired and a second worker re-claimed this target (getting a new token), the first (stale) worker''s eventual result write becomes a safe no-op instead of clobbering the second worker''s newer attempt.';

create index notification_delivery_targets_claim_idx
  on public.notification_delivery_targets (next_attempt_at)
  where status in ('pending', 'retry');

create index notification_delivery_targets_delivery_idx
  on public.notification_delivery_targets (notification_delivery_id);

create index notification_delivery_targets_subscription_idx
  on public.notification_delivery_targets (push_subscription_id);

create trigger set_updated_at
  before update on public.notification_delivery_targets
  for each row execute function public.set_updated_at();

alter table public.notification_delivery_targets enable row level security;
-- Zero policies, zero grants to anon/authenticated below — same
-- double-lock as notification_deliveries/notification_events/
-- push_subscriptions.

-- =====================================================================
-- 4. private.get_notification_delivery_activation — trivial read,
--    exists so the Node worker can cheaply short-circuit before calling
--    anything else, IN ADDITION TO (never instead of) every processing
--    function's own independent fail-closed check below.
-- =====================================================================
create function private.get_notification_delivery_activation()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select activated_at from public.notification_delivery_activation where id = 1;
$$;

comment on function private.get_notification_delivery_activation() is
  'Faz NOTIF.2E.2. Returns the singleton activated_at, or NULL when activation is absent (the default, and DEV/PROD''s current real state). A convenience read for the Node worker''s own short-circuit — every processing RPC below re-checks this independently regardless, and does not rely on the caller having checked first.';

revoke execute on function private.get_notification_delivery_activation() from public;

create function public.get_notification_delivery_activation()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_notification_delivery_activation();
$$;

comment on function public.get_notification_delivery_activation() is
  'Faz NOTIF.2E.2. service_role-only. Not callable by anon or authenticated — the activation watermark is a platform-operational fact, not any tenant''s own data.';

revoke execute on function public.get_notification_delivery_activation() from public;
revoke execute on function public.get_notification_delivery_activation() from anon;
revoke execute on function public.get_notification_delivery_activation() from authenticated;
grant execute on function public.get_notification_delivery_activation() to service_role;

-- =====================================================================
-- 5. private.materialize_pending_notification_events — Step 4/5. Fails
--    closed when activation is absent. Never scans unbounded history:
--    created_at >= activated_at AND not already materialized, bounded
--    batch, FOR UPDATE SKIP LOCKED so two concurrent calls never both
--    drive the same event id (materialize_notification_deliveries
--    itself is already idempotent regardless — this is belt-and-
--    suspenders against wasted duplicate work, not a correctness
--    dependency).
-- =====================================================================
create function private.materialize_pending_notification_events(p_batch_size integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activated_at timestamptz;
  v_event_id uuid;
  v_processed integer := 0;
  v_event_ids uuid[] := '{}';
begin
  select activated_at into v_activated_at from public.notification_delivery_activation where id = 1;

  if v_activated_at is null then
    return jsonb_build_object('processed', 0, 'reason', 'activation_absent');
  end if;

  if p_batch_size is null or p_batch_size <= 0 or p_batch_size > 500 then
    raise exception 'p_batch_size must be between 1 and 500' using errcode = 'WK001';
  end if;

  for v_event_id in
    select ne.id
    from public.notification_events ne
    where ne.created_at >= v_activated_at
      and not exists (
        select 1 from public.notification_event_materializations nem
        where nem.notification_event_id = ne.id
      )
    order by ne.created_at
    limit p_batch_size
    for update skip locked
  loop
    perform private.materialize_notification_deliveries(v_event_id);
    v_processed := v_processed + 1;
    v_event_ids := v_event_ids || v_event_id;
  end loop;

  return jsonb_build_object('processed', v_processed, 'eventIds', to_jsonb(v_event_ids));
end;
$$;

comment on function private.materialize_pending_notification_events(integer) is
  'Faz NOTIF.2E.2. Fails closed (processed=0, reason=activation_absent) when notification_delivery_activation is empty. Otherwise discovers up to p_batch_size unmaterialized notification_events with created_at >= activated_at, oldest first, and drives the EXISTING private.materialize_notification_deliveries per event id — never reimplements recipient resolution. FOR UPDATE SKIP LOCKED on the discovery select only (notification_events itself is never updated by this function, or by anything — it remains insert-only); this only prevents two concurrent callers from both processing the identical event id in the same instant.';

revoke execute on function private.materialize_pending_notification_events(integer) from public;

create function public.materialize_pending_notification_events(p_batch_size integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.materialize_pending_notification_events(p_batch_size);
end;
$$;

comment on function public.materialize_pending_notification_events(integer) is
  'Faz NOTIF.2E.2. service_role-only. Not wired to any cron/webhook/API route in this phase — callers today are the Node worker module (invoked only from tests) and nothing else.';

revoke execute on function public.materialize_pending_notification_events(integer) from public;
revoke execute on function public.materialize_pending_notification_events(integer) from anon;
revoke execute on function public.materialize_pending_notification_events(integer) from authenticated;
grant execute on function public.materialize_pending_notification_events(integer) to service_role;

-- =====================================================================
-- 6. private.finalize_notification_delivery_status — Step 13's
--    aggregation rule, as its own small helper reused by both the
--    ineligible-at-claim-time path and record_notification_delivery_
--    target_result. INTERNAL ONLY: no public wrapper, zero grants —
--    same "called only from sibling SECURITY DEFINER functions" shape
--    as private.enqueue_notification_event.
-- =====================================================================
create function private.finalize_notification_delivery_status(p_delivery_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_sent integer;
  v_nonterminal integer;
  v_failed integer;
  v_new_status text;
begin
  select
    count(*),
    count(*) filter (where status = 'sent'),
    count(*) filter (where status in ('pending', 'processing', 'retry')),
    count(*) filter (where status = 'failed')
  into v_total, v_sent, v_nonterminal, v_failed
  from public.notification_delivery_targets
  where notification_delivery_id = p_delivery_id;

  if v_total = 0 then
    v_new_status := 'skipped';
  elsif v_nonterminal > 0 then
    v_new_status := null;
  elsif v_sent > 0 then
    v_new_status := 'sent';
  elsif v_failed = 0 then
    v_new_status := 'skipped';
  else
    v_new_status := 'failed';
  end if;

  if v_new_status is not null then
    update public.notification_deliveries
    set status = v_new_status
    where id = p_delivery_id
      and status <> v_new_status;
  end if;

  return v_new_status;
end;
$$;

comment on function private.finalize_notification_delivery_status(uuid) is
  'Faz NOTIF.2E.2 Step 13. Recomputes notification_deliveries.status from the CURRENT set of its notification_delivery_targets rows: any non-terminal (pending/processing/retry) -> leaves status untouched (returns NULL, not final yet); else sent if any target sent; else skipped if every remaining target is stale/skipped (zero failed); else failed (at least one real failure, zero sent) — see this migration''s own header for why that last split is a deliberate resolution of an otherwise-ambiguous case. Idempotent and safe to call repeatedly. No public wrapper: called only from sibling SECURITY DEFINER functions in this file.';

revoke execute on function private.finalize_notification_delivery_status(uuid) from public;

-- =====================================================================
-- 7. private.prepare_notification_delivery_targets — Step 8. Fans a
--    'pending' notification_deliveries row (targets_prepared_at is null)
--    out into one notification_delivery_targets row per currently-active
--    push_subscription for that membership. Zero active devices -> the
--    delivery reaches a durable terminal 'skipped' immediately, not an
--    infinite wait for a device that may never appear.
-- =====================================================================
create function private.prepare_notification_delivery_targets(p_batch_size integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activated_at timestamptz;
  v_delivery record;
  v_prepared integer := 0;
  v_skipped_no_device integer := 0;
  v_active_count integer;
begin
  select activated_at into v_activated_at from public.notification_delivery_activation where id = 1;

  if v_activated_at is null then
    return jsonb_build_object('prepared', 0, 'skippedNoDevice', 0, 'reason', 'activation_absent');
  end if;

  if p_batch_size is null or p_batch_size <= 0 or p_batch_size > 500 then
    raise exception 'p_batch_size must be between 1 and 500' using errcode = 'WK001';
  end if;

  for v_delivery in
    select nd.id, nd.tenant_id, nd.tenant_membership_id
    from public.notification_deliveries nd
    where nd.targets_prepared_at is null
    order by nd.created_at
    limit p_batch_size
    for update skip locked
  loop
    insert into public.notification_delivery_targets (
      tenant_id, notification_delivery_id, tenant_membership_id, push_subscription_id, status
    )
    select v_delivery.tenant_id, v_delivery.id, v_delivery.tenant_membership_id, ps.id, 'pending'
    from public.push_subscriptions ps
    where ps.tenant_membership_id = v_delivery.tenant_membership_id
      and ps.revoked_at is null
    on conflict (notification_delivery_id, push_subscription_id) do nothing;

    select count(*) into v_active_count
    from public.push_subscriptions ps
    where ps.tenant_membership_id = v_delivery.tenant_membership_id
      and ps.revoked_at is null;

    update public.notification_deliveries
    set targets_prepared_at = now(),
        status = case when v_active_count = 0 then 'skipped' else status end
    where id = v_delivery.id;

    v_prepared := v_prepared + 1;
    if v_active_count = 0 then
      v_skipped_no_device := v_skipped_no_device + 1;
    end if;
  end loop;

  return jsonb_build_object('prepared', v_prepared, 'skippedNoDevice', v_skipped_no_device);
end;
$$;

comment on function private.prepare_notification_delivery_targets(integer) is
  'Faz NOTIF.2E.2 Step 8. Fails closed when activation is absent. For each targets_prepared_at IS NULL delivery (bounded batch, FOR UPDATE SKIP LOCKED so two concurrent callers never double-fan-out the same delivery), creates one target row per currently-active push_subscription for that membership (idempotent via the dedup unique constraint), stamps targets_prepared_at exactly once, and immediately marks the delivery terminally ''skipped'' if zero active devices exist — never left pending forever waiting for a device that may never be added. A device added AFTER this stamp never re-triggers preparation (targets_prepared_at is a one-time marker, not a re-scan condition), matching Step 8''s explicit "do not resurrect old terminal notifications" rule.';

revoke execute on function private.prepare_notification_delivery_targets(integer) from public;

create function public.prepare_notification_delivery_targets(p_batch_size integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.prepare_notification_delivery_targets(p_batch_size);
end;
$$;

comment on function public.prepare_notification_delivery_targets(integer) is
  'Faz NOTIF.2E.2. service_role-only. Not wired to any cron/webhook/API route in this phase.';

revoke execute on function public.prepare_notification_delivery_targets(integer) from public;
revoke execute on function public.prepare_notification_delivery_targets(integer) from anon;
revoke execute on function public.prepare_notification_delivery_targets(integer) from authenticated;
grant execute on function public.prepare_notification_delivery_targets(integer) to service_role;

-- =====================================================================
-- 8. private.claim_notification_delivery_targets — Steps 6+7 combined
--    deliberately: claim (FOR UPDATE SKIP LOCKED + a locked_at LEASE,
--    not a boolean, so a crashed worker's claim eventually expires on
--    its own + a fencing lock_token reissued on every claim) and
--    send-time eligibility recheck happen in the SAME transaction, the
--    only way to close the gap between "checked eligible" and "about to
--    send" without a race. An ineligible target is marked skipped here
--    and never returned to the caller as sendable.
-- =====================================================================
create function private.claim_notification_delivery_targets(
  p_batch_size integer default 25,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activated_at timestamptz;
  v_row record;
  v_is_eligible boolean;
  v_event_type text;
  v_tenant_slug text;
  v_endpoint text;
  v_p256dh text;
  v_auth_key text;
  v_result jsonb := '[]'::jsonb;
begin
  select activated_at into v_activated_at from public.notification_delivery_activation where id = 1;

  if v_activated_at is null then
    return '[]'::jsonb;
  end if;

  if p_batch_size is null or p_batch_size <= 0 or p_batch_size > 200 then
    raise exception 'p_batch_size must be between 1 and 200' using errcode = 'WK001';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 or p_lease_seconds > 3600 then
    raise exception 'p_lease_seconds must be between 1 and 3600' using errcode = 'WK001';
  end if;

  for v_row in
    with candidates as (
      select t.id
      from public.notification_delivery_targets t
      where t.status in ('pending', 'retry')
        and t.next_attempt_at <= now()
        and (t.locked_at is null or t.locked_at <= now() - (p_lease_seconds || ' seconds')::interval)
      order by t.next_attempt_at
      limit p_batch_size
      for update skip locked
    )
    update public.notification_delivery_targets t
    set status = 'processing',
        locked_at = now(),
        lock_token = gen_random_uuid()
    from candidates c
    where t.id = c.id
    returning t.id as target_id, t.lock_token, t.tenant_id, t.notification_delivery_id,
              t.tenant_membership_id, t.push_subscription_id, t.attempt_count
  loop
    -- Step 7 — recheck NOW, against CURRENT state: membership still
    -- active + same tenant + appointments.view + the event-type's own
    -- preference still enabled. Identical predicate shape to
    -- materialize_notification_deliveries' own eligible_memberships,
    -- re-applied rather than trusted from materialization time.
    select ne.event_type, t.slug,
      tm.status = 'active'
      and tm.deleted_at is null
      and tm.tenant_id = v_row.tenant_id
      and exists (
        select 1 from public.role_permissions rp
        join public.permissions perm on perm.id = rp.permission_id
        where rp.role_id = tm.role_id and perm.key = 'appointments.view'
      )
      and coalesce(
        case ne.event_type
          when 'appointment.created' then np.new_appointment
          when 'appointment.cancelled' then np.cancellation
          when 'appointment.rescheduled' then np.reschedule
          when 'appointment.staff_reassigned' then np.assignment_change
        end,
        true
      )
    into v_event_type, v_tenant_slug, v_is_eligible
    from public.tenant_memberships tm
    join public.notification_deliveries nd on nd.id = v_row.notification_delivery_id
    join public.notification_events ne on ne.id = nd.notification_event_id
    join public.tenants t on t.id = v_row.tenant_id
    left join public.notification_preferences np on np.tenant_membership_id = tm.id
    where tm.id = v_row.tenant_membership_id;

    if not coalesce(v_is_eligible, false) then
      update public.notification_delivery_targets
      set status = 'skipped',
          locked_at = null,
          lock_token = null,
          last_error_code = 'recipient_no_longer_eligible',
          last_error_message = 'recipient no longer eligible at send time'
      where id = v_row.target_id;

      perform private.finalize_notification_delivery_status(v_row.notification_delivery_id);
      continue;
    end if;

    select ps.endpoint, ps.p256dh, ps.auth_key
    into v_endpoint, v_p256dh, v_auth_key
    from public.push_subscriptions ps
    where ps.id = v_row.push_subscription_id;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'targetId', v_row.target_id,
      'lockToken', v_row.lock_token,
      'tenantId', v_row.tenant_id,
      'tenantSlug', v_tenant_slug,
      'notificationDeliveryId', v_row.notification_delivery_id,
      'pushSubscriptionId', v_row.push_subscription_id,
      'attemptCount', v_row.attempt_count,
      'eventType', v_event_type,
      'endpoint', v_endpoint,
      'p256dh', v_p256dh,
      'authKey', v_auth_key
    ));
  end loop;

  return v_result;
end;
$$;

comment on function private.claim_notification_delivery_targets(integer, integer) is
  'Faz NOTIF.2E.2 Steps 6+7. Fails closed (returns []) when activation is absent. Claims up to p_batch_size targets with status in (pending,retry), next_attempt_at due, and an expired-or-absent lease (locked_at older than p_lease_seconds, or never locked) via FOR UPDATE SKIP LOCKED — two concurrent callers structurally never claim the same target row. Reissues a fresh lock_token on every claim (fencing: a stale worker whose lease already expired and was reclaimed by someone else can no longer successfully record a result against the old token). Immediately rechecks recipient eligibility against CURRENT state before returning a target as sendable; an ineligible one is marked skipped and its parent delivery re-finalized in the same transaction, never returned to the caller. Returns raw endpoint/p256dh/authKey — the same service_role-only, never-to-a-browser pattern get_push_subscriptions_for_test_send already established — plus tenantSlug and eventType, everything the Node worker needs to build a payload and send, in one round trip.';

revoke execute on function private.claim_notification_delivery_targets(integer, integer) from public;

create function public.claim_notification_delivery_targets(
  p_batch_size integer default 25,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.claim_notification_delivery_targets(p_batch_size, p_lease_seconds);
end;
$$;

comment on function public.claim_notification_delivery_targets(integer, integer) is
  'Faz NOTIF.2E.2. service_role-only. Returns raw push subscription material for the Node worker to send with — never callable by anon/authenticated. Not wired to any cron/webhook/API route in this phase.';

revoke execute on function public.claim_notification_delivery_targets(integer, integer) from public;
revoke execute on function public.claim_notification_delivery_targets(integer, integer) from anon;
revoke execute on function public.claim_notification_delivery_targets(integer, integer) from authenticated;
grant execute on function public.claim_notification_delivery_targets(integer, integer) to service_role;

-- =====================================================================
-- 9. private.record_notification_delivery_target_result — Steps 12+13.
--    Fencing-token-checked (lock_token must still match); an unknown
--    target id or a mismatched token is a safe no-op, matching this
--    schema's own "unknown id is a no-op, never an error" convention.
-- =====================================================================
create function private.record_notification_delivery_target_result(
  p_target_id uuid,
  p_lock_token uuid,
  p_outcome text,
  p_error_code text default null,
  p_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_new_status text;
  v_new_attempt_count integer;
  v_next_attempt_at timestamptz;
  v_backoff_minutes integer;
  v_final_delivery_status text;
begin
  if p_outcome not in ('sent', 'stale', 'retry', 'failed') then
    raise exception 'invalid outcome: %', p_outcome using errcode = 'WK002';
  end if;

  select id, notification_delivery_id, push_subscription_id, attempt_count
  into v_target
  from public.notification_delivery_targets
  where id = p_target_id and lock_token = p_lock_token
  for update;

  if v_target.id is null then
    return jsonb_build_object('applied', false, 'reason', 'lock_token_mismatch_or_not_found');
  end if;

  if p_outcome = 'sent' then
    v_new_status := 'sent';
  elsif p_outcome = 'stale' then
    v_new_status := 'stale';
    update public.push_subscriptions
    set revoked_at = now()
    where id = v_target.push_subscription_id and revoked_at is null;
  elsif p_outcome = 'failed' then
    v_new_status := 'failed';
  else
    -- 'retry' — Step 12's bounded backoff: attempt 1 -> +1m, 2 -> +5m,
    -- 3 -> +15m, 4 -> +60m; a 5th transient failure exhausts retries and
    -- becomes terminal 'failed' rather than a 5th scheduled retry. Finite
    -- by construction: v_backoff_minutes is NULL for any attempt count
    -- past 4, which routes straight to the 'failed' branch below.
    v_new_attempt_count := v_target.attempt_count + 1;
    v_backoff_minutes := case v_new_attempt_count
      when 1 then 1
      when 2 then 5
      when 3 then 15
      when 4 then 60
      else null
    end;
    if v_backoff_minutes is null then
      v_new_status := 'failed';
    else
      v_new_status := 'retry';
      v_next_attempt_at := now() + (v_backoff_minutes || ' minutes')::interval;
    end if;
  end if;

  update public.notification_delivery_targets
  set status = v_new_status,
      attempt_count = coalesce(v_new_attempt_count, attempt_count),
      next_attempt_at = coalesce(v_next_attempt_at, next_attempt_at),
      locked_at = null,
      lock_token = null,
      delivered_at = case when v_new_status = 'sent' then now() else delivered_at end,
      last_error_code = case when v_new_status = 'sent' then null else left(p_error_code, 100) end,
      last_error_message = case when v_new_status = 'sent' then null else left(p_error_message, 500) end
  where id = p_target_id;

  v_final_delivery_status := private.finalize_notification_delivery_status(v_target.notification_delivery_id);

  return jsonb_build_object(
    'applied', true,
    'targetStatus', v_new_status,
    'deliveryStatus', coalesce(v_final_delivery_status, 'pending')
  );
end;
$$;

comment on function private.record_notification_delivery_target_result(uuid, uuid, text, text, text) is
  'Faz NOTIF.2E.2 Steps 12+13+14. p_outcome in (sent,stale,retry,failed). stale additionally revokes the underlying push_subscription (404/410 semantics — never retried again). retry applies the fixed 1m/5m/15m/60m backoff by attempt_count, becoming failed outright once attempt_count would exceed 4 (finite, no endless retry loop). Always clears the lease (locked_at/lock_token) regardless of outcome. Re-finalizes the parent delivery''s aggregate status (private.finalize_notification_delivery_status) in the same transaction. Fencing: applies nothing and returns applied=false if p_lock_token no longer matches (the lease already expired and was reclaimed by another worker) — never overwrites a newer attempt. Error text is length-capped server-side (100/500 chars) regardless of what the caller passes — never store endpoint/p256dh/auth_key/service_role key/VAPID private key/Authorization header/full subscription JSON here, only an HTTP-style code and a short sanitized message.';

revoke execute on function private.record_notification_delivery_target_result(uuid, uuid, text, text, text) from public;

create function public.record_notification_delivery_target_result(
  p_target_id uuid,
  p_lock_token uuid,
  p_outcome text,
  p_error_code text default null,
  p_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.record_notification_delivery_target_result(
    p_target_id, p_lock_token, p_outcome, p_error_code, p_error_message
  );
end;
$$;

comment on function public.record_notification_delivery_target_result(uuid, uuid, text, text, text) is
  'Faz NOTIF.2E.2. service_role-only. Not wired to any cron/webhook/API route in this phase.';

revoke execute on function public.record_notification_delivery_target_result(uuid, uuid, text, text, text) from public;
revoke execute on function public.record_notification_delivery_target_result(uuid, uuid, text, text, text) from anon;
revoke execute on function public.record_notification_delivery_target_result(uuid, uuid, text, text, text) from authenticated;
grant execute on function public.record_notification_delivery_target_result(uuid, uuid, text, text, text) to service_role;
