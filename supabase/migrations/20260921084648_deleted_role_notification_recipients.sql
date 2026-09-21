-- Faz SAAS.1E.0 (part 3) — a DELETED ROLE grants nothing, in notification
-- recipient targeting too.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- 20260921061657 made private.has_permission and
-- private.tenant_has_active_unrestricted_holder ignore soft-deleted roles.
-- A catalog scan of every function, view, policy and trigger in the
-- schema (SAAS.1E.0 release review, finding F2) found exactly two more
-- places that derive "what may this membership do" on their own, by
-- joining role_permissions straight from tenant_memberships.role_id
-- without asking whether the role is still alive:
--
--   private.materialize_notification_deliveries(uuid)
--        - who RECEIVES an appointment notification: the candidate stage
--          ("salon-wide admins" = appointments.create) and the eligible
--          stage (appointments.view, for every candidate branch);
--   private.claim_notification_delivery_targets(integer, integer)
--        - the send-time re-check that a recipient is still eligible.
--
-- Consequence before this migration: a member whose role had been
-- soft-deleted (no app path does that today; a future role-management
-- screen or an operator could) still received appointment push
-- notifications, i.e. the deleted role still granted appointments.view.
-- Every other consumer of permissions already goes through has_permission
-- (all RLS policies, all RPC authorization), and no view, other schema or
-- TypeScript code derives permissions independently — verified by the
-- same scan.
--
-- =====================================================================
-- WHAT CHANGES
-- =====================================================================
--
-- Both places now require the membership's role to be a LIVE role of the
-- membership's OWN tenant (roles.deleted_at is null and
-- roles.tenant_id = tenant_memberships.tenant_id) — the exact predicate
-- has_permission uses. Membership status/deletion filters, preferences,
-- actor exclusion and every other rule are untouched, and nothing else in
-- the notification pipeline is refactored: the two functions below are the
-- live definitions with those joins added and nothing more.
--
-- Not changed: grants (create or replace keeps the existing ACLs),
-- prepare_notification_delivery_targets (it only fans out already
-- materialized deliveries; the claim re-check is the send-time gate),
-- tables, triggers, policies, TypeScript.

-- =====================================================================
-- PART 1 — private.materialize_notification_deliveries(uuid)
-- =====================================================================
--
-- Generated from the live definition (20260914150000 lineage) by exactly
-- two edits, each marked "Faz SAAS.1E.0 (part 3)" below: a join to a LIVE
-- role of the membership's own tenant in the candidate stage and in the
-- eligible stage. Every other line is unchanged.

CREATE OR REPLACE FUNCTION private.materialize_notification_deliveries(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event record;
  v_preference_column text;
  v_created_count integer := 0;
  v_recipient_count integer := 0;
  v_after jsonb;
  v_reassigned_ids jsonb;
  v_created_cancelled_snapshot jsonb;
  v_use_snapshot_for_created_cancelled boolean;
  v_already_materialized boolean;
begin
  select id, tenant_id, appointment_id, event_type, actor_user_id, event_data, schema_version
  into v_event
  from public.notification_events
  where id = p_event_id;

  if v_event.id is null then
    return jsonb_build_object('created', 0, 'alreadyMaterialized', false, 'reason', 'event_not_found');
  end if;

  if v_event.event_type not in (
       'appointment.created', 'appointment.cancelled',
       'appointment.rescheduled', 'appointment.staff_reassigned'
     )
     or v_event.schema_version <> 1
  then
    return jsonb_build_object('created', 0, 'alreadyMaterialized', false, 'reason', 'unsupported_event_type_or_schema_version');
  end if;

  select exists(
    select 1 from public.notification_event_materializations where notification_event_id = p_event_id
  ) into v_already_materialized;

  if v_already_materialized then
    select count(*) into v_recipient_count
    from public.notification_deliveries
    where notification_event_id = p_event_id;

    return jsonb_build_object(
      'created', 0, 'alreadyMaterialized', true,
      'recipientCount', v_recipient_count, 'eventType', v_event.event_type
    );
  end if;

  v_preference_column := case v_event.event_type
    when 'appointment.created' then 'new_appointment'
    when 'appointment.cancelled' then 'cancellation'
    when 'appointment.rescheduled' then 'reschedule'
    when 'appointment.staff_reassigned' then 'assignment_change'
  end;

  v_after := case when jsonb_typeof(v_event.event_data->'after') = 'array'
                  then v_event.event_data->'after' else '[]'::jsonb end;
  v_reassigned_ids :=
    (case when jsonb_typeof(v_event.event_data->'previousStaffMemberIds') = 'array'
          then v_event.event_data->'previousStaffMemberIds' else '[]'::jsonb end)
    ||
    (case when jsonb_typeof(v_event.event_data->'newStaffMemberIds') = 'array'
          then v_event.event_data->'newStaffMemberIds' else '[]'::jsonb end);

  -- Faz NOTIF.2E.1A — created/cancelled: prefer the event-time
  -- staffMemberIds snapshot when the event carries one (every event
  -- emitted from 20260914140000 onward); fall back to LIVE
  -- appointment_items state ONLY as compatibility behavior for a
  -- legacy row whose event_data is still the pre-2E.1A {}.
  --
  -- Faz NOTIF.2E.1A correction (this migration) — coalesce(..., false):
  -- jsonb_typeof(NULL) = 'array' is NULL, not false, for a genuinely
  -- legacy {} row (the key does not exist at all) — see this
  -- migration's own header for the bug that left both branches below
  -- silently excluding every legacy row before this fix.
  v_use_snapshot_for_created_cancelled :=
    coalesce(jsonb_typeof(v_event.event_data->'staffMemberIds') = 'array', false);
  v_created_cancelled_snapshot := case when v_use_snapshot_for_created_cancelled
    then v_event.event_data->'staffMemberIds' else '[]'::jsonb end;

  with candidate_memberships as (
    select tm.id as tenant_membership_id
    from public.tenant_memberships tm
    -- Faz SAAS.1E.0 (part 3): only a LIVE role of the membership's own
    -- tenant grants anything; a deleted role grants nothing.
    join public.roles r
      on r.id = tm.role_id and r.tenant_id = tm.tenant_id and r.deleted_at is null
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions perm on perm.id = rp.permission_id
    where tm.tenant_id = v_event.tenant_id
      and perm.key = 'appointments.create'

    union

    -- created/cancelled, NEW-format events: the event's own snapshot.
    select sm.tenant_membership_id
    from jsonb_array_elements_text(v_created_cancelled_snapshot) as staff_id
    join public.staff_members sm
      on sm.id = staff_id::uuid and sm.tenant_id = v_event.tenant_id
    where v_event.event_type in ('appointment.created', 'appointment.cancelled')
      and v_use_snapshot_for_created_cancelled
      and sm.tenant_membership_id is not null

    union

    -- created/cancelled, LEGACY events only (event_data = {}): live
    -- appointment_items state, exactly 20260914130000's own behavior.
    select sm.tenant_membership_id
    from public.appointment_items ai
    join public.staff_members sm
      on sm.id = ai.staff_member_id and sm.tenant_id = v_event.tenant_id
    where v_event.event_type in ('appointment.created', 'appointment.cancelled')
      and not v_use_snapshot_for_created_cancelled
      and ai.appointment_id = v_event.appointment_id
      and ai.tenant_id = v_event.tenant_id
      and sm.tenant_membership_id is not null

    union

    select sm.tenant_membership_id
    from jsonb_array_elements(v_after) as item
    join public.staff_members sm
      on sm.id = (item->>'staffMemberId')::uuid and sm.tenant_id = v_event.tenant_id
    where v_event.event_type = 'appointment.rescheduled'
      and sm.tenant_membership_id is not null

    union

    select sm.tenant_membership_id
    from jsonb_array_elements_text(v_reassigned_ids) as staff_id
    join public.staff_members sm
      on sm.id = staff_id::uuid and sm.tenant_id = v_event.tenant_id
    where v_event.event_type = 'appointment.staff_reassigned'
      and sm.tenant_membership_id is not null
  ),
  eligible_memberships as (
    select distinct cm.tenant_membership_id
    from candidate_memberships cm
    join public.tenant_memberships tm on tm.id = cm.tenant_membership_id
    -- Faz SAAS.1E.0 (part 3): same live-role rule as the candidate stage
    -- above; this is the stage every candidate branch (admin, staff
    -- snapshot, legacy, reschedule, reassignment) passes through.
    join public.roles r
      on r.id = tm.role_id and r.tenant_id = tm.tenant_id and r.deleted_at is null
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions perm on perm.id = rp.permission_id
    left join public.notification_preferences np on np.tenant_membership_id = tm.id
    where tm.tenant_id = v_event.tenant_id
      and tm.status = 'active'
      and tm.deleted_at is null
      and perm.key = 'appointments.view'
      and (v_event.actor_user_id is null or tm.user_id <> v_event.actor_user_id)
      and coalesce(
        case v_preference_column
          when 'new_appointment' then np.new_appointment
          when 'cancellation' then np.cancellation
          when 'reschedule' then np.reschedule
          when 'assignment_change' then np.assignment_change
        end,
        true
      )
  )
  insert into public.notification_deliveries (tenant_id, notification_event_id, tenant_membership_id, channel, status)
  select v_event.tenant_id, v_event.id, em.tenant_membership_id, 'web_push', 'pending'
  from eligible_memberships em
  on conflict (notification_event_id, tenant_membership_id, channel) do nothing;

  get diagnostics v_created_count = row_count;

  select count(*) into v_recipient_count
  from public.notification_deliveries
  where notification_event_id = p_event_id;

  insert into public.notification_event_materializations (notification_event_id, tenant_id, recipient_count)
  values (p_event_id, v_event.tenant_id, v_recipient_count)
  on conflict (notification_event_id) do nothing;

  return jsonb_build_object(
    'created', v_created_count, 'alreadyMaterialized', false,
    'recipientCount', v_recipient_count, 'eventType', v_event.event_type
  );
end;
$function$;

-- =====================================================================
-- PART 2 — private.claim_notification_delivery_targets(integer, integer)
-- =====================================================================
--
-- Generated from the live definition by exactly one edit (marked below):
-- the send-time eligibility re-check requires a LIVE role of the
-- membership's own tenant.

CREATE OR REPLACE FUNCTION private.claim_notification_delivery_targets(p_batch_size integer DEFAULT 25, p_lease_seconds integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_customer_name text;
  v_service_names text[];
  v_appointment_start_at timestamptz;
  v_tenant_timezone text;
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

    -- Step 7 (Faz NOTIF.2E.2) — recipient eligibility, re-checked against
    -- CURRENT state; also carries the event's own created_at (Faz
    -- NOTIF.2E.2A). Faz NOTIF.2F.1 adds only the LEFT JOIN to the display
    -- snapshot table and its 4 columns — every eligibility predicate
    -- below is unchanged from 2E.2A.
    select ne.event_type, ne.created_at, tn.slug,
      tm.status = 'active'
      and tm.deleted_at is null
      and tm.tenant_id = v_row.tenant_id
      -- Faz SAAS.1E.0 (part 3): the send-time re-check honours the same
      -- live-role rule, so a role deleted AFTER materialization stops the
      -- push instead of letting it out.
      and exists (
        select 1 from public.roles r
        join public.role_permissions rp on rp.role_id = r.id
        join public.permissions perm on perm.id = rp.permission_id
        where r.id = tm.role_id and r.tenant_id = tm.tenant_id and r.deleted_at is null
          and perm.key = 'appointments.view'
      )
      and coalesce(
        case ne.event_type
          when 'appointment.created' then np.new_appointment
          when 'appointment.cancelled' then np.cancellation
          when 'appointment.rescheduled' then np.reschedule
          when 'appointment.staff_reassigned' then np.assignment_change
        end,
        true
      ),
      s.customer_name, s.service_names, s.appointment_start_at, s.tenant_timezone
    into v_event_type, v_event_created_at, v_tenant_slug, v_is_eligible,
      v_customer_name, v_service_names, v_appointment_start_at, v_tenant_timezone
    from public.tenant_memberships tm
    join public.notification_deliveries nd on nd.id = v_row.notification_delivery_id
    join public.notification_events ne on ne.id = nd.notification_event_id
    join public.tenants tn on tn.id = v_row.tenant_id
    left join public.notification_preferences np on np.tenant_membership_id = tm.id
    left join public.notification_event_display_snapshots s on s.event_id = ne.id
    where tm.id = v_row.tenant_membership_id;

    -- Faz NOTIF.2E.2A Bug 2's fix — the exact subscription's OWN current
    -- revoked_at, re-read now, not trusted from prepare time.
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
    -- confirmed current — endpoint/p256dh/authKey (and, Faz NOTIF.2F.1,
    -- the display fields) are never placed into the returned jsonb for a
    -- target that failed any check above.
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
      'authKey', v_auth_key,
      'customerName', v_customer_name,
      'serviceNames', v_service_names,
      'appointmentStartAt', v_appointment_start_at,
      'tenantTimezone', v_tenant_timezone
    ));
  end loop;

  return v_result;
end;
$function$;
