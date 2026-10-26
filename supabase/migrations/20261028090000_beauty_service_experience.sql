-- Faz BEAUTY.1A - service experience: how a service is PRESENTED and whether it is bookable online.
--
-- Generic service capabilities (hair, nails, laser, beauty ...). Nothing here is named after a business or a treatment.
--
-- Decisions (all reuse the existing services table; no new table, no new concept where a column does the job):
--   * pricing_mode  fixed | inquiry   - 'inquiry' = the price is agreed with the salon ("Fiyat icin iletisime gecin"). The
--                                       price column stays NOT NULL (0 internally) but is NEVER shown or used for inquiry.
--   * booking_mode  direct | inquiry  - 'inquiry' = the system does not schedule it: no public slots, no eligible staff,
--                                       no guest booking, no appointment item (guard trigger). pricing 'inquiry' implies
--                                       booking 'inquiry' (CHECK).
--   * price_public  - the price is shown on the public booking page ONLY when the salon opted in (default false = exactly
--                     the previous behaviour, where the page never showed prices - Faz 2I.2C).
--   * display_duration_min/max - the customer-facing duration ("30-40 dk"); NOT the calendar duration, which stays
--                     duration_minutes and is never shown publicly.
--   * public_summary (card line), public_details ("Islem hakkinda"), preparation_note ("Randevu oncesi"),
--     aftercare_note, important_note, badge_label - salon-authored copy, each optional and length-limited. The existing
--     internal `description` is deliberately NOT reused: salons may already keep private notes there.
--   * LAUNCH.1B can later read name + preparation_note + important_note from the service id of an appointment item.
--
-- Public API: get_public_booking_context now returns these fields instead of the booking duration and the raw price;
-- is_public_service_valid additionally requires booking_mode = 'direct'. Grants are preserved by CREATE OR REPLACE.

begin;

alter table public.services
  add column pricing_mode text not null default 'fixed' check (pricing_mode in ('fixed', 'inquiry')),
  add column booking_mode text not null default 'direct' check (booking_mode in ('direct', 'inquiry')),
  add column price_public boolean not null default false,
  add column display_duration_min integer check (display_duration_min between 1 and 1440),
  add column display_duration_max integer check (display_duration_max between 1 and 1440),
  add column public_summary text check (public_summary is null or char_length(btrim(public_summary)) between 1 and 160),
  add column public_details text check (public_details is null or char_length(btrim(public_details)) between 1 and 1000),
  add column preparation_note text check (preparation_note is null or char_length(btrim(preparation_note)) between 1 and 300),
  add column aftercare_note text check (aftercare_note is null or char_length(btrim(aftercare_note)) between 1 and 300),
  add column important_note text check (important_note is null or char_length(btrim(important_note)) between 1 and 200),
  add column badge_label text check (badge_label is null or char_length(btrim(badge_label)) between 1 and 40),
  add constraint services_inquiry_pricing_is_inquiry_booking check (pricing_mode <> 'inquiry' or booking_mode = 'inquiry'),
  add constraint services_display_duration_range check (
    (display_duration_min is null and display_duration_max is null)
    or (display_duration_min is not null and (display_duration_max is null or display_duration_max >= display_duration_min))
  );

comment on column public.services.pricing_mode is 'Faz BEAUTY.1A. fixed = price column is the price; inquiry = price agreed with the salon (price column unused, never displayed).';
comment on column public.services.booking_mode is 'Faz BEAUTY.1A. direct = bookable online/in the calendar; inquiry = contact the salon, the system never schedules it.';
comment on column public.services.price_public is 'Faz BEAUTY.1A. Show the price on the public booking page (opt-in; default false keeps the earlier no-price page).';
comment on column public.services.display_duration_min is 'Faz BEAUTY.1A. Customer-facing duration (lower bound, minutes). Not the calendar duration (duration_minutes).';

-- an inquiry service is never scheduled by the system: no appointment item may be inserted for it, by any path
create or replace function private.guard_inquiry_service_item()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if exists (select 1 from public.services s where s.id = new.service_id and s.booking_mode = 'inquiry') then
    raise exception 'service is not bookable' using errcode = 'BK003';
  end if;
  return new;
end;
$function$;

revoke all on function private.guard_inquiry_service_item() from public, anon, authenticated, service_role;

create trigger guard_inquiry_service_item
  before insert on public.appointment_items
  for each row execute function private.guard_inquiry_service_item();

-- the public read functions (eligible staff, availability) only answer for directly bookable services
create or replace function private.is_public_service_valid(p_tenant_id uuid, p_branch_id uuid, p_service_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.services s
    join public.service_branches sb on sb.service_id = s.id
    where s.id = p_service_id
      and s.tenant_id = p_tenant_id
      and s.status = 'active'
      and s.deleted_at is null
      and s.booking_mode = 'direct'
      and sb.branch_id = p_branch_id
  );
$$;

create or replace function public.get_public_booking_context(p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant record;
  v_result jsonb;
begin
  select t.id, t.name, t.slug, t.timezone into v_tenant
  from public.tenants t
  where t.slug = p_tenant_slug
    and t.deleted_at is null
    and t.status in ('trial', 'active')
    and private.has_feature(t.id, 'online_booking');

  if not found then
    return jsonb_build_object('bookable', false);
  end if;

  select jsonb_build_object(
    'bookable', true,
    'salon', jsonb_build_object('name', v_tenant.name, 'slug', v_tenant.slug, 'timezone', v_tenant.timezone),
    'branches', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', b.id,
        'name', b.name,
        'address', b.address,
        'phone', b.phone,
        'whatsappPhone', b.whatsapp_phone,
        'instagramHandle', b.instagram_handle,
        'locationUrl', b.location_url,
        'services', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', s.id, 'name', s.name, 'category', s.category,
              'pricingMode', s.pricing_mode,
              'bookingMode', s.booking_mode,
              'price', case when s.pricing_mode = 'fixed' and s.price_public then s.price end,
              'displayDurationMin', s.display_duration_min,
              'displayDurationMax', s.display_duration_max,
              'summary', s.public_summary,
              'details', s.public_details,
              'preparationNote', s.preparation_note,
              'aftercareNote', s.aftercare_note,
              'importantNote', s.important_note,
              'badge', s.badge_label
            )
            order by s.display_order, s.name
          ), '[]'::jsonb)
          from public.services s
          join public.service_branches sb on sb.service_id = s.id
          where sb.branch_id = b.id and s.tenant_id = v_tenant.id and s.status = 'active' and s.deleted_at is null
        )
      )
      order by b.is_primary desc, b.name
    ), '[]'::jsonb)
  ) into v_result
  from public.branches b
  where b.tenant_id = v_tenant.id and b.deleted_at is null;

  return v_result;
end;
$$;

commit;
