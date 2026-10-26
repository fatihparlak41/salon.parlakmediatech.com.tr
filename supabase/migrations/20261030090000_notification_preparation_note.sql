-- RC.1A integration: LAUNCH.1B notification payload x BEAUTY.1A service metadata.
--
-- When customer notifications are switched on, the confirmation and the 24 h reminder may carry ONE concise line: the
-- salon-authored services.preparation_note (BEAUTY.1A). Nothing else from the service is sent - not the detail text, not the
-- aftercare note (no post-appointment message exists in LAUNCH.1B), not the internal description, never a private note.
-- The claim function below is the accepted LAUNCH.1B body (20261023090000) with exactly three additions: a variable, one query
-- and one payload key ('preparationNote', null when no service has a note). Grants are preserved by CREATE OR REPLACE.
-- Depends on: 20261023090000 (the function), 20261028090000 (services.preparation_note).
-- Rollback: re-apply the 20261023090000 definition of private.claim_customer_notification_jobs.

begin;

create or replace function private.claim_customer_notification_jobs(
  p_batch_size integer default 5,
  p_lease_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_tenants integer;
  v_lease interval;
  v_row record;
  v_ctx record;
  v_contact record;
  v_services text[];
  v_staff text[];
  v_prep text;
  v_found boolean;
  v_skip text;
  v_jobs jsonb := '[]'::jsonb;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 50 then
    raise exception 'p_batch_size must be between 1 and 50' using errcode = 'CN001';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'p_lease_seconds must be between 30 and 3600' using errcode = 'CN001';
  end if;
  v_lease := make_interval(secs => p_lease_seconds);

  select count(*) into v_active_tenants
  from private.customer_notification_activation a
  where a.enabled
    and a.channel = 'email';

  -- Fail closed: no switch ON anywhere = nothing to do, nothing is touched.
  if v_active_tenants = 0 then
    return jsonb_build_object('activeTenantCount', 0, 'jobs', '[]'::jsonb);
  end if;

  perform private.materialize_customer_reminders();

  update private.customer_notification_jobs j
  set status = 'uncertain',
      locked_at = null,
      lock_token = null,
      last_error_class = 'worker_interrupted'
  where j.status = 'processing'
    and j.send_started_at is not null
    and j.locked_at <= now() - v_lease;

  for v_row in
    with candidates as (
      select j.id
      from private.customer_notification_jobs j
      where j.channel = 'email'
        and (
          (j.status in ('pending', 'retry') and j.next_attempt_at <= now())
          or (j.status = 'processing' and j.send_started_at is null and j.locked_at <= now() - v_lease)
        )
        and exists (
          select 1
          from private.customer_notification_activation a
          where a.tenant_id = j.tenant_id
            and a.notification_type = j.notification_type
            and a.channel = j.channel
            and a.enabled
        )
      order by j.next_attempt_at, j.created_at
      limit p_batch_size
      for update of j skip locked
    )
    update private.customer_notification_jobs j
    set status = 'processing',
        locked_at = now(),
        lock_token = gen_random_uuid()
    from candidates c
    where j.id = c.id
    returning j.id, j.lock_token, j.tenant_id, j.appointment_id, j.attempt_count,
              j.notification_type, j.target_start_at, j.created_at
  loop
    v_skip := null;

    select t.name as salon_name, t.slug as tenant_slug, t.timezone as tenant_timezone,
           t.status as tenant_status, t.deleted_at as tenant_deleted_at,
           a.status as appointment_status, a.scheduled_start_at,
           b.location_url, b.phone as branch_phone
    into v_ctx
    from public.appointments a
    join public.tenants t on t.id = a.tenant_id
    join public.branches b on b.id = a.branch_id and b.tenant_id = a.tenant_id
    where a.id = v_row.appointment_id
      and a.tenant_id = v_row.tenant_id;
    v_found := found;

    select c.recipient_email, c.greeting_name
    into v_contact
    from private.appointment_booking_contacts c
    where c.appointment_id = v_row.appointment_id
      and c.tenant_id = v_row.tenant_id;

    select coalesce(array_agg(s.name order by ai.sequence, ai.id), '{}')
    into v_services
    from public.appointment_items ai
    join public.services s on s.id = ai.service_id and s.tenant_id = ai.tenant_id
    where ai.appointment_id = v_row.appointment_id
      and ai.tenant_id = v_row.tenant_id;

    select coalesce(array_agg(n.full_name order by n.first_seq), '{}')
    into v_staff
    from (
      select sm.full_name, min(ai.sequence) as first_seq
      from public.appointment_items ai
      join public.staff_members sm on sm.id = ai.staff_member_id and sm.tenant_id = ai.tenant_id
      where ai.appointment_id = v_row.appointment_id
        and ai.tenant_id = v_row.tenant_id
      group by sm.full_name
    ) n;

    -- RC.1A: the salon-authored preparation note(s) of the booked services (services.preparation_note, at most two distinct
    -- notes in booking order). ONLY that column: never appointments.notes, customer notes, treatment notes or the internal
    -- service description. The e-mail templates use it for the confirmation and the reminder only.
    select nullif(btrim(coalesce(string_agg(n.note, ' ' order by n.first_seq), '')), '')
    into v_prep
    from (
      select btrim(s.preparation_note) as note, min(ai.sequence) as first_seq
      from public.appointment_items ai
      join public.services s on s.id = ai.service_id and s.tenant_id = ai.tenant_id
      where ai.appointment_id = v_row.appointment_id
        and ai.tenant_id = v_row.tenant_id
        and s.preparation_note is not null
        and btrim(s.preparation_note) <> ''
      group by btrim(s.preparation_note)
      order by min(ai.sequence), btrim(s.preparation_note)
      limit 2
    ) n;

    if not v_found then
      v_skip := 'appointment_missing';
    elsif v_ctx.tenant_deleted_at is not null or v_ctx.tenant_status not in ('trial', 'active') then
      v_skip := 'tenant_inactive';
    elsif v_row.notification_type = 'appointment_cancellation' and v_ctx.appointment_status <> 'cancelled' then
      v_skip := 'appointment_not_cancelled';
    elsif v_row.notification_type <> 'appointment_cancellation' and v_ctx.appointment_status <> 'confirmed' then
      v_skip := 'appointment_not_confirmed';
    elsif v_ctx.scheduled_start_at <= now() then
      v_skip := 'appointment_started';
    elsif v_row.notification_type = 'appointment_reminder_24h' and v_row.target_start_at is distinct from v_ctx.scheduled_start_at then
      v_skip := 'rescheduled';
    elsif v_row.notification_type = 'appointment_reminder_24h'
          and now() > v_ctx.scheduled_start_at - interval '24 hours' + interval '3 hours' then
      v_skip := 'reminder_window_missed';
    elsif v_row.notification_type <> 'appointment_reminder_24h' and v_row.created_at < now() - interval '48 hours' then
      v_skip := 'stale';
    elsif v_contact.recipient_email is null then
      v_skip := 'no_recipient';
    elsif not private.is_deliverable_email_shape(v_contact.recipient_email) then
      v_skip := 'invalid_recipient';
    elsif coalesce(array_length(v_services, 1), 0) = 0 then
      v_skip := 'no_services';
    end if;

    if v_skip is not null then
      update private.customer_notification_jobs
      set status = 'skipped',
          skip_reason = v_skip,
          locked_at = null,
          lock_token = null
      where id = v_row.id;
      continue;
    end if;

    v_jobs := v_jobs || jsonb_build_array(jsonb_build_object(
      'jobId', v_row.id,
      'lockToken', v_row.lock_token,
      'attemptCount', v_row.attempt_count,
      'notificationType', v_row.notification_type,
      'recipientEmail', v_contact.recipient_email,
      'greetingName', v_contact.greeting_name,
      'salonName', v_ctx.salon_name,
      'tenantSlug', v_ctx.tenant_slug,
      'tenantTimezone', v_ctx.tenant_timezone,
      'appointmentStartAt', v_ctx.scheduled_start_at,
      'serviceNames', to_jsonb(v_services),
      'staffNames', to_jsonb(v_staff),
      'contactPhone', v_ctx.branch_phone,
      'locationUrl', v_ctx.location_url,
      'preparationNote', v_prep
    ));
  end loop;

  return jsonb_build_object('activeTenantCount', v_active_tenants, 'jobs', v_jobs);
end;
$$;

commit;
