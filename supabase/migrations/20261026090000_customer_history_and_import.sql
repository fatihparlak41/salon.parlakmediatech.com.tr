-- Faz CUST.1A — customer history and safe customer import.
--
-- 1. ONE central phone canonicalisation. Until now private.normalize_phone only stripped formatting, so "0533 123 45 67",
--    "+90 533 123 45 67", "90 533 123 45 67" and "533 123 45 67" were four different customers to every matching rule
--    (public booking, staff search, duplicate detection). The function is now a pure function of the stripped string
--    (private.strip_phone, the OLD behaviour), so two phones that matched before still match; the Turkish / KKTC forms
--    additionally collapse to one canonical "+90..." form. Other numbers are left exactly as before.
--    The stored generated column customers.phone_normalized is refreshed for the rows whose value changes.
-- 2. public.get_customer_history: ONE read model for the customer card (summary, upcoming, past, services, staff), with
--    money only for callers who also hold finance.view. No appointment notes, no ids, no customer notes.
-- 3. public.preview_customer_import / public.commit_customer_import: classify rows NEW / MATCH_EXISTING / INVALID / AMBIGUOUS
--    with one shared function; the preview writes nothing; the commit re-classifies inside one transaction under a tenant
--    lock (so it is atomic, retry-safe and idempotent) and imports only rows that are safe.
--
-- IDENTITY POLICY (conservative; names alone never identify anybody)
--   * a row matches an existing customer of the SAME tenant only through a canonical phone or a normalized e-mail AND the
--     same name (case-insensitive, trimmed) — the same rule the public booking already uses (phone + name).
--   * the same phone or e-mail under another name is AMBIGUOUS (families share phones) and is never merged or imported.
--   * several existing customers match, or the phone and the e-mail point at two different customers: AMBIGUOUS.
--   * a row with neither phone nor e-mail is INVALID (nothing could ever make a re-run idempotent).
--   * archived customers are matched too (so an archived customer is never re-created); their state is not changed.
--   * a matched customer's EMPTY phone / e-mail may be filled from the row when no other customer owns that value; a
--     non-empty value, the name and the notes are never overwritten.
-- Limits: 1..5000 rows per import. SQLSTATE: CH001/CI010 not signed in, CH002/CI011 not allowed, CI012 invalid input.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. canonical phone
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.strip_phone(p_phone text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
$function$;

revoke all on function private.strip_phone(text) from public, anon, authenticated, service_role;

create or replace function private.normalize_phone(p_phone text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select case
    when v is null then null
    when v ~ '^\+' then v
    when v ~ '^00[0-9]+$' then '+' || substr(v, 3)
    when v ~ '^90[2-5][0-9]{9}$' then '+' || v
    when v ~ '^0[2-5][0-9]{9}$' then '+90' || substr(v, 2)
    when v ~ '^5[0-9]{9}$' then '+90' || v
    else v
  end
  -- self-contained on purpose: the generated column customers.phone_normalized runs this with the WRITER's privileges (staff
  -- insert customers directly) and the writer has no USAGE on schema private, so it must not name another private function
  from (select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '') as v) s;
$function$;

-- Refresh the stored canonical value of existing customers whose value changes. The audit and updated_at triggers are
-- switched off for this one technical statement (the customer did not change, a derived column did).
alter table public.customers disable trigger audit_customer_change;
alter table public.customers disable trigger set_updated_at;
update public.customers set phone = phone where phone is not null and phone_normalized is distinct from private.normalize_phone(phone);
alter table public.customers enable trigger audit_customer_change;
alter table public.customers enable trigger set_updated_at;

-- search: a partial number typed the way people type it ("0533 12") must keep finding "+90533..."; match the canonical
-- value AND the stripped number as it was entered
create or replace function public.search_customers(
  p_tenant_id uuid,
  p_query text default '',
  p_status text default 'active',
  p_limit integer default 30,
  p_offset integer default 0
)
 returns setof public.customers
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  if not private.has_permission(p_tenant_id, 'customers.view') then
    raise exception 'customers.view required';
  end if;

  return query
  select c.*
  from public.customers c
  where c.tenant_id = p_tenant_id
    and c.deleted_at is null
    and (p_status = 'all' or c.status = p_status)
    and (
      p_query = ''
      or c.full_name ilike '%' || p_query || '%'
      or c.phone_normalized ilike '%' || private.normalize_phone(p_query) || '%'
      or private.strip_phone(c.phone) ilike '%' || private.strip_phone(p_query) || '%'
      or c.email_normalized ilike '%' || private.normalize_email(p_query) || '%'
    )
  order by c.full_name
  limit least(coalesce(p_limit, 30), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. customer history
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.customer_history(p_customer_id uuid, p_limit integer default 50)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tenant uuid;
  v_tz text;
  v_now timestamptz := now();
  v_finance boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'CH001';
  end if;

  select c.tenant_id into v_tenant from public.customers c where c.id = p_customer_id and c.deleted_at is null;
  -- an unknown customer, another salon's customer and a caller without the right all look the same
  if v_tenant is null
     or not private.has_permission(v_tenant, 'customers.view')
     or not private.has_permission(v_tenant, 'appointments.view') then
    raise exception 'not allowed' using errcode = 'CH002';
  end if;

  v_finance := private.has_permission(v_tenant, 'finance.view');
  select t.timezone into v_tz from public.tenants t where t.id = v_tenant;

  with appts as (
    -- every appointment of this customer in this salon, exactly once
    select ap.id, ap.status, ap.scheduled_start_at,
           (ap.status in ('scheduled', 'confirmed', 'in_progress') and ap.scheduled_end_at >= v_now) as is_upcoming,
           s.id as sale_id, s.total_amount as sale_total,
           coalesce((select sum(p.amount) from public.payments p where p.appointment_sale_id = s.id and p.status = 'posted'), 0) as paid,
           (select coalesce(sum(ai.price), 0) from public.appointment_items ai where ai.appointment_id = ap.id and ai.tenant_id = v_tenant) as list_amount
    from public.appointments ap
    left join public.appointment_sales s on s.appointment_id = ap.id and s.tenant_id = v_tenant and s.status <> 'voided'
    where ap.tenant_id = v_tenant and ap.customer_id = p_customer_id
  ),
  items as (
    select ai.appointment_id, ai.sequence, sv.name as service_name, sm.full_name as staff_name
    from public.appointment_items ai
    join appts a on a.id = ai.appointment_id
    join public.services sv on sv.id = ai.service_id and sv.tenant_id = v_tenant
    left join public.staff_members sm on sm.id = coalesce(ai.actual_staff_member_id, ai.staff_member_id) and sm.tenant_id = v_tenant
    where ai.tenant_id = v_tenant
  ),
  rowj as (
    select a.scheduled_start_at, a.is_upcoming,
           jsonb_build_object(
             'startAt', a.scheduled_start_at,
             'status', a.status,
             'items', coalesce((select jsonb_agg(jsonb_build_object('service', i.service_name, 'staff', i.staff_name) order by i.sequence)
                                from items i where i.appointment_id = a.id), '[]'::jsonb)
           )
           || case when v_finance then
                jsonb_build_object(
                  'amount', case when a.sale_id is not null then a.sale_total else a.list_amount end,
                  'hasCheckout', a.sale_id is not null,
                  'paid', case when a.sale_id is not null then a.paid else null end,
                  'outstanding', case when a.sale_id is not null then greatest(a.sale_total - a.paid, 0) else null end
                )
              else '{}'::jsonb end as j
    from appts a
  )
  select jsonb_build_object(
    'timezone', v_tz,
    'summary', (
      select jsonb_build_object(
        'completedVisits', count(*) filter (where a.status = 'completed'),
        'lastVisitAt', max(a.scheduled_start_at) filter (where a.status = 'completed'),
        'upcoming', count(*) filter (where a.is_upcoming),
        'cancelled', count(*) filter (where a.status = 'cancelled'),
        'noShow', count(*) filter (where a.status = 'no_show'),
        'total', count(*)
      ) from appts a
    ),
    'upcoming', coalesce((select jsonb_agg(u.j order by u.scheduled_start_at)
                          from (select r.j, r.scheduled_start_at from rowj r where r.is_upcoming order by r.scheduled_start_at limit 20) u), '[]'::jsonb),
    'past', coalesce((select jsonb_agg(p.j order by p.scheduled_start_at desc)
                      from (select r.j, r.scheduled_start_at from rowj r where not r.is_upcoming order by r.scheduled_start_at desc limit v_limit) p), '[]'::jsonb),
    'hasMorePast', (select count(*) from appts a where not a.is_upcoming) > v_limit,
    -- services received and who performed them: completed work only, per item (a visit with two services = two)
    'servicesReceived', coalesce((
      select jsonb_agg(jsonb_build_object('service', x.service_name, 'count', x.n) order by x.n desc, x.service_name)
      from (select i.service_name, count(*) as n from items i join appts a on a.id = i.appointment_id
            where a.status = 'completed' group by i.service_name) x), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('displayName', x.staff_name, 'count', x.n) order by x.n desc, x.staff_name)
      from (select i.staff_name, count(*) as n from items i join appts a on a.id = i.appointment_id
            where a.status = 'completed' and i.staff_name is not null group by i.staff_name) x), '[]'::jsonb),
    'finance', case when v_finance then (
      select jsonb_build_object(
        'completedAmount', coalesce(sum(case when a.sale_id is not null then a.sale_total else a.list_amount end) filter (where a.status = 'completed'), 0),
        'outstanding', coalesce(sum(a.sale_total - a.paid) filter (where a.sale_id is not null and a.sale_total - a.paid > 0), 0),
        'completedWithoutCheckout', count(*) filter (where a.status = 'completed' and a.sale_id is null),
        'currency', (select t.currency from public.tenants t where t.id = v_tenant)
      ) from appts a) else null end
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function private.customer_history(uuid, integer) from public, anon, authenticated, service_role;

create or replace function public.get_customer_history(p_customer_id uuid, p_limit integer default 50)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select private.customer_history(p_customer_id, p_limit);
$function$;

revoke all on function public.get_customer_history(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_customer_history(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. import
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.customer_import_gate(p_tenant_id uuid, p_rows jsonb)
 returns void
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_e jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'CI010';
  end if;
  -- the Owner's import: viewing, creating and updating customers AND settings.manage (no new permission key)
  if not (private.has_permission(p_tenant_id, 'customers.view')
          and private.has_permission(p_tenant_id, 'customers.create')
          and private.has_permission(p_tenant_id, 'customers.update')
          and private.has_permission(p_tenant_id, 'settings.manage')) then
    raise exception 'not allowed' using errcode = 'CI011';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'between 1 and 5000 rows are required' using errcode = 'CI012';
  end if;
  for v_e in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_e) <> 'object' or (v_e->>'row') is null or (v_e->>'row') !~ '^[0-9]{1,9}$' then
      raise exception 'invalid row' using errcode = 'CI012';
    end if;
  end loop;
end;
$function$;

create or replace function private.classify_customer_import(p_tenant_id uuid, p_rows jsonb)
 returns table (
   row_no integer, status text, reason text, name_clean text, phone_raw text, email_raw text,
   existing_id uuid, existing_name text, enrich_phone boolean, enrich_email boolean
 )
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  return query
  with input as (
    select (e->>'row')::integer as row_no, t.ord,
           nullif(btrim(left(e->>'name', 1000)), '') as name_c,
           nullif(btrim(left(e->>'phone', 200)), '') as phone_raw,
           nullif(btrim(left(e->>'email', 500)), '') as email_raw
    from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
  ),
  norm as (
    select i.*, lower(i.name_c) as name_n,
           private.normalize_phone(i.phone_raw) as phone_k, private.normalize_email(i.email_raw) as email_k
    from input i
  ),
  checked as materialized (
    select n.*,
           case
             when n.name_c is null then 'name_missing'
             when char_length(n.name_c) > 200 then 'name_too_long'
             when n.phone_raw is null and n.email_raw is null then 'contact_missing'
             when n.phone_raw is not null and (char_length(n.phone_raw) > 50 or n.phone_k is null or n.phone_k !~ '^\+?[0-9]{7,15}$') then 'phone_invalid'
             when n.email_raw is not null and (char_length(n.email_raw) > 254 or n.email_k !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then 'email_invalid'
           end as bad
    from norm n
  ),
  valid as materialized (select * from checked where bad is null),
  -- 1. against the EXISTING customers of this salon (and only this salon): set-based hash joins, linear in the rows
  cp as materialized (
    select c.id, c.created_at, c.phone_normalized as k, lower(btrim(c.full_name)) as n
    from public.customers c
    where c.tenant_id = p_tenant_id and c.deleted_at is null and c.phone_normalized is not null
  ),
  ce as materialized (
    select c.id, c.created_at, c.email_normalized as k, lower(btrim(c.full_name)) as n
    from public.customers c
    where c.tenant_id = p_tenant_id and c.deleted_at is null and c.email_normalized is not null
  ),
  pj as materialized (
    select v.ord,
           count(distinct cp.id) filter (where cp.n = v.name_n) as pm_same,
           count(distinct cp.id) filter (where cp.n <> v.name_n) as pm_other,
           (array_agg(cp.id order by cp.created_at, cp.id) filter (where cp.n = v.name_n))[1] as ph_id,
           (array_agg(cp.id order by cp.created_at, cp.id))[1] as ph_any
    from valid v join cp on cp.k = v.phone_k
    group by v.ord
  ),
  ej as materialized (
    select v.ord,
           count(distinct ce.id) filter (where ce.n = v.name_n) as em_same,
           count(distinct ce.id) filter (where ce.n <> v.name_n) as em_other,
           (array_agg(ce.id order by ce.created_at, ce.id) filter (where ce.n = v.name_n))[1] as em_id,
           (array_agg(ce.id order by ce.created_at, ce.id))[1] as em_any
    from valid v join ce on ce.k = v.email_k
    group by v.ord
  ),
  matched as materialized (
    select v.*,
           coalesce(pj.pm_same, 0) as pm_same, coalesce(pj.pm_other, 0) as pm_other, pj.ph_id, pj.ph_any,
           coalesce(ej.em_same, 0) as em_same, coalesce(ej.em_other, 0) as em_other, ej.em_id, ej.em_any
    from valid v
    left join pj on pj.ord = v.ord
    left join ej on ej.ord = v.ord
  ),
  decided as materialized (
    select m.*,
      case
        when m.pm_same > 1 or m.em_same > 1 then 'multiple_existing'
        when m.pm_same = 0 and m.pm_other > 0 then 'phone_other_name'
        when m.em_same = 0 and m.em_other > 0 then 'email_other_name'
        when m.ph_id is not null and m.em_id is not null and m.ph_id <> m.em_id then 'conflicting_matches'
      end as amb,
      coalesce(m.ph_id, m.em_id) as target
    from matched m
  ),
  -- 2. against EARLIER rows of the same file that are themselves acceptable (a row that is refused does not block the next).
  --    Window counts instead of pairwise comparison: linear in the number of rows.
  acc as materialized (
    select d.ord,
      case when d.phone_k is not null then count(*) over (partition by d.phone_k, d.name_n order by d.ord rows between unbounded preceding and 1 preceding) else 0 end as same_phone,
      case when d.phone_k is not null then count(*) over (partition by d.phone_k order by d.ord rows between unbounded preceding and 1 preceding) else 0 end as any_phone,
      case when d.email_k is not null then count(*) over (partition by d.email_k, d.name_n order by d.ord rows between unbounded preceding and 1 preceding) else 0 end as same_email,
      case when d.email_k is not null then count(*) over (partition by d.email_k order by d.ord rows between unbounded preceding and 1 preceding) else 0 end as any_email
    from decided d
    where d.amb is null
  ),
  filed as (
    select d.*,
      case
        when a.ord is null then null
        when a.same_phone > 0 or a.same_email > 0 then 'duplicate_in_file'
        when a.any_phone > a.same_phone or a.any_email > a.same_email then 'file_conflict'
      end as filebad
    from decided d
    left join acc a on a.ord = d.ord
  )
  select r.row_no, r.status, r.reason, r.name_c, r.phone_raw, r.email_raw, r.existing_id, r.existing_name, r.enrich_phone, r.enrich_email
  from (
    select c.row_no, c.ord, 'INVALID'::text as status, c.bad as reason, c.name_c, c.phone_raw, c.email_raw,
           null::uuid as existing_id, null::text as existing_name, false as enrich_phone, false as enrich_email
    from checked c where c.bad is not null
    union all
    select d.row_no, d.ord,
           case when d.amb is not null then 'AMBIGUOUS'
                when d.filebad = 'duplicate_in_file' then 'INVALID'
                when d.filebad is not null then 'AMBIGUOUS'
                when d.target is not null then 'MATCH_EXISTING'
                else 'NEW' end,
           coalesce(d.amb, d.filebad), d.name_c, d.phone_raw, d.email_raw,
           case when d.amb is null and d.filebad is null then d.target end,
           (select c.full_name from public.customers c where c.id = coalesce(d.target, d.ph_any, d.em_any)),
           -- fill an EMPTY phone / e-mail of the matched customer when no other customer owns the incoming value
           (d.amb is null and d.filebad is null and d.target is not null and d.phone_k is not null and d.pm_same = 0 and d.pm_other = 0
              and exists (select 1 from public.customers c where c.id = d.target and c.phone_normalized is null)),
           (d.amb is null and d.filebad is null and d.target is not null and d.email_k is not null and d.em_same = 0 and d.em_other = 0
              and exists (select 1 from public.customers c where c.id = d.target and c.email_normalized is null))
    from filed d
  ) r
  order by r.ord;
end;
$function$;

create or replace function private.preview_customer_import(p_tenant_id uuid, p_rows jsonb)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  perform private.customer_import_gate(p_tenant_id, p_rows);
  return (
    with c as (select * from private.classify_customer_import(p_tenant_id, p_rows))
    select jsonb_build_object(
      'maxRows', 5000,
      'summary', jsonb_build_object(
        'total', (select count(*) from c),
        'new', (select count(*) from c where c.status = 'NEW'),
        'matchExisting', (select count(*) from c where c.status = 'MATCH_EXISTING'),
        'invalid', (select count(*) from c where c.status = 'INVALID'),
        'ambiguous', (select count(*) from c where c.status = 'AMBIGUOUS'),
        'willFillPhone', (select count(*) from c where c.enrich_phone),
        'willFillEmail', (select count(*) from c where c.enrich_email)
      ),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'row', c.row_no, 'status', c.status, 'reason', c.reason, 'existingName', c.existing_name,
          'fillPhone', c.enrich_phone, 'fillEmail', c.enrich_email
        ) order by c.row_no) from c
      ), '[]'::jsonb)
    )
  );
end;
$function$;

create or replace function private.commit_customer_import(p_tenant_id uuid, p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_new integer := 0;
  v_filled_phone integer := 0;
  v_filled_email integer := 0;
  v_result jsonb;
begin
  perform private.customer_import_gate(p_tenant_id, p_rows);

  -- one import per salon at a time; the classification below is taken AFTER the lock, so a retry or a concurrent
  -- duplicate import sees exactly what the first one wrote
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':customer-import', 0));

  create temporary table pg_temp.ci_rows on commit drop as
  select * from private.classify_customer_import(p_tenant_id, p_rows);

  with ins as (
    insert into public.customers (tenant_id, full_name, phone, email, status, created_by)
    select p_tenant_id, r.name_clean, r.phone_raw, r.email_raw, 'active', auth.uid()
    from pg_temp.ci_rows r where r.status = 'NEW' order by r.row_no
    returning 1
  )
  select count(*) into v_new from ins;

  -- fill only EMPTY values, one statement per field so each fill is counted exactly once
  with upd as (
    update public.customers c set phone = r.phone_raw
    from pg_temp.ci_rows r
    where r.status = 'MATCH_EXISTING' and r.enrich_phone and c.id = r.existing_id and c.tenant_id = p_tenant_id and c.phone_normalized is null
    returning 1
  )
  select count(*) into v_filled_phone from upd;

  with upd as (
    update public.customers c set email = r.email_raw
    from pg_temp.ci_rows r
    where r.status = 'MATCH_EXISTING' and r.enrich_email and c.id = r.existing_id and c.tenant_id = p_tenant_id and c.email_normalized is null
    returning 1
  )
  select count(*) into v_filled_email from upd;

  select jsonb_build_object(
    'summary', jsonb_build_object(
      'total', count(*),
      'created', v_new,
      'matchExisting', count(*) filter (where r.status = 'MATCH_EXISTING'),
      'filledPhone', v_filled_phone,
      'filledEmail', v_filled_email,
      'skippedInvalid', count(*) filter (where r.status = 'INVALID'),
      'skippedAmbiguous', count(*) filter (where r.status = 'AMBIGUOUS')
    ),
    'rows', coalesce(jsonb_agg(jsonb_build_object('row', r.row_no, 'status', r.status, 'reason', r.reason, 'existingName', r.existing_name) order by r.row_no)
                     filter (where r.status in ('INVALID', 'AMBIGUOUS')), '[]'::jsonb)
  ) into v_result
  from pg_temp.ci_rows r;

  drop table pg_temp.ci_rows;

  -- one summary event: counts only, never a name, phone or e-mail
  perform private.log_audit_event(
    p_tenant_id, 'customers.import_committed', 'customers', p_tenant_id, null,
    jsonb_build_object(
      'total', (v_result->'summary'->>'total')::integer, 'created', v_new, 'filledPhone', v_filled_phone, 'filledEmail', v_filled_email,
      'skippedInvalid', (v_result->'summary'->>'skippedInvalid')::integer, 'skippedAmbiguous', (v_result->'summary'->>'skippedAmbiguous')::integer
    )
  );

  return v_result;
end;
$function$;

revoke all on function private.customer_import_gate(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.classify_customer_import(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.preview_customer_import(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.commit_customer_import(uuid, jsonb) from public, anon, authenticated, service_role;

create or replace function public.preview_customer_import(p_tenant_id uuid, p_rows jsonb)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select private.preview_customer_import(p_tenant_id, p_rows);
$function$;

create or replace function public.commit_customer_import(p_tenant_id uuid, p_rows jsonb)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  select private.commit_customer_import(p_tenant_id, p_rows);
$function$;

revoke all on function public.preview_customer_import(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.commit_customer_import(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.preview_customer_import(uuid, jsonb) to authenticated;
grant execute on function public.commit_customer_import(uuid, jsonb) to authenticated;
