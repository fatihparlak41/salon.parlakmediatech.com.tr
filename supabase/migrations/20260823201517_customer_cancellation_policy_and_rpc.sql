-- Faz 2G.2A — tenant-level customer self-service policy (cancellation
-- live this phase; reschedule fields added now too, per explicit
-- instruction, but no reschedule mutation exists until 2G.2B) and the
-- one new customer-facing mutation: cancel_my_appointment.
--
-- Policy columns live directly on tenants, not a new table: settings.manage
-- already exists and already gates UPDATE on this exact row
-- (tenants_update_settings_manage, 20260815120016) — reusing it means
-- zero new permission, zero new RLS policy, for 4 columns. Both cutoffs
-- default to 0, both enabled flags default to false: fail-closed by
-- construction, applying this migration changes no tenant's live
-- behavior until an owner explicitly visits settings.
alter table public.tenants
  add column customer_cancellation_enabled boolean not null default false,
  add column customer_cancellation_cutoff_minutes integer not null default 0
    check (customer_cancellation_cutoff_minutes >= 0 and customer_cancellation_cutoff_minutes <= 10080),
  add column customer_reschedule_enabled boolean not null default false,
  add column customer_reschedule_cutoff_minutes integer not null default 0
    check (customer_reschedule_cutoff_minutes >= 0 and customer_reschedule_cutoff_minutes <= 10080);

comment on column public.tenants.customer_cancellation_enabled is
  'Faz 2G.2A — whether a customer may cancel their own future appointment via /account. Default false: fail-closed, never silently on after this migration.';
comment on column public.tenants.customer_cancellation_cutoff_minutes is
  'Minutes before scheduled_start_at after which customer self-cancel is no longer allowed. 0 = up to the appointment start itself. Bounded 0..10080 (7 days) as a sanity check, not a business requirement.';
comment on column public.tenants.customer_reschedule_enabled is
  'Faz 2G.2A schema only — no reschedule mutation exists yet (2G.2B). Added now so the policy pair ships together and get_my_appointments() can compute canReschedule for future use without a second migration.';
comment on column public.tenants.customer_reschedule_cutoff_minutes is
  'Same shape and bound as customer_cancellation_cutoff_minutes, independent value — a tenant may allow cancellation and reschedule on different cutoffs.';

-- =====================================================================
-- cancel_my_appointment — identity from auth.uid() only, no id
-- parameter, ownership re-derived from customer_account_links (ALL
-- active links, not only primary) against a ROW-LOCKED appointment.
-- The row lock is the serialization point: two concurrent cancel calls
-- against the same appointment_id block on the same SELECT ... FOR
-- UPDATE, and the second one re-reads (and re-checks ownership/status/
-- policy/cutoff against) whatever the first one actually committed —
-- never decides from an earlier, unlocked read. No advisory lock: the
-- thing being protected already has a real primary-keyed row to lock.
-- =====================================================================
create function private.cancel_my_appointment(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment record;
  v_tenant record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  select a.id, a.tenant_id, a.customer_id, a.status, a.scheduled_start_at
  into v_appointment
  from public.appointments a
  where a.id = p_appointment_id
  for update;

  -- "doesn't exist" and "exists but not manageable for any reason below"
  -- all collapse to the identical AC003 — no existence side channel.
  if not found then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  if not exists (
    select 1 from public.customer_account_links cal
    where cal.user_id = auth.uid()
      and cal.deleted_at is null
      and cal.customer_id = v_appointment.customer_id
  ) then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  if v_appointment.status not in ('scheduled', 'confirmed') then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  select customer_cancellation_enabled, customer_cancellation_cutoff_minutes
  into v_tenant
  from public.tenants
  where id = v_appointment.tenant_id;

  if not v_tenant.customer_cancellation_enabled then
    raise exception 'cancellation disabled' using errcode = 'AC004';
  end if;

  if now() > v_appointment.scheduled_start_at - (v_tenant.customer_cancellation_cutoff_minutes || ' minutes')::interval then
    raise exception 'cancellation cutoff passed' using errcode = 'AC005';
  end if;

  -- Plain status update — reuses the existing sync_appointment_item_status
  -- trigger (20260819052514) unchanged: it propagates 'cancelled' to
  -- every appointment_items row, which the appointment_items_no_staff_overlap
  -- exclusion constraint's WHERE clause then excludes, genuinely freeing
  -- every staff slot this appointment held. No item-level cancellation,
  -- no delete — the row is the permanent historical record, same rule
  -- as every staff-side cancellation.
  update public.appointments
  set status = 'cancelled'
  where id = p_appointment_id;

  -- actor_user_id/actor_type are set inside log_audit_event from auth.uid()
  -- itself (20260815120014) — already correct for a customer caller with
  -- zero changes needed there. actor_type stays 'user' (a customer IS a
  -- real authenticated user); no synthetic 'initiated_by'/'customer_portal'
  -- marker added to the payload, matching the explicit instruction not to
  -- introduce provenance metadata this phase.
  perform private.log_audit_event(
    v_appointment.tenant_id, 'appointment.cancelled', 'appointment', p_appointment_id,
    jsonb_build_object('status', v_appointment.status),
    jsonb_build_object('status', 'cancelled')
  );

  return jsonb_build_object('appointmentId', p_appointment_id, 'status', 'cancelled');
end;
$$;

revoke execute on function private.cancel_my_appointment(uuid) from public;

create function public.cancel_my_appointment(p_appointment_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.cancel_my_appointment(p_appointment_id);
$$;

revoke execute on function public.cancel_my_appointment(uuid) from public;
revoke execute on function public.cancel_my_appointment(uuid) from anon;
grant execute on function public.cancel_my_appointment(uuid) to authenticated;

-- =====================================================================
-- get_my_appointments — same signature (zero args), CREATE OR REPLACE
-- is correct here (not DROP+CREATE; the house DROP+CREATE rule is about
-- argument-list changes, which this isn't). Adds canCancel/canReschedule,
-- computed here so the DB stays the sole authority on eligibility — the
-- portal UI only ever reads these two booleans, never re-derives policy/
-- status/cutoff logic itself. canReschedule is computed even though no
-- reschedule mutation exists yet (2G.2B) — cheap now, and means 2G.2B
-- needs no further change to this function.
-- =====================================================================
create or replace function public.get_my_appointments()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(appt), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'appointmentId', a.id,
      'tenantName', t.name,
      'tenantSlug', t.slug,
      'tenantTimezone', t.timezone,
      'branchName', b.name,
      'status', a.status,
      'scheduledStartAt', a.scheduled_start_at,
      'scheduledEndAt', a.scheduled_end_at,
      'canCancel', (
        a.status in ('scheduled', 'confirmed')
        and t.customer_cancellation_enabled
        and now() <= a.scheduled_start_at - (t.customer_cancellation_cutoff_minutes || ' minutes')::interval
      ),
      'canReschedule', (
        a.status in ('scheduled', 'confirmed')
        and t.customer_reschedule_enabled
        and now() <= a.scheduled_start_at - (t.customer_reschedule_cutoff_minutes || ' minutes')::interval
      ),
      'services', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'serviceName', s.name,
            'staffName', sm.full_name,
            'durationMinutes', ai.duration_minutes,
            'price', ai.price
          )
          order by ai.sequence
        ), '[]'::jsonb)
        from public.appointment_items ai
        join public.services s on s.id = ai.service_id
        join public.staff_members sm on sm.id = ai.staff_member_id
        where ai.appointment_id = a.id
      )
    ) as appt
    from public.appointments a
    join public.branches b on b.id = a.branch_id
    join public.tenants t on t.id = a.tenant_id
    where a.customer_id in (
      select cal.customer_id
      from public.customer_account_links cal
      where cal.user_id = auth.uid() and cal.deleted_at is null
    )
    order by a.scheduled_start_at desc
    limit 200
  ) ordered;
$$;

-- CREATE OR REPLACE preserves the existing authenticated-only grant —
-- re-asserted here anyway so this migration is independently correct
-- even read in isolation, same convention as every prior CREATE OR
-- REPLACE in this project's history.
revoke execute on function public.get_my_appointments() from public;
grant execute on function public.get_my_appointments() to authenticated;
