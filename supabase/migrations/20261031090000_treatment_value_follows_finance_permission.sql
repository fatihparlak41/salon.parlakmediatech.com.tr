-- RC.1A integration: BEAUTY.1B treatment history x CUST.1A / FIN.1A authorization.
--
-- The treatment value of a history row can be the checkout's edited unit price - a finance fact (FIN.1A tables are closed to every
-- role without finance.view). The integrated customer history follows CUST.1A: money only with finance.view. So the value is shown
-- to finance.view holders (the Owner by default) and is null for everyone else; Yonetici and Resepsiyon still see the history, the
-- notes, the photos and the re-booking window. The function is the accepted BEAUTY.1B body with this one permission changed;
-- grants are preserved by CREATE OR REPLACE.
-- Depends on: 20261029090000. Rollback: re-apply the 20261029090000 definition of private.get_customer_treatment_history.

begin;

create or replace function private.get_customer_treatment_history(p_tenant_id uuid, p_customer_id uuid, p_limit integer)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.treatment_gate(p_tenant_id, array['customers.view', 'appointments.view']);
  v_value boolean := private.has_permission(p_tenant_id, 'finance.view');
  v_today date := (now() at time zone v_tz)::date;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = p_tenant_id and c.deleted_at is null) then
    raise exception 'not found' using errcode = 'BH003';
  end if;
  return (
    with t as materialized (
      select ai.id as item_id, ap.id as appointment_id, ap.scheduled_start_at, (ap.scheduled_start_at at time zone v_tz)::date as d,
             ai.sequence, ai.service_id, sv.name as service_name, sv.rebook_min_days, sv.rebook_max_days,
             coalesce(asi.actual_staff_member_id, ai.actual_staff_member_id, ai.staff_member_id) as staff_id,
             case when asi.id is not null then asi.unit_price else ai.price end as value
      from public.appointments ap
      join public.appointment_items ai on ai.appointment_id = ap.id and ai.tenant_id = p_tenant_id
      join public.services sv on sv.id = ai.service_id and sv.tenant_id = p_tenant_id
      left join public.appointment_sales s on s.appointment_id = ap.id and s.tenant_id = p_tenant_id and s.status <> 'voided'
      left join public.appointment_sale_items asi on asi.appointment_item_id = ai.id and asi.sale_id = s.id and asi.tenant_id = p_tenant_id
      where ap.tenant_id = p_tenant_id and ap.customer_id = p_customer_id and ap.status = 'completed'
    ),
    latest as materialized (
      select distinct on (t.service_id) t.item_id
      from t order by t.service_id, t.scheduled_start_at desc, t.sequence desc
    ),
    upcoming as materialized (
      select distinct ai.service_id
      from public.appointments ap
      join public.appointment_items ai on ai.appointment_id = ap.id and ai.tenant_id = p_tenant_id
      where ap.tenant_id = p_tenant_id and ap.customer_id = p_customer_id
        and ap.status in ('scheduled', 'confirmed', 'in_progress') and ap.scheduled_start_at > now()
    ),
    page as materialized (
      select * from t order by t.scheduled_start_at desc, t.sequence desc limit v_limit
    )
    select jsonb_build_object(
      'today', v_today, 'timezone', v_tz, 'canSeeValue', v_value,
      'hasMore', (select count(*) from t) > v_limit,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'itemId', p.item_id, 'appointmentId', p.appointment_id, 'date', p.d,
          'serviceId', p.service_id, 'serviceName', p.service_name,
          'staffName', sm.full_name,
          'value', case when v_value then p.value::text else null end,
          'note', tn.note,
          'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'createdAt', m.created_at) order by m.created_at, m.id)
                             from public.treatment_media m where m.appointment_item_id = p.item_id and m.tenant_id = p_tenant_id and m.status = 'ready'), '[]'::jsonb),
          'rebook', case when p.rebook_min_days is null or p.item_id not in (select item_id from latest) then null
                    else jsonb_build_object(
                      'minDays', p.rebook_min_days, 'maxDays', p.rebook_max_days,
                      'windowStart', p.d + p.rebook_min_days,
                      'windowEnd', case when p.rebook_max_days is null then null else p.d + p.rebook_max_days end,
                      'state', case
                        when p.service_id in (select service_id from upcoming) then 'booked'
                        when v_today < p.d + p.rebook_min_days then 'not_due'
                        when p.rebook_max_days is not null and v_today > p.d + p.rebook_max_days then 'overdue'
                        else 'due' end)
                    end
        ) order by p.scheduled_start_at desc, p.sequence desc)
        from page p
        left join public.staff_members sm on sm.id = p.staff_id and sm.tenant_id = p_tenant_id
        left join public.treatment_notes tn on tn.appointment_item_id = p.item_id and tn.tenant_id = p_tenant_id
      ), '[]'::jsonb)
    )
  );
end;
$function$;

commit;
