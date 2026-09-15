-- Faz NOTIF.2E.2A — cutover + subscription safety hardening. Corrective,
-- forward-only — 20260915070000 is NOT edited (already applied to DEV,
-- already has an audited SHA-256). Every function below is a CREATE OR
-- REPLACE with an UNCHANGED signature, matching this project's own
-- established precedent for exactly this shape of fix (e.g.
-- 20260914140000's own header on why 20260914130000 is never edited in
-- place).
--
-- =====================================================================
-- BUG 1, CONFIRMED BY FRESH RE-AUDIT (not assumed): the activation
-- watermark protected event DISCOVERY only, not target PREPARATION or
-- CLAIM
-- =====================================================================
-- private.materialize_pending_notification_events (20260915070000) only
-- ever discovers events with created_at >= activated_at — correct, and
-- unchanged here. But private.materialize_notification_deliveries
-- itself (the underlying, already-existing RPC this function drives,
-- reused unchanged since Faz NOTIF.2E.1) has NEVER been gated on
-- activation at all — it is unconditional by design, exactly as it was
-- before this whole phase existed. Calling it DIRECTLY for a
-- pre-activation event (which is exactly what this migration's own new
-- regression tests do, and which nothing before this fix prevented any
-- future caller from doing) produces a real, pending
-- notification_deliveries row with no memory of its own event's
-- created_at.
--
-- Re-read private.prepare_notification_delivery_targets and private.
-- claim_notification_delivery_targets against that fact, fresh: NEITHER
-- ever joined back to notification_events to check created_at against
-- activated_at — prepare only checked targets_prepared_at IS NULL,
-- claim only checked target status/next_attempt_at/lease. A delivery
-- materialized for a pre-activation event, sitting there with
-- targets_prepared_at IS NULL, would be fanned out into REAL sendable
-- device targets by prepare the moment activation is later turned on,
-- and any target that already existed for one would be returned as
-- sendable by claim — both silently violating "an event created before
-- activated_at can never be delivered."
--
-- FIX: both functions now independently re-derive the underlying
-- event's created_at (via the same notification_deliveries ->
-- notification_events join already established elsewhere in this
-- schema) and compare it against the SAME >= activated_at contract
-- private.materialize_pending_notification_events already uses —
-- belt-and-suspenders defense in depth at every stage, not trust that
-- an earlier stage already enforced it. Historical rows are never
-- mutated or deleted to "fix" this — a pre-activation delivery is
-- resolved to a durable, inert 'skipped' terminal state (prepare) or an
-- individual target is resolved to 'skipped' with a distinct diagnostic
-- code (claim), exactly the same shape already established for "zero
-- active devices" and "recipient no longer eligible" — never silently
-- dropped, never left to hang forever unprepared/unclaimable either.
--
-- =====================================================================
-- BUG 2, CONFIRMED BY FRESH RE-AUDIT: claim never re-checked the exact
-- subscription's OWN current revoked_at
-- =====================================================================
-- private.prepare_notification_delivery_targets already filters
-- push_subscriptions.revoked_at IS NULL at FAN-OUT time — correct,
-- unchanged. But private.claim_notification_delivery_targets's own
-- final SELECT (endpoint/p256dh/auth_key, immediately before returning
-- a target as sendable to the Node worker) never re-read revoked_at at
-- all — it trusted prepare's earlier snapshot forever. A device can be
-- unsubscribed/revoked in the real gap between prepare and claim (the
-- whole point of a durable, retryable outbox is that this gap can be
-- long). revoked_at IS NULL is this project's own canonical, and only,
-- "is this subscription active" predicate — confirmed by re-checking
-- every existing reader of push_subscriptions (list_my_devices,
-- get_push_subscriptions_for_test_send, this function's own prepare
-- counterpart): none of them layer any other condition (no separate
-- enabled flag, no expiry column) on top of it.
--
-- FIX: claim now re-reads revoked_at for the exact push_subscription_id
-- on every claimed row, immediately before deciding whether to return
-- endpoint/key material at all. A revoked subscription's material is
-- NEVER placed into the returned jsonb — the Node worker cannot send to
-- it even if it wanted to, not merely "is told not to". The target is
-- marked 'skipped' with diagnostic code 'subscription_inactive' (never
-- 'stale' — that code means the PUSH SERVICE itself reported 404/410
-- during a real send attempt; a locally-already-known revocation is a
-- distinct, cheaper-to-detect case that should never even reach the
-- transport) and the parent delivery is re-finalized in the same
-- transaction, same as every other ineligibility path.
--
-- =====================================================================
-- WHY BOTH FIXES SHARE ONE COMBINED ELIGIBILITY CHECK IN CLAIM
-- =====================================================================
-- Recipient-eligibility, activation-watermark, and subscription-active
-- are three independent reasons a claimed target might not actually be
-- sendable. All three are checked in the same place (immediately after
-- claiming, before ever fetching secret material) and resolved via the
-- same "mark skipped with a specific diagnostic code, re-finalize the
-- delivery, never return it" shape — one exit path, three distinct
-- v_ineligible_code values, easy to read and easy to extend later
-- rather than three near-duplicate branches.

create or replace function private.prepare_notification_delivery_targets(p_batch_size integer default 50)
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
  v_skipped_predates_activation integer := 0;
  v_active_count integer;
begin
  select activated_at into v_activated_at from public.notification_delivery_activation where id = 1;

  if v_activated_at is null then
    return jsonb_build_object(
      'prepared', 0, 'skippedNoDevice', 0, 'skippedPredatesActivation', 0, 'reason', 'activation_absent'
    );
  end if;

  if p_batch_size is null or p_batch_size <= 0 or p_batch_size > 500 then
    raise exception 'p_batch_size must be between 1 and 500' using errcode = 'WK001';
  end if;

  for v_delivery in
    select nd.id, nd.tenant_id, nd.tenant_membership_id, ne.created_at as event_created_at
    from public.notification_deliveries nd
    join public.notification_events ne on ne.id = nd.notification_event_id
    where nd.targets_prepared_at is null
    order by nd.created_at
    limit p_batch_size
    for update of nd skip locked
  loop
    -- Faz NOTIF.2E.2A — Bug 1's fix: never fan out a pre-activation
    -- delivery into real device targets, however it came to exist.
    -- Resolved to a durable terminal 'skipped', not deleted, not left
    -- unprepared forever.
    if v_delivery.event_created_at < v_activated_at then
      update public.notification_deliveries
      set targets_prepared_at = now(),
          status = 'skipped'
      where id = v_delivery.id;

      v_skipped_predates_activation := v_skipped_predates_activation + 1;
      continue;
    end if;

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

  return jsonb_build_object(
    'prepared', v_prepared,
    'skippedNoDevice', v_skipped_no_device,
    'skippedPredatesActivation', v_skipped_predates_activation
  );
end;
$$;

comment on function private.prepare_notification_delivery_targets(integer) is
  'Faz NOTIF.2E.2, hardened in NOTIF.2E.2A. Fails closed when activation is absent. For each targets_prepared_at IS NULL delivery (bounded batch, FOR UPDATE SKIP LOCKED), first re-derives the underlying event''s created_at and skips fan-out entirely (delivery -> terminal ''skipped'', zero target rows) if it predates the activation watermark — the same >= activated_at contract materialize_pending_notification_events uses, re-enforced here independently rather than trusted from that earlier stage. Otherwise creates one target row per currently-active push_subscription for that membership (idempotent via the dedup unique constraint), stamps targets_prepared_at exactly once, and immediately marks the delivery terminally ''skipped'' if zero active devices exist.';

create or replace function private.claim_notification_delivery_targets(
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
  v_ineligible_code text;
  v_ineligible_message text;
  v_event_type text;
  v_event_created_at timestamptz;
  v_tenant_slug text;
  v_subscription_revoked boolean;
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
    v_ineligible_code := null;
    v_ineligible_message := null;

    -- Step 7 (Faz NOTIF.2E.2) — recipient eligibility, re-checked
    -- against CURRENT state. Also now carries the event's own
    -- created_at (Bug 1's fix) in the same query, no extra round trip.
    select ne.event_type, ne.created_at, tn.slug,
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
    into v_event_type, v_event_created_at, v_tenant_slug, v_is_eligible
    from public.tenant_memberships tm
    join public.notification_deliveries nd on nd.id = v_row.notification_delivery_id
    join public.notification_events ne on ne.id = nd.notification_event_id
    join public.tenants tn on tn.id = v_row.tenant_id
    left join public.notification_preferences np on np.tenant_membership_id = tm.id
    where tm.id = v_row.tenant_membership_id;

    -- Faz NOTIF.2E.2A Bug 2's fix — the exact subscription's OWN
    -- current revoked_at, re-read now, not trusted from prepare time.
    select ps.revoked_at is not null, ps.endpoint, ps.p256dh, ps.auth_key
    into v_subscription_revoked, v_endpoint, v_p256dh, v_auth_key
    from public.push_subscriptions ps
    where ps.id = v_row.push_subscription_id;

    if not coalesce(v_is_eligible, false) then
      v_ineligible_code := 'recipient_no_longer_eligible';
      v_ineligible_message := 'recipient no longer eligible at send time';
    elsif v_event_created_at < v_activated_at then
      v_ineligible_code := 'event_predates_activation';
      v_ineligible_message := 'underlying event predates the activation watermark';
    elsif coalesce(v_subscription_revoked, true) then
      -- coalesce(...,true): a subscription row that no longer exists at
      -- all (structurally near-impossible given the composite FK, but
      -- never assumed) is treated the same as revoked, never as
      -- eligible — fail closed, not fail open.
      v_ineligible_code := 'subscription_inactive';
      v_ineligible_message := 'push subscription is no longer active';
    end if;

    if v_ineligible_code is not null then
      update public.notification_delivery_targets
      set status = 'skipped',
          locked_at = null,
          lock_token = null,
          last_error_code = v_ineligible_code,
          last_error_message = v_ineligible_message
      where id = v_row.target_id;

      perform private.finalize_notification_delivery_status(v_row.notification_delivery_id);
      continue;
    end if;

    -- Only reached once eligibility + activation + subscription are all
    -- confirmed current — endpoint/p256dh/authKey are never placed into
    -- the returned jsonb for a target that failed any check above.
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
  'Faz NOTIF.2E.2, hardened in NOTIF.2E.2A. Fails closed (returns []) when activation is absent. Claims via FOR UPDATE SKIP LOCKED + an expiring lease + a fencing lock_token, unchanged from NOTIF.2E.2. Before returning a claimed target as sendable, re-checks three independent, current-state conditions in one pass: (1) recipient still active/same-tenant/appointments.view/preference-enabled, (2) the underlying event''s created_at still >= the activation watermark (never trust that materialize/prepare already enforced this — a delivery/target can exist for a pre-activation event via any direct call to the underlying, activation-unaware private.materialize_notification_deliveries), (3) the exact push_subscription''s own current revoked_at IS NULL (never trust prepare''s earlier snapshot). Any failure marks the target ''skipped'' with a distinct diagnostic code (recipient_no_longer_eligible / event_predates_activation / subscription_inactive), re-finalizes the parent delivery, and never places endpoint/p256dh/authKey into the result — that material is only ever returned once all three checks pass.';
