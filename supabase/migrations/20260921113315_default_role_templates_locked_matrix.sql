-- Faz SAAS.1E.1 (part 1) — the four primary default roles and their LOCKED
-- permission matrix, as reference data.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- A tenant is born with exactly one role today (Salon Sahibi). Before any
-- real non-owner login exists, a salon owner needs four standard roles with
-- deliberate, minimal permission sets. This migration only defines them as
-- REFERENCE DATA (role_templates + role_template_permissions). It does not
-- touch a single tenant: provisioning (part 3) and the existing-tenant
-- backfill (part 6) are separate, so each can be reviewed and rolled back on
-- its own.
--
-- =====================================================================
-- THE MATRIX (23-key catalog; nothing is invented)
-- =====================================================================
--
--   SALON_OWNER   "Salon Sahibi"  ALL 23 keys, including
--                                 permissions.manage_unrestricted.
--
--   SALON_MANAGER "Yönetici"      16 keys — operational management:
--       appointments.view/create/update/cancel
--       customers.view/create/update/link_account
--       staff.view, staff.manage
--       schedules.view, schedules.manage
--       services.view, services.manage
--       reports.basic, reports.staff
--     NOT: permissions.manage_unrestricted, finance.view/manage,
--          inventory.view/manage, reports.financial (Owner-only until
--          FIN.1), and NOT settings.manage — see below.
--
--   RECEPTIONIST  "Resepsiyon"     9 keys:
--       appointments.view/create/update/cancel
--       customers.view/create/update
--       schedules.view, services.view
--     NOT: customers.link_account, staff.manage, settings.manage,
--          reports.*, finance.*, inventory.*, permissions.manage_unrestricted.
--
--   STYLIST       "Personel"       1 key: appointments.view.
--     Personel sees ALL salon appointments and nothing else. No
--     appointments.create/update/cancel, no customers.view. Everything the
--     calendar needs beyond appointments.view (services, staff, branches,
--     schedules) is already readable by any tenant member; the customer's
--     DISPLAY NAME comes from the appointment-scoped projection of
--     migration 4, not from customers.view.
--
-- settings.manage is deliberately NOT in the Yönetici set. The permission is
-- broader than its name: tenants_update_settings_manage plus an all-column
-- UPDATE grant lets a holder rewrite tenants.slug (the public booking URL),
-- status, deleted_at, trial_ends_at and currency, and branches insert/update
-- plus the online-booking switch hang off it too. Normal day-to-day salon
-- management (appointments, customers, staff, schedules, services, basic
-- and staff reports) needs none of that, so it stays Owner-only until the
-- settings permissions are split.
--
-- Existing optional templates (CASHIER, STOCK_MANAGER, ACCOUNTANT) stay
-- exactly as they are and stay available internally; they are simply not
-- part of the four-role default.
--
-- The primary templates are marked with provision_by_default and ordered by
-- display_order so provisioning is DATA-driven (a future fifth default role
-- is one more row, not a code change) and never depends on a display name.
--
-- Idempotent: safe to run twice; the final block asserts the exact sizes.

alter table public.role_templates
  add column if not exists provision_by_default boolean not null default false,
  add column if not exists display_order smallint;

comment on column public.role_templates.provision_by_default is
  'true = this template is provisioned into EVERY tenant as a system-default role (the four primary roles). Optional templates stay false.';
comment on column public.role_templates.display_order is
  'Provisioning / display order of the primary templates (ascending). Null for optional templates.';

-- Names and descriptions are the user-facing Turkish copy; the stable
-- identity of a role is its key, never its name.
update public.role_templates
set name = 'Salon Sahibi', description = 'Tam yetki', provision_by_default = true, display_order = 10
where key = 'SALON_OWNER';

update public.role_templates
set name = 'Yönetici', description = 'Günlük salon operasyonu; finans, envanter ve sahiplik yetkileri hariç',
    provision_by_default = true, display_order = 20
where key = 'SALON_MANAGER';

update public.role_templates
set name = 'Resepsiyon', description = 'Randevu ve müşteri kayıt işlemleri',
    provision_by_default = true, display_order = 30
where key = 'RECEPTIONIST';

update public.role_templates
set name = 'Personel', description = 'Tüm salon randevularını görüntüler; müşteri iletişim bilgilerini görmez',
    provision_by_default = true, display_order = 40
where key = 'STYLIST';

update public.role_templates
set provision_by_default = false, display_order = null
where key not in ('SALON_OWNER', 'SALON_MANAGER', 'RECEPTIONIST', 'STYLIST');

do $$
declare
  v_matrix constant jsonb := jsonb_build_object(
    'SALON_MANAGER', jsonb_build_array(
      'appointments.view', 'appointments.create', 'appointments.update', 'appointments.cancel',
      'customers.view', 'customers.create', 'customers.update', 'customers.link_account',
      'staff.view', 'staff.manage',
      'schedules.view', 'schedules.manage',
      'services.view', 'services.manage',
      'reports.basic', 'reports.staff'),
    'RECEPTIONIST', jsonb_build_array(
      'appointments.view', 'appointments.create', 'appointments.update', 'appointments.cancel',
      'customers.view', 'customers.create', 'customers.update',
      'schedules.view', 'services.view'),
    'STYLIST', jsonb_build_array('appointments.view')
  );
  v_key text;
  v_template_id uuid;
  v_unknown text[];
begin
  -- SALON_OWNER: every permission that exists in the catalog.
  select id into v_template_id from public.role_templates where key = 'SALON_OWNER';
  if v_template_id is null then
    raise exception 'SALON_OWNER role template is missing — seed data problem';
  end if;
  insert into public.role_template_permissions (role_template_id, permission_id)
  select v_template_id, p.id from public.permissions p
  on conflict do nothing;

  -- The other three primary templates: converge to EXACTLY the matrix.
  for v_key in select jsonb_object_keys(v_matrix) loop
    select id into v_template_id from public.role_templates where key = v_key;
    if v_template_id is null then
      raise exception 'role template % is missing — seed data problem', v_key;
    end if;

    select array_agg(k) into v_unknown
    from jsonb_array_elements_text(v_matrix -> v_key) as k
    where not exists (select 1 from public.permissions p where p.key = k);
    if v_unknown is not null then
      raise exception 'unknown permission key(s) for %: % — the catalog has 23 keys and none may be invented', v_key, v_unknown;
    end if;

    delete from public.role_template_permissions rtp
    where rtp.role_template_id = v_template_id
      and rtp.permission_id not in (
        select p.id from public.permissions p
        where p.key in (select jsonb_array_elements_text(v_matrix -> v_key)));

    insert into public.role_template_permissions (role_template_id, permission_id)
    select v_template_id, p.id from public.permissions p
    where p.key in (select jsonb_array_elements_text(v_matrix -> v_key))
    on conflict do nothing;
  end loop;

  -- Post-conditions: fail the whole migration loudly rather than ship a
  -- matrix that is not the locked one.
  if (select count(*) from public.role_template_permissions rtp join public.role_templates rt on rt.id = rtp.role_template_id where rt.key = 'SALON_OWNER')
     <> (select count(*) from public.permissions) then
    raise exception 'SALON_OWNER template must hold every permission';
  end if;
  if (select count(*) from public.role_template_permissions rtp join public.role_templates rt on rt.id = rtp.role_template_id where rt.key = 'SALON_MANAGER') <> 16
     or (select count(*) from public.role_template_permissions rtp join public.role_templates rt on rt.id = rtp.role_template_id where rt.key = 'RECEPTIONIST') <> 9
     or (select count(*) from public.role_template_permissions rtp join public.role_templates rt on rt.id = rtp.role_template_id where rt.key = 'STYLIST') <> 1 then
    raise exception 'default role template sizes are not 16 / 9 / 1';
  end if;
  if exists (
    select 1
    from public.role_template_permissions rtp
    join public.role_templates rt on rt.id = rtp.role_template_id
    join public.permissions p on p.id = rtp.permission_id
    where rt.key = 'SALON_MANAGER'
      and (p.key in ('permissions.manage_unrestricted', 'settings.manage', 'reports.financial')
           or p.key like 'finance.%' or p.key like 'inventory.%')
  ) then
    raise exception 'SALON_MANAGER must not hold owner-only permissions';
  end if;
  if (select count(*) from public.role_templates where provision_by_default) <> 4 then
    raise exception 'exactly four templates must be provisioned by default';
  end if;
end;
$$;
