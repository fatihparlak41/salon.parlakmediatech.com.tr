-- Faz LAUNCH.1A (1 of 3) — owner-approval gate on tenant provisioning.
--
-- WHY
-- Until now ANY signed-in account could create a salon: /sign-up is open, and
-- public.create_tenant (SECURITY DEFINER, EXECUTE granted to `authenticated`)
-- only checked auth.uid(). During the Founding Salon phase SalonOS is
-- invite / owner-approval only, so an arbitrary internet user must not be able
-- to provision a production tenant — and an application-level check is not
-- enough: the publishable key is public, so a signed-in user can call the RPC
-- straight through PostgREST. The gate therefore lives in the function that
-- actually creates the tenant.
--
-- WHAT CHANGES
--  1. public.tenant_provisioning_approvals — one row per approval of an e-mail
--     address to create ONE salon. Fully locked down (RLS on, no policy, no
--     privilege for any API role); reached only through the RPCs below.
--  2. private.create_tenant_with_owner — the live PROD definition
--     (20260921113325) with exactly one addition at the very top: the caller
--     must be a platform admin OR hold a live, unconsumed approval for their own
--     CONFIRMED e-mail address, which is consumed in the same transaction. The
--     check runs before any argument validation so an unapproved caller learns
--     nothing about slug availability.
--  3. Four RPCs (private implementation + public wrapper each):
--       platform_approve_tenant_owner(email, note, valid_days)  platform owner
--       platform_revoke_tenant_owner_approval(approval_id)       platform owner
--       platform_list_tenant_owner_approvals()                   platform owner
--       get_my_tenant_provisioning_status()                      any signed-in user,
--                                                                about THEMSELVES only
--
-- WHAT DOES NOT CHANGE
-- Existing tenants, memberships and roles; invitation acceptance (it creates a
-- membership in an EXISTING tenant, never a tenant); customer accounts; public
-- booking. Platform admins keep the ability to create tenants (demo / support).
--
-- COMPATIBILITY
-- Safe to apply BEFORE the application release: the deployed onboarding page
-- would simply receive 'tenant_provisioning_not_approved' from create_tenant
-- and show its generic failure message. The new application fails closed
-- (treats a missing status RPC as "not approved").
--
-- ROLLBACK (operator script, unexecuted): restore the 20260921113325 body of
-- private.create_tenant_with_owner, then drop the four RPC pairs and the table.

-- ---------------------------------------------------------------------
-- 1. Approvals table
-- ---------------------------------------------------------------------

create table public.tenant_provisioning_approvals (
  id uuid primary key default gen_random_uuid(),
  -- lower(trim(email)) — the same normalization every other e-mail match uses.
  email_normalized text not null,
  status text not null default 'approved',
  -- Internal label for the operator ("Founding Salon #3"); never shown to the invitee.
  note text,
  -- NULL = approved outside the application (operator SQL). Foreign keys use
  -- ON DELETE SET NULL so removing a user or a tenant never blocks on, or
  -- erases, the approval history.
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_by uuid references auth.users (id) on delete set null,
  consumed_tenant_id uuid references public.tenants (id) on delete set null,
  consumed_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_provisioning_approvals_status_check
    check (status in ('approved', 'consumed', 'revoked')),
  constraint tenant_provisioning_approvals_email_shape
    check (
      email_normalized = lower(btrim(email_normalized))
      and char_length(email_normalized) between 3 and 254
      and email_normalized !~ '[[:space:]]'
      and position('@' in email_normalized) > 1
      and position('@' in email_normalized) < char_length(email_normalized)
    ),
  constraint tenant_provisioning_approvals_note_length
    check (note is null or char_length(note) <= 500),
  constraint tenant_provisioning_approvals_consumed_shape
    check ((status = 'consumed') = (consumed_at is not null)),
  constraint tenant_provisioning_approvals_revoked_shape
    check ((status = 'revoked') = (revoked_at is not null)),
  constraint tenant_provisioning_approvals_expiry_after_approval
    check (expires_at > approved_at)
);

comment on table public.tenant_provisioning_approvals is
  'Faz LAUNCH.1A. An e-mail address approved to create ONE salon (owner-approval only phase). Status approved -> consumed (by create_tenant_with_owner) or revoked; an approved row past expires_at no longer counts. No API role has any privilege on this table; access is through the platform_* RPCs only.';

-- At most one OPEN approval per e-mail address. Consumed and revoked rows are
-- history and may repeat.
create unique index tenant_provisioning_approvals_one_open_per_email
  on public.tenant_provisioning_approvals (email_normalized)
  where status = 'approved';

create trigger set_updated_at
  before update on public.tenant_provisioning_approvals
  for each row execute function public.set_updated_at();

alter table public.tenant_provisioning_approvals enable row level security;

revoke all on public.tenant_provisioning_approvals from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. The caller's own confirmed e-mail address (normalized), or NULL
-- ---------------------------------------------------------------------

create or replace function private.caller_confirmed_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.normalize_email(u.email)
  from auth.users u
  where u.id = auth.uid()
    and u.email_confirmed_at is not null;
$$;

comment on function private.caller_confirmed_email() is
  'Faz LAUNCH.1A. The signed-in caller''s normalized e-mail, only when that address is CONFIRMED; NULL otherwise (including no session). Used so an approval can never be claimed through an address the caller has not proven they control.';

revoke execute on function private.caller_confirmed_email() from public;

-- ---------------------------------------------------------------------
-- 3. create_tenant_with_owner — the live PROD definition plus the gate
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.create_tenant_with_owner(p_name text, p_slug text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_owner_role_id uuid;
  v_email text;
  v_approval_id uuid;
  -- Mirrors lib/tenancy/reserved-slugs.ts RESERVED_SLUGS — the TS list is
  -- authoritative for onboarding UX/messaging, this is the non-bypassable
  -- backstop. Keep both in sync if either changes.
  v_reserved_slugs text[] := array[
    'app', 'book', 'super-admin', 'api', 'admin', 'auth', 'login', 'logout',
    'signup', 'sign-up', 'sign-in', 'register', 'onboarding', 'dashboard',
    'settings', 'billing', 'docs', 'help', 'support', 'status', 'pricing',
    'about', 'contact', 'legal', 'privacy', 'terms', 'www', 'mail', 'ftp',
    'static', 'public', 'assets', 'favicon.ico', 'robots.txt',
    'sitemap.xml', 'manifest.json', '_next', '_vercel',
    'tr', 'en', 'ru', 'de', 'fr', 'es', 'ar'
  ];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Faz LAUNCH.1A — owner-approval gate. A platform admin may always create a
  -- tenant (demo / support). Anyone else needs a live approval for their own
  -- CONFIRMED e-mail address; it is locked here and consumed below, in this
  -- same transaction, so two concurrent calls cannot both use it and a failed
  -- call (bad slug, duplicate slug) leaves it untouched. This runs BEFORE any
  -- argument validation on purpose: an unapproved caller must not be able to
  -- probe which slugs exist.
  if not private.is_platform_admin() then
    v_email := private.caller_confirmed_email();
    if v_email is not null then
      select a.id into v_approval_id
      from public.tenant_provisioning_approvals a
      where a.email_normalized = v_email
        and a.status = 'approved'
        and a.expires_at > now()
      for update;
    end if;
    if v_approval_id is null then
      raise exception 'tenant_provisioning_not_approved';
    end if;
  end if;

  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'name is required';
  end if;

  if p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_slug) not between 3 and 63 then
    raise exception 'invalid slug format';
  end if;

  if p_slug = any (v_reserved_slugs) then
    raise exception 'slug "%" is reserved', p_slug;
  end if;

  insert into public.tenants (name, slug, created_by)
  values (trim(p_name), p_slug, auth.uid())
  returning id into v_tenant_id;

  -- Faz 2I.2C: every tenant needs at least one branch for staff/service
  -- eligibility and appointments to function at all (see migration
  -- header). Same transaction as the tenant itself, so this is atomic —
  -- a tenant row can never exist without its default branch.
  insert into public.branches (tenant_id, name, is_primary)
  values (v_tenant_id, 'Merkez Şube', true);

  -- Faz SAAS.1E.1: every tenant is born with the four primary default roles
  -- (Salon Sahibi, Yönetici, Resepsiyon, Personel), provisioned by role KEY
  -- from the role templates — same transaction as the tenant, so a tenant
  -- can never exist without them. The creator receives SALON_OWNER.
  perform private.provision_default_roles(v_tenant_id);

  select r.id into v_owner_role_id
  from public.roles r
  where r.tenant_id = v_tenant_id and r.key = 'SALON_OWNER' and r.deleted_at is null;

  if v_owner_role_id is null then
    raise exception 'SALON_OWNER role could not be provisioned — seed data problem, not a user error';
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, role_id, status)
  values (v_tenant_id, auth.uid(), v_owner_role_id, 'active');

  perform private.log_audit_event(
    v_tenant_id,
    'tenant.created',
    'tenant',
    v_tenant_id,
    null,
    jsonb_build_object('name', p_name, 'slug', p_slug)
  );

  -- Faz LAUNCH.1A: consume the approval that allowed this creation (platform
  -- admins have none). Platform-level audit row; the tenant's own history is
  -- the tenant.created event above.
  if v_approval_id is not null then
    update public.tenant_provisioning_approvals
    set status = 'consumed',
        consumed_by = auth.uid(),
        consumed_tenant_id = v_tenant_id,
        consumed_at = now()
    where id = v_approval_id;

    perform private.log_audit_event(
      null,
      'tenant_provisioning.approval_consumed',
      'tenant_provisioning_approval',
      v_approval_id,
      jsonb_build_object('status', 'approved'),
      jsonb_build_object('status', 'consumed', 'tenant_id', v_tenant_id)
    );
  end if;

  return v_tenant_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 4. Platform-owner RPCs (private implementation, public wrapper)
-- ---------------------------------------------------------------------

-- Approve an e-mail address to create one salon. Idempotent: an already-open,
-- unexpired approval is returned unchanged (no write, no audit row); an
-- expired-but-still-"approved" row is renewed in place.
create or replace function private.platform_approve_tenant_owner(
  p_email text,
  p_note text,
  p_valid_days integer
)
returns table (
  id uuid,
  email text,
  status text,
  note text,
  approved_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_email text;
  v_note text;
  v_row public.tenant_provisioning_approvals%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.is_platform_owner() then
    raise exception 'platform_owner_required';
  end if;

  v_email := private.normalize_email(p_email);
  if v_email is null
     or char_length(v_email) > 254
     or v_email ~ '[[:space:]]'
     or position('@' in v_email) < 2
     or position('@' in v_email) >= char_length(v_email)
     or position('@' in substring(v_email from position('@' in v_email) + 1)) > 0 then
    raise exception 'invalid_email';
  end if;

  if p_valid_days is null or p_valid_days not between 1 and 90 then
    raise exception 'invalid_validity';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note_too_long';
  end if;

  select a.* into v_row
  from public.tenant_provisioning_approvals a
  where a.email_normalized = v_email and a.status = 'approved'
  for update;

  if found and v_row.expires_at > now() then
    -- Already approved and still valid: nothing to do, nothing to audit.
    return query select v_row.id, v_row.email_normalized, v_row.status, v_row.note, v_row.approved_at, v_row.expires_at;
    return;
  end if;

  if found then
    update public.tenant_provisioning_approvals a
    set approved_by = auth.uid(),
        approved_at = now(),
        expires_at = now() + make_interval(days => p_valid_days),
        note = v_note
    where a.id = v_row.id
    returning a.* into v_row;

    perform private.log_audit_event(
      null, 'tenant_provisioning.approval_renewed', 'tenant_provisioning_approval', v_row.id,
      null,
      jsonb_build_object('email', v_row.email_normalized, 'expires_at', v_row.expires_at)
    );
  else
    insert into public.tenant_provisioning_approvals (email_normalized, note, approved_by, expires_at)
    values (v_email, v_note, auth.uid(), now() + make_interval(days => p_valid_days))
    returning * into v_row;

    perform private.log_audit_event(
      null, 'tenant_provisioning.approved', 'tenant_provisioning_approval', v_row.id,
      null,
      jsonb_build_object('email', v_row.email_normalized, 'expires_at', v_row.expires_at)
    );
  end if;

  return query select v_row.id, v_row.email_normalized, v_row.status, v_row.note, v_row.approved_at, v_row.expires_at;
end;
$function$;

-- Revoke an open approval. Revoking an already-revoked row is a silent no-op;
-- a consumed approval cannot be revoked (the salon already exists).
create or replace function private.platform_revoke_tenant_owner_approval(p_approval_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.is_platform_owner() then
    raise exception 'platform_owner_required';
  end if;

  select a.status into v_status
  from public.tenant_provisioning_approvals a
  where a.id = p_approval_id
  for update;

  if v_status is null then
    raise exception 'approval_not_found';
  end if;

  if v_status = 'revoked' then
    return;
  end if;

  if v_status = 'consumed' then
    raise exception 'approval_already_consumed';
  end if;

  update public.tenant_provisioning_approvals
  set status = 'revoked', revoked_by = auth.uid(), revoked_at = now()
  where id = p_approval_id;

  perform private.log_audit_event(
    null, 'tenant_provisioning.approval_revoked', 'tenant_provisioning_approval', p_approval_id,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'revoked')
  );
end;
$function$;

create or replace function private.platform_list_tenant_owner_approvals()
returns table (
  id uuid,
  email text,
  note text,
  status text,
  effective_status text,
  approved_at timestamptz,
  expires_at timestamptz,
  consumed_at timestamptz,
  consumed_tenant_name text,
  revoked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.is_platform_owner() then
    raise exception 'platform_owner_required';
  end if;

  return query
  select
    a.id,
    a.email_normalized,
    a.note,
    a.status,
    case when a.status = 'approved' and a.expires_at <= now() then 'expired' else a.status end,
    a.approved_at,
    a.expires_at,
    a.consumed_at,
    t.name,
    a.revoked_at
  from public.tenant_provisioning_approvals a
  left join public.tenants t on t.id = a.consumed_tenant_id
  order by a.approved_at desc, a.id
  limit 200;
end;
$function$;

-- About the CALLER only: can this signed-in user create a salon right now?
-- No argument, so it can never be used to ask about someone else's address.
create or replace function private.get_my_tenant_provisioning_status()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_email text;
begin
  if auth.uid() is null then
    return false;
  end if;

  if private.is_platform_admin() then
    return true;
  end if;

  v_email := private.caller_confirmed_email();
  if v_email is null then
    return false;
  end if;

  return exists (
    select 1
    from public.tenant_provisioning_approvals a
    where a.email_normalized = v_email
      and a.status = 'approved'
      and a.expires_at > now()
  );
end;
$function$;

create or replace function public.platform_approve_tenant_owner(
  p_email text,
  p_note text default null,
  p_valid_days integer default 30
)
returns table (
  id uuid,
  email text,
  status text,
  note text,
  approved_at timestamptz,
  expires_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select * from private.platform_approve_tenant_owner(p_email, p_note, p_valid_days);
$$;

create or replace function public.platform_revoke_tenant_owner_approval(p_approval_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.platform_revoke_tenant_owner_approval(p_approval_id);
$$;

create or replace function public.platform_list_tenant_owner_approvals()
returns table (
  id uuid,
  email text,
  note text,
  status text,
  effective_status text,
  approved_at timestamptz,
  expires_at timestamptz,
  consumed_at timestamptz,
  consumed_tenant_name text,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.platform_list_tenant_owner_approvals();
$$;

create or replace function public.get_my_tenant_provisioning_status()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_my_tenant_provisioning_status();
$$;

comment on function public.platform_approve_tenant_owner(text, text, integer) is
  'Faz LAUNCH.1A. Platform owner only. Approves an e-mail address to create one salon (1-90 days, default 30). Idempotent while an unexpired approval is open.';
comment on function public.platform_revoke_tenant_owner_approval(uuid) is
  'Faz LAUNCH.1A. Platform owner only. Revokes an open approval; revoking twice is a no-op; a consumed approval cannot be revoked.';
comment on function public.platform_list_tenant_owner_approvals() is
  'Faz LAUNCH.1A. Platform owner only. The 200 most recent approvals with their effective status.';
comment on function public.get_my_tenant_provisioning_status() is
  'Faz LAUNCH.1A. Whether the CALLER may create a salon now (platform admin, or a live approval for their own confirmed e-mail). Takes no argument by design.';

revoke execute on function private.platform_approve_tenant_owner(text, text, integer) from public;
revoke execute on function private.platform_revoke_tenant_owner_approval(uuid) from public;
revoke execute on function private.platform_list_tenant_owner_approvals() from public;
revoke execute on function private.get_my_tenant_provisioning_status() from public;

revoke execute on function public.platform_approve_tenant_owner(text, text, integer) from public, anon;
revoke execute on function public.platform_revoke_tenant_owner_approval(uuid) from public, anon;
revoke execute on function public.platform_list_tenant_owner_approvals() from public, anon;
revoke execute on function public.get_my_tenant_provisioning_status() from public, anon;

grant execute on function public.platform_approve_tenant_owner(text, text, integer) to authenticated;
grant execute on function public.platform_revoke_tenant_owner_approval(uuid) to authenticated;
grant execute on function public.platform_list_tenant_owner_approvals() to authenticated;
grant execute on function public.get_my_tenant_provisioning_status() to authenticated;
