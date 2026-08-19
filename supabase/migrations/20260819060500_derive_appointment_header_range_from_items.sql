-- Phase 2A.1 review: 20260819053848 fixed create_appointment's placeholder
-- header insert (now(), now()) so it stopped violating its own CHECK
-- constraint, but the placeholder itself — now(), now() + 1 minute — was
-- still an arbitrary value unrelated to the actual request, transiently
-- written before being overwritten by the post-loop UPDATE. Never
-- externally visible (same transaction, nothing has a grant to read a
-- half-built appointment), so not a correctness bug, but bad practice:
-- a future edit to this function that drops or short-circuits the final
-- UPDATE would silently commit garbage timestamps with no test catching
-- it except by accident.
--
-- This derives the header's initial values directly from p_items (each
-- item's requested start + its service's duration) BEFORE the header is
-- ever inserted — the first INSERT already carries genuine values, not a
-- placeholder. The post-loop UPDATE from the loop's actual
-- validate_and_insert_appointment_item results is deliberately KEPT, not
-- removed: it is what makes the invariant
-- (scheduled_start_at = MIN(items.scheduled_start_at), scheduled_end_at =
-- MAX(items.scheduled_end_at)) hold unconditionally, including the
-- extremely narrow case where a service's duration_minutes changes via a
-- concurrent transaction between this function's pre-pass read and its
-- later, authoritative read inside validate_and_insert_appointment_item
-- (Postgres's default READ COMMITTED isolation gives each statement its
-- own snapshot, so that narrow race is real, if unlikely). The pre-pass
-- estimate only needs to be right in the overwhelming common case; the
-- final UPDATE is what makes it provably always right. See
-- tests/phase2-appointments.test.ts "header time invariant" for the proof.
create or replace function private.create_appointment(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_notes text default null,
  p_source text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_id uuid;
  v_item jsonb;
  v_item_result private.appointment_item_result;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.has_permission(p_tenant_id, 'appointments.create') then
    raise exception 'appointments.create required';
  end if;

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'branch not found in this tenant';
  end if;

  if not exists (
    select 1 from public.customers
    where id = p_customer_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'customer not found in this tenant';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required';
  end if;

  -- Best-effort range for the header's ONE insert below — derived from
  -- the request, not arbitrary. An item whose service_id doesn't resolve
  -- contributes nothing here (LEFT JOIN); it is rejected with a specific,
  -- clean error by validate_and_insert_appointment_item in the loop below
  -- before anything commits, so imprecision here has no correctness
  -- consequence — the whole transaction rolls back regardless.
  select
    min((item ->> 'scheduled_start_at')::timestamptz),
    max((item ->> 'scheduled_start_at')::timestamptz + (s.duration_minutes || ' minutes')::interval)
  into v_range_start, v_range_end
  from jsonb_array_elements(p_items) as item
  left join public.services s
    on s.id = (item ->> 'service_id')::uuid
    and s.tenant_id = p_tenant_id
    and s.status = 'active'
    and s.deleted_at is null;

  if v_range_start is null or v_range_end is null then
    raise exception 'one or more services not found or inactive in this tenant';
  end if;

  insert into public.appointments (
    tenant_id, branch_id, customer_id, notes, source,
    scheduled_start_at, scheduled_end_at, created_by
  )
  values (
    p_tenant_id, p_branch_id, p_customer_id, p_notes, p_source,
    v_range_start, v_range_end, auth.uid()
  )
  returning id into v_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      p_tenant_id, v_appointment_id, v_item,
      coalesce((v_item ->> 'sequence')::integer, v_sequence)
    );
    v_min_start := least(coalesce(v_min_start, v_item_result.scheduled_start_at), v_item_result.scheduled_start_at);
    v_max_end := greatest(coalesce(v_max_end, v_item_result.scheduled_end_at), v_item_result.scheduled_end_at);
  end loop;

  -- Authoritative correction: v_min_start/v_max_end come from what
  -- validate_and_insert_appointment_item actually inserted, the same
  -- source the MIN/MAX invariant is checked against — never from the
  -- pre-pass estimate above, so this is right even if that estimate
  -- wasn't.
  update public.appointments
  set scheduled_start_at = v_min_start, scheduled_end_at = v_max_end
  where id = v_appointment_id;

  perform private.log_audit_event(
    p_tenant_id, 'appointment.created', 'appointment', v_appointment_id,
    null, jsonb_build_object('customer_id', p_customer_id, 'items', p_items)
  );

  return v_appointment_id;
end;
$$;
