-- Faz NOTIF.2E.1A (correction) — 20260914140000 is NOT edited; this is a
-- forward-only fix, same discipline as every other corrective migration
-- in this project (20260908100000, 20260909110000, 20260914121000).
--
-- =====================================================================
-- THE BUG, CAUGHT BY THIS PHASE'S OWN "legacy fallback" test, NOT
-- ASSUMED
-- =====================================================================
-- private.materialize_notification_deliveries computed:
--   v_use_snapshot_for_created_cancelled :=
--     jsonb_typeof(v_event.event_data->'staffMemberIds') = 'array';
--
-- For a genuinely legacy row (event_data = '{}'::jsonb, the only shape
-- that existed before 20260914140000), event_data->'staffMemberIds' is
-- SQL NULL (the key does not exist). jsonb_typeof(NULL) is itself NULL,
-- and `NULL = 'array'` is NULL under three-valued logic — NOT false.
-- Assigning that to the boolean variable leaves it NULL, not false.
-- Every WHERE clause that then tested `and v_use_snapshot_for_created_
-- cancelled` (the new-format branch) OR `and not v_use_snapshot_for_
-- created_cancelled` (the legacy-fallback branch) evaluated to NULL for
-- that row, and a WHERE clause treats NULL exactly like false —
-- excluding the row from BOTH branches at once. A legacy created/
-- cancelled event therefore materialized zero staff recipients,
-- silently, with no error — confirmed by a real DEV test inserting a
-- genuine {}-shaped row and materializing it, not inferred from reading
-- the code.
--
-- =====================================================================
-- THE FIX
-- =====================================================================
-- Wrap the assignment in coalesce(..., false) so the variable is always
-- a definite true/false, never NULL, restoring exactly the intended
-- behavior: new-format events use the snapshot, legacy {} events use
-- the live-appointment_items fallback. Every other line in this
-- function is byte-for-byte identical to 20260914140000's own version —
-- confirmed by diff before writing this migration.

create or replace function private.materialize_notification_deliveries(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    join public.role_permissions rp on rp.role_id = tm.role_id
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
    join public.role_permissions rp on rp.role_id = tm.role_id
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
$$;

comment on function private.materialize_notification_deliveries(uuid) is
  'Faz NOTIF.2E.1A, corrected in this migration. Idempotent via notification_event_materializations (checked first, short-circuits a repeat call) AND the pre-existing notification_deliveries dedup key (belt and suspenders). created/cancelled resolve staff from the event''s own staffMemberIds snapshot when present, falling back to live appointment_items only for a legacy pre-2E.1A row — that fallback branch is reached via coalesce(..., false), never a bare boolean expression that could evaluate to SQL NULL for a {}-shaped legacy row. A zero-eligible-recipient event still gets a completion marker (recipient_count = 0) so a future worker never retries it forever.';
