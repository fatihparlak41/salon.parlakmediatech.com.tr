-- Faz BEAUTY.1B - treatment history, private treatment photos, rebooking interval.
--
-- Decisions (generic; nothing here is named after a business or a treatment):
--   * A TREATMENT is a completed appointment ITEM (one service performed by one person). Nothing new is stored for the history
--     itself: it is derived (read-only) from completed appointments, so a future, cancelled, no-show or still-open appointment is
--     never history. The performer is coalesce(sale item actual staff, item actual staff, booked staff) - the same rule COMM.1A
--     and the performance reports use.
--   * Operational note (treatment_notes): one short salon-authored line per treatment. Not the private appointment note, not a
--     medical record; the UI discourages diagnosis/health content and nothing infers any.
--   * Photos (treatment_media): metadata only; the bytes live in a PRIVATE storage bucket. Path = <tenant uuid>/<random uuid>.<ext>
--     (no customer data, no original file name). before | after | other, tied to ONE treatment, never to the customer globally.
--     Image-only allow-list (jpeg/png/webp), 2 MiB, at most 8 per treatment. Register -> upload -> confirm; read via a short-lived
--     signed URL created only after the database has authorised the exact media row. This is INTERNAL treatment documentation,
--     not social-media/marketing consent (PHOTO_MARKETING_CONSENT is a separate, later workstream).
--   * Access: read = customers.view AND appointments.view; write (note, photos) = customers.update; treatment VALUE additionally
--     needs appointments.update (the existing price-snapshot rule). No new permission keys (the locked role matrices are untouched):
--     Owner, Yonetici, Resepsiyon read/write; Personel (appointments.view only) sees nothing.
--   * Rebooking: services.rebook_min_days / rebook_max_days (optional, generic). Window = treatment local date + min .. + max for
--     the customer's LATEST completed treatment of that service; states none | booked | not_due | due | overdue. Never auto-books,
--     never sends anything.
--   * Quick rebook: get_treatment_rebook_defaults returns the service, the branch and the performer ONLY while each is still
--     offered/active/eligible in the same tenant; the customer, the date and the time are always chosen again.
--   * Error codes: BH001 not signed in, BH002 not allowed, BH003 not found / not a completed treatment / no longer offered,
--     BH004 invalid input, BH005 photo limit reached, BH006 uploaded object missing or not what was declared.

begin;

alter table public.services
  add column rebook_min_days integer check (rebook_min_days between 1 and 730),
  add column rebook_max_days integer check (rebook_max_days between 1 and 730),
  add constraint services_rebook_range check (
    (rebook_min_days is null and rebook_max_days is null)
    or (rebook_min_days is not null and (rebook_max_days is null or rebook_max_days >= rebook_min_days))
  );

comment on column public.services.rebook_min_days is 'Faz BEAUTY.1B. Optional recommended re-booking window start, days after a completed treatment. Generic; never enforced, never auto-booked.';

create table public.treatment_notes (
  appointment_item_id uuid primary key references public.appointment_items (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id),
  note text not null check (char_length(btrim(note)) between 1 and 500),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.treatment_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  appointment_item_id uuid not null references public.appointment_items (id) on delete cascade,
  kind text not null check (kind in ('before', 'after', 'other')),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 2097152),
  storage_path text not null unique check (storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create index treatment_media_item_idx on public.treatment_media (tenant_id, appointment_item_id);

alter table public.treatment_notes enable row level security;
alter table public.treatment_media enable row level security;
revoke all on public.treatment_notes from public, anon, authenticated, service_role;
revoke all on public.treatment_media from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- gates and the single "is this a completed treatment of this tenant" check
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.treatment_gate(p_tenant_id uuid, p_permissions text[])
 returns text
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_perm text;
  v_tz text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'BH001';
  end if;
  foreach v_perm in array p_permissions loop
    if not private.has_permission(p_tenant_id, v_perm) then
      raise exception 'not allowed' using errcode = 'BH002';
    end if;
  end loop;
  select t.timezone into v_tz from public.tenants t where t.id = p_tenant_id and t.deleted_at is null;
  if v_tz is null then
    raise exception 'not allowed' using errcode = 'BH002';
  end if;
  return v_tz;
end;
$function$;

revoke all on function private.treatment_gate(uuid, text[]) from public, anon, authenticated, service_role;

-- the treatment (appointment item) iff it belongs to the tenant, its appointment is completed, and its customer is not deleted
create or replace function private.treatment_item_exists(p_tenant_id uuid, p_item_id uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select exists (
    select 1
    from public.appointment_items ai
    join public.appointments ap on ap.id = ai.appointment_id and ap.tenant_id = p_tenant_id
    join public.customers c on c.id = ap.customer_id and c.tenant_id = p_tenant_id and c.deleted_at is null
    where ai.id = p_item_id and ai.tenant_id = p_tenant_id and ap.status = 'completed'
  );
$function$;

revoke all on function private.treatment_item_exists(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- the history (derived) with the rebooking state
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.get_customer_treatment_history(p_tenant_id uuid, p_customer_id uuid, p_limit integer)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.treatment_gate(p_tenant_id, array['customers.view', 'appointments.view']);
  v_value boolean := private.has_permission(p_tenant_id, 'appointments.update');
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

revoke all on function private.get_customer_treatment_history(uuid, uuid, integer) from public, anon, authenticated, service_role;

-- quick rebook: only what is STILL true in this tenant; customer, date and time are chosen again
create or replace function private.get_treatment_rebook_defaults(p_tenant_id uuid, p_item_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.treatment_gate(p_tenant_id, array['customers.view', 'appointments.create']);
  v_service uuid;
  v_name text;
  v_branch uuid;
  v_staff uuid;
  v_branch_ok uuid;
  v_staff_ok uuid;
begin
  if not private.treatment_item_exists(p_tenant_id, p_item_id) then
    raise exception 'not found' using errcode = 'BH003';
  end if;
  select ai.service_id, sv.name, ap.branch_id,
         coalesce(asi.actual_staff_member_id, ai.actual_staff_member_id, ai.staff_member_id)
    into v_service, v_name, v_branch, v_staff
  from public.appointment_items ai
  join public.appointments ap on ap.id = ai.appointment_id and ap.tenant_id = p_tenant_id
  join public.services sv on sv.id = ai.service_id and sv.tenant_id = p_tenant_id and sv.status = 'active' and sv.deleted_at is null
  left join public.appointment_sales s on s.appointment_id = ap.id and s.tenant_id = p_tenant_id and s.status <> 'voided'
  left join public.appointment_sale_items asi on asi.appointment_item_id = ai.id and asi.sale_id = s.id and asi.tenant_id = p_tenant_id
  where ai.id = p_item_id and ai.tenant_id = p_tenant_id;
  if v_service is null then
    raise exception 'service no longer offered' using errcode = 'BH003';
  end if;
  select b.id into v_branch_ok
  from public.branches b
  join public.service_branches sb on sb.branch_id = b.id and sb.service_id = v_service
  where b.id = v_branch and b.tenant_id = p_tenant_id and b.deleted_at is null;
  if v_branch_ok is not null then
    select sm.id into v_staff_ok
    from public.staff_members sm
    join public.staff_branches sbr on sbr.staff_member_id = sm.id and sbr.branch_id = v_branch_ok
    join public.staff_services ss on ss.staff_member_id = sm.id and ss.service_id = v_service
    where sm.id = v_staff and sm.tenant_id = p_tenant_id and sm.status = 'active' and sm.deleted_at is null;
  end if;
  return jsonb_build_object('serviceId', v_service, 'serviceName', v_name, 'branchId', v_branch_ok, 'staffId', v_staff_ok);
end;
$function$;

revoke all on function private.get_treatment_rebook_defaults(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- note
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.set_treatment_note(p_tenant_id uuid, p_item_id uuid, p_note text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.treatment_gate(p_tenant_id, array['customers.update']);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not private.treatment_item_exists(p_tenant_id, p_item_id) then
    raise exception 'not found' using errcode = 'BH003';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note too long' using errcode = 'BH004';
  end if;
  if v_note is null then
    delete from public.treatment_notes where appointment_item_id = p_item_id and tenant_id = p_tenant_id;
  else
    insert into public.treatment_notes (appointment_item_id, tenant_id, note, updated_by)
    values (p_item_id, p_tenant_id, v_note, auth.uid())
    on conflict (appointment_item_id) do update set note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform private.log_audit_event(p_tenant_id, 'treatment.note_set', 'treatment_note', p_item_id, null,
    jsonb_build_object('cleared', v_note is null, 'length', coalesce(char_length(v_note), 0)));
  return jsonb_build_object('saved', v_note is not null);
end;
$function$;

revoke all on function private.set_treatment_note(uuid, uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- photos: register -> upload -> confirm; access; delete
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.register_treatment_photo(p_tenant_id uuid, p_item_id uuid, p_kind text, p_mime text, p_size integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.treatment_gate(p_tenant_id, array['customers.update']);
  v_id uuid := gen_random_uuid();
  v_ext text;
  v_path text;
begin
  if not private.treatment_item_exists(p_tenant_id, p_item_id) then
    raise exception 'not found' using errcode = 'BH003';
  end if;
  if p_kind not in ('before', 'after', 'other') then
    raise exception 'invalid kind' using errcode = 'BH004';
  end if;
  v_ext := case p_mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else null end;
  if v_ext is null then
    raise exception 'unsupported file type' using errcode = 'BH004';
  end if;
  if p_size is null or p_size < 1 or p_size > 2097152 then
    raise exception 'invalid file size' using errcode = 'BH004';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_item_id::text || ':treatment-media', 0));
  if (select count(*) from public.treatment_media m where m.appointment_item_id = p_item_id and m.tenant_id = p_tenant_id) >= 8 then
    raise exception 'photo limit reached' using errcode = 'BH005';
  end if;
  v_path := p_tenant_id::text || '/' || v_id::text || '.' || v_ext;
  insert into public.treatment_media (id, tenant_id, appointment_item_id, kind, mime_type, size_bytes, storage_path, created_by)
  values (v_id, p_tenant_id, p_item_id, p_kind, p_mime, p_size, v_path, auth.uid());
  perform private.log_audit_event(p_tenant_id, 'treatment.photo_registered', 'treatment_media', v_id, null, jsonb_build_object('kind', p_kind));
  return jsonb_build_object('mediaId', v_id, 'path', v_path);
end;
$function$;

revoke all on function private.register_treatment_photo(uuid, uuid, text, text, integer) from public, anon, authenticated, service_role;

create or replace function private.confirm_treatment_photo(p_tenant_id uuid, p_media_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.treatment_gate(p_tenant_id, array['customers.update']);
  v_m public.treatment_media;
  v_objects jsonb;
  v_meta jsonb;
begin
  select * into v_m from public.treatment_media m where m.id = p_media_id and m.tenant_id = p_tenant_id for update;
  if not found or not private.treatment_item_exists(p_tenant_id, v_m.appointment_item_id) then
    raise exception 'not found' using errcode = 'BH003';
  end if;
  if v_m.created_by is distinct from auth.uid() then
    raise exception 'not allowed' using errcode = 'BH002';
  end if;
  if v_m.status = 'ready' then
    return jsonb_build_object('mediaId', v_m.id, 'status', 'ready');
  end if;
  -- when a storage backend exists, the object must be there and must be what was declared
  if to_regclass('storage.objects') is not null then
    execute 'select coalesce(jsonb_agg(coalesce(o.metadata, ''{}''::jsonb)), ''[]''::jsonb) from storage.objects o where o.bucket_id = $1 and o.name = $2' into v_objects using 'treatment-media', v_m.storage_path;
    if jsonb_array_length(v_objects) = 0 then
      raise exception 'uploaded file missing' using errcode = 'BH006';
    end if;
    v_meta := v_objects -> 0;
    if coalesce(v_meta ->> 'mimetype', '') <> v_m.mime_type or coalesce((v_meta ->> 'size')::integer, 0) not between 1 and 2097152 then
      raise exception 'uploaded file mismatch' using errcode = 'BH006';
    end if;
  end if;
  update public.treatment_media set status = 'ready', confirmed_at = now() where id = v_m.id;
  perform private.log_audit_event(p_tenant_id, 'treatment.photo_confirmed', 'treatment_media', v_m.id, null, jsonb_build_object('kind', v_m.kind));
  return jsonb_build_object('mediaId', v_m.id, 'status', 'ready');
end;
$function$;

revoke all on function private.confirm_treatment_photo(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function private.get_treatment_photo_access(p_tenant_id uuid, p_media_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.treatment_gate(p_tenant_id, array['customers.view', 'appointments.view']);
  v_m public.treatment_media;
begin
  select * into v_m from public.treatment_media m where m.id = p_media_id and m.tenant_id = p_tenant_id and m.status = 'ready';
  if not found or not private.treatment_item_exists(p_tenant_id, v_m.appointment_item_id) then
    raise exception 'not found' using errcode = 'BH003';
  end if;
  return jsonb_build_object('path', v_m.storage_path, 'mime', v_m.mime_type, 'kind', v_m.kind);
end;
$function$;

revoke all on function private.get_treatment_photo_access(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function private.delete_treatment_photo(p_tenant_id uuid, p_media_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.treatment_gate(p_tenant_id, array['customers.update']);
  v_m public.treatment_media;
begin
  select * into v_m from public.treatment_media m where m.id = p_media_id and m.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'not found' using errcode = 'BH003';
  end if;
  delete from public.treatment_media where id = v_m.id;
  perform private.log_audit_event(p_tenant_id, 'treatment.photo_deleted', 'treatment_media', v_m.id, null, jsonb_build_object('kind', v_m.kind));
  return jsonb_build_object('path', v_m.storage_path);
end;
$function$;

revoke all on function private.delete_treatment_photo(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- public wrappers (authenticated only)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.get_customer_treatment_history(p_tenant_id uuid, p_customer_id uuid, p_limit integer default 50)
 returns jsonb language sql stable security definer set search_path to ''
as $function$ select private.get_customer_treatment_history(p_tenant_id, p_customer_id, p_limit); $function$;

create or replace function public.get_treatment_rebook_defaults(p_tenant_id uuid, p_item_id uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$ select private.get_treatment_rebook_defaults(p_tenant_id, p_item_id); $function$;

create or replace function public.set_treatment_note(p_tenant_id uuid, p_item_id uuid, p_note text)
 returns jsonb language sql security definer set search_path to ''
as $function$ select private.set_treatment_note(p_tenant_id, p_item_id, p_note); $function$;

create or replace function public.register_treatment_photo(p_tenant_id uuid, p_item_id uuid, p_kind text, p_mime text, p_size integer)
 returns jsonb language sql security definer set search_path to ''
as $function$ select private.register_treatment_photo(p_tenant_id, p_item_id, p_kind, p_mime, p_size); $function$;

create or replace function public.confirm_treatment_photo(p_tenant_id uuid, p_media_id uuid)
 returns jsonb language sql security definer set search_path to ''
as $function$ select private.confirm_treatment_photo(p_tenant_id, p_media_id); $function$;

create or replace function public.get_treatment_photo_access(p_tenant_id uuid, p_media_id uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$ select private.get_treatment_photo_access(p_tenant_id, p_media_id); $function$;

create or replace function public.delete_treatment_photo(p_tenant_id uuid, p_media_id uuid)
 returns jsonb language sql security definer set search_path to ''
as $function$ select private.delete_treatment_photo(p_tenant_id, p_media_id); $function$;

revoke all on function public.get_customer_treatment_history(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_treatment_rebook_defaults(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_treatment_note(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.register_treatment_photo(uuid, uuid, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.confirm_treatment_photo(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_treatment_photo_access(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.delete_treatment_photo(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_customer_treatment_history(uuid, uuid, integer) to authenticated;
grant execute on function public.get_treatment_rebook_defaults(uuid, uuid) to authenticated;
grant execute on function public.set_treatment_note(uuid, uuid, text) to authenticated;
grant execute on function public.register_treatment_photo(uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.confirm_treatment_photo(uuid, uuid) to authenticated;
grant execute on function public.get_treatment_photo_access(uuid, uuid) to authenticated;
grant execute on function public.delete_treatment_photo(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- the private storage bucket and its policies (only where a storage backend exists)
-- ---------------------------------------------------------------------------------------------------------------
-- policy helpers: evaluated for the CALLER, so they are granted to authenticated; they read the closed metadata table as definer
create or replace function private.treatment_object_readable(p_name text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' and exists (
    select 1 from public.treatment_media m
    where m.storage_path = p_name and m.status = 'ready'
      and private.has_permission(m.tenant_id, 'customers.view') and private.has_permission(m.tenant_id, 'appointments.view')
      and private.treatment_item_exists(m.tenant_id, m.appointment_item_id)
  );
$function$;

create or replace function private.treatment_object_insertable(p_name text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' and exists (
    select 1 from public.treatment_media m
    where m.storage_path = p_name and m.status = 'pending' and m.created_by = auth.uid()
      and private.has_permission(m.tenant_id, 'customers.update')
      and private.treatment_item_exists(m.tenant_id, m.appointment_item_id)
  );
$function$;

create or replace function private.treatment_object_deletable(p_name text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' and private.has_permission(split_part(p_name, '/', 1)::uuid, 'customers.update');
$function$;

revoke all on function private.treatment_object_readable(text) from public, anon, authenticated, service_role;
revoke all on function private.treatment_object_insertable(text) from public, anon, authenticated, service_role;
revoke all on function private.treatment_object_deletable(text) from public, anon, authenticated, service_role;
grant execute on function private.treatment_object_readable(text) to authenticated;
grant execute on function private.treatment_object_insertable(text) to authenticated;
grant execute on function private.treatment_object_deletable(text) to authenticated;

do $storage$
begin
  if to_regclass('storage.objects') is not null and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('treatment-media', 'treatment-media', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

    drop policy if exists treatment_media_read on storage.objects;
    drop policy if exists treatment_media_insert on storage.objects;
    drop policy if exists treatment_media_delete on storage.objects;
    create policy treatment_media_read on storage.objects for select to authenticated
      using (bucket_id = 'treatment-media' and private.treatment_object_readable(name));
    create policy treatment_media_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'treatment-media' and private.treatment_object_insertable(name));
    create policy treatment_media_delete on storage.objects for delete to authenticated
      using (bucket_id = 'treatment-media' and private.treatment_object_deletable(name));
  end if;
end
$storage$;

commit;
