-- Faz 2G.3.2 — Salon-Assisted Account Linking + Safe Correction.
--
-- Legacy/ambiguous CRM rows can never be self-claimed (2G.3.0's decision)
-- and get no verified-claim path (that's future bookings only, 2G.3.1).
-- This migration adds the deliberately-narrower alternative: a customer,
-- already authenticated in /account, generates a short-lived, tenant-
-- bound pairing code and hands it directly to salon staff, who redeem it
-- against ONE specific CRM row they already have legitimate access to.
--
-- Dual authorization, neither side sufficient alone: the CUSTOMER side
-- proves voluntary generation of the pairing capability (auth.uid()-only,
-- no browser-supplied identity); the SALON side proves an authorized
-- staff member selected the exact tenant CRM row (customers.link_account,
-- checked in the tenant the row actually belongs to). No global
-- auth.users/profiles search exists anywhere in this surface — the code
-- is what identifies the account, never an email lookup.
--
-- Corrections applied from the architecture review before implementing:
-- codes are tenant-bound (not global), the uniqueness invariant is
-- user+tenant (not just user), no failed_attempt_count in this first
-- cut (entropy + short expiry + tenant binding + permission gate are the
-- defenses), and a narrow, salon_assisted-only unlink ships now rather
-- than being deferred.

-- =====================================================================
-- New permission, distinct from customers.update: editing a phone field
-- is not the same capability as granting a real authenticated identity
-- visibility into (and potential cancel/reschedule authority over) a
-- CRM row's whole appointment history. Conservative default: Owner and
-- Manager only, not Receptionist even though Receptionist already holds
-- customers.update — any tenant can grant it to their own Receptionist
-- role afterward through the existing role-editing UI, so this is a
-- default, not a ceiling.
-- =====================================================================
insert into public.permissions (key, name, category, description) values
  ('customers.link_account', 'Müşteri kaydını SalonOS hesabına bağla', 'customers',
   'Bir CRM kaydını doğrulanmış bir müşteri hesabına bağlama veya salon tarafından oluşturulmuş bir bağlantıyı kaldırma yetkisi. customers.update''den ayrıdır: hesap geçmişi görünürlüğü ve olası iptal/değişiklik yetkisi verir.')
on conflict (key) do update set
  name = excluded.name, category = excluded.category, description = excluded.description;

insert into public.role_template_permissions (role_template_id, permission_id)
select rt.id, p.id
from public.role_templates rt
cross join public.permissions p
where p.key = 'customers.link_account'
  and rt.key in ('SALON_OWNER', 'SALON_MANAGER')
on conflict do nothing;

-- Backfill already-onboarded tenants' cloned Owner/Manager roles too —
-- role_template_permissions is only the starting point for NEW tenants
-- (tenant-owned roles are independent after cloning, see
-- 20260815120007's own comment); without this, every existing DEV
-- tenant's owner would be unable to use a feature their role template
-- says they should have. Idempotent, safe to re-run.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.role_templates rt on rt.id = r.cloned_from_template_id
cross join public.permissions p
where rt.key in ('SALON_OWNER', 'SALON_MANAGER')
  and p.key = 'customers.link_account'
  and r.deleted_at is null
on conflict do nothing;

-- =====================================================================
-- customer_account_pairing_codes — ephemeral, tenant-bound. Hash-only,
-- no PII, no raw code ever persisted. Zero direct grants — reachable
-- only through create_my_link_code (issuance) and
-- link_customer_account_with_code (redemption).
-- =====================================================================
create table public.customer_account_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id),
  code_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_by_customer_id uuid,
  created_at timestamptz not null default now(),
  constraint customer_account_pairing_codes_customer_tenant_fkey
    foreign key (consumed_by_customer_id, tenant_id) references public.customers (id, tenant_id)
);

comment on table public.customer_account_pairing_codes is
  'Faz 2G.3.2 — a customer-generated, tenant-bound capability handed directly to salon staff in person. revoked_at (superseded by a newer code) is deliberately separate from consumed_at (successfully redeemed by a salon) so later investigation never has to guess which one happened. Zero direct grants to any role.';

create index customer_account_pairing_codes_user_tenant_idx
  on public.customer_account_pairing_codes (user_id, tenant_id);

-- At most one unconsumed/unrevoked code per (user, tenant) — NOT a
-- time-dependent predicate: expires_at is checked only at validation
-- time, never inside this index (a volatile now()-based partial index
-- would not be a valid/stable index condition). This means an expired-
-- but-not-yet-revoked row still occupies the slot until generation
-- explicitly revokes it — intentional: create_my_link_code always
-- revokes any prior row matching this same condition before inserting
-- the replacement, regardless of whether that prior row happens to
-- already be expired.
create unique index customer_account_pairing_codes_active_idx
  on public.customer_account_pairing_codes (user_id, tenant_id)
  where consumed_at is null and revoked_at is null;

alter table public.customer_account_pairing_codes enable row level security;
-- Zero policies — deny-all by construction, same reasoning as
-- booking_account_claims (Faz 2G.3.1): a code_hash must never be
-- directly queryable by any client role, only through the two narrow
-- RPCs below.

-- =====================================================================
-- get_my_link_salon_context — read-only tenant-display-name resolution
-- for the customer-side /account/link-salon/[tenantSlug] page.
-- Deliberately NOT resolve_bookable_tenant/get_public_booking_context:
-- this feature has nothing to do with online_booking and must not be
-- gated by that unrelated flag. Authenticated only — by the time this
-- is called the caller has already passed the guarded route's own auth
-- check, so there's no reason to also grant anon.
-- =====================================================================
create function private.get_my_link_salon_context(p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  select t.name into v_tenant
  from public.tenants t
  where t.slug = p_tenant_slug and t.deleted_at is null and t.status in ('trial', 'active');

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object('found', true, 'tenantName', v_tenant.name);
end;
$$;

revoke execute on function private.get_my_link_salon_context(text) from public;

create function public.get_my_link_salon_context(p_tenant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_my_link_salon_context(p_tenant_slug);
$$;

revoke execute on function public.get_my_link_salon_context(text) from public;
revoke execute on function public.get_my_link_salon_context(text) from anon;
grant execute on function public.get_my_link_salon_context(text) to authenticated;

-- =====================================================================
-- create_my_link_code — identity from auth.uid() only. Receives a HASH
-- only (the raw code is generated + hashed in Node, mirroring
-- gateway.ts's own claim-secret precedent, and never round-trips
-- through Postgres in raw form). Revokes any prior unconsumed/unrevoked
-- code for this exact (user, tenant) under an advisory lock, so two
-- simultaneous first-time generations for the same (user, tenant) can't
-- both leave an active row — then inserts the replacement. A pending
-- code for a DIFFERENT tenant is untouched by construction (the
-- UPDATE's own WHERE clause is tenant-scoped).
-- =====================================================================
create function private.create_my_link_code(p_tenant_slug text, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  select t.id into v_tenant_id
  from public.tenants t
  where t.slug = p_tenant_slug and t.deleted_at is null and t.status in ('trial', 'active');

  if not found then
    raise exception 'invalid tenant' using errcode = 'AC011';
  end if;

  if p_code_hash is null or btrim(p_code_hash) = '' then
    raise exception 'invalid code' using errcode = 'AC011';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('customer_link_code'),
    hashtext(v_tenant_id::text || '|' || auth.uid()::text)
  );

  update public.customer_account_pairing_codes
  set revoked_at = now()
  where user_id = auth.uid() and tenant_id = v_tenant_id
    and consumed_at is null and revoked_at is null;

  v_expires_at := now() + interval '15 minutes';

  insert into public.customer_account_pairing_codes (user_id, tenant_id, code_hash, expires_at)
  values (auth.uid(), v_tenant_id, p_code_hash, v_expires_at);

  return jsonb_build_object('expiresAt', v_expires_at);
end;
$$;

revoke execute on function private.create_my_link_code(text, text) from public;

create function public.create_my_link_code(p_tenant_slug text, p_code_hash text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.create_my_link_code(p_tenant_slug, p_code_hash);
$$;

revoke execute on function public.create_my_link_code(text, text) from public;
revoke execute on function public.create_my_link_code(text, text) from anon;
grant execute on function public.create_my_link_code(text, text) to authenticated;

-- =====================================================================
-- link_customer_account_with_code — the staff-side redemption boundary.
-- Never accepts user_id/account email/tenant id — tenant is derived
-- from p_customer_id's own row, exactly like every other staff RPC in
-- this project; the code resolves the account internally. Every
-- rejection reason from the code itself (wrong tenant, expired, wrong
-- hash, revoked, already consumed) collapses to the identical LK003 —
-- no distinguishing signal. Permission failure is deliberately its own
-- distinct code (LK002): the caller here is an authenticated, tenant-
-- scoped, fully-audited staff identity, not an anonymous prober, so a
-- clear "you don't have permission" is a normal, expected message, not
-- an enumeration leak.
-- =====================================================================
create function private.link_customer_account_with_code(p_customer_id uuid, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer record;
  v_code record;
  v_already_same_user boolean;
  v_should_be_primary boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'LK001';
  end if;

  select c.id, c.tenant_id into v_customer
  from public.customers c
  where c.id = p_customer_id and c.deleted_at is null;

  if not found then
    raise exception 'invalid customer' using errcode = 'LK003';
  end if;

  if not private.has_permission(v_customer.tenant_id, 'customers.link_account') then
    raise exception 'permission denied' using errcode = 'LK002';
  end if;

  if p_code_hash is null or btrim(p_code_hash) = '' then
    raise exception 'code not valid' using errcode = 'LK003';
  end if;

  select id, user_id, tenant_id, consumed_at, revoked_at, expires_at
  into v_code
  from public.customer_account_pairing_codes
  where code_hash = p_code_hash
  for update;

  if not found
     or v_code.tenant_id <> v_customer.tenant_id
     or v_code.consumed_at is not null
     or v_code.revoked_at is not null
     or v_code.expires_at < now()
  then
    raise exception 'code not valid' using errcode = 'LK003';
  end if;

  -- Already linked to a DIFFERENT account: never transfer, never
  -- disclose. Permanently consume this code too (2G.3.1A precedent) so
  -- a doomed retry can't sit live for its remaining lifetime. Message
  -- text deliberately identical to every other LK003 raise in this
  -- function — the code alone isn't the enumeration boundary, the
  -- message text is too, so "already linked" would itself be a
  -- distinguishable signal from "code not valid" even sharing LK003.
  if exists (
    select 1 from public.customer_account_links
    where tenant_id = v_customer.tenant_id and customer_id = v_customer.id
      and deleted_at is null and user_id <> v_code.user_id
  ) then
    update public.customer_account_pairing_codes
    set consumed_at = now(), consumed_by_customer_id = v_customer.id
    where id = v_code.id;
    raise exception 'code not valid' using errcode = 'LK003';
  end if;

  select exists (
    select 1 from public.customer_account_links
    where tenant_id = v_customer.tenant_id and customer_id = v_customer.id
      and deleted_at is null and user_id = v_code.user_id
  ) into v_already_same_user;

  if v_already_same_user then
    update public.customer_account_pairing_codes
    set consumed_at = now(), consumed_by_customer_id = v_customer.id
    where id = v_code.id;
    return jsonb_build_object('success', true);
  end if;

  -- Same tenant+user advisory lock every other linking path already
  -- uses (2G.1/2G.3.1/2G.3.1A) — serializes the primary/non-primary
  -- decision against any other concurrent link creation for this exact
  -- (tenant, user).
  perform pg_advisory_xact_lock(
    hashtext('customer_account_link'),
    hashtext(v_customer.tenant_id::text || '|' || v_code.user_id::text)
  );

  select not exists (
    select 1 from public.customer_account_links
    where tenant_id = v_customer.tenant_id and user_id = v_code.user_id
      and deleted_at is null and is_primary = true
  ) into v_should_be_primary;

  begin
    insert into public.customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
    values (v_code.user_id, v_customer.tenant_id, v_customer.id, 'salon_assisted', v_should_be_primary);
  exception
    when unique_violation then
      -- Mechanism-agnostic backstop: the SAME unique index that
      -- protects every other linking path (claim_my_recent_booking,
      -- create_guest_booking's future_booking path) also protects this
      -- one — a concurrent link via a DIFFERENT mechanism for this
      -- exact customer_id lands here instead of a duplicate row.
      update public.customer_account_pairing_codes
      set consumed_at = now(), consumed_by_customer_id = v_customer.id
      where id = v_code.id;
      raise exception 'code not valid' using errcode = 'LK003';
  end;

  update public.customer_account_pairing_codes
  set consumed_at = now(), consumed_by_customer_id = v_customer.id
  where id = v_code.id;

  perform private.log_audit_event(
    v_customer.tenant_id, 'customer_account_link.claimed', 'customer', v_customer.id,
    null, jsonb_build_object('claimedVia', 'salon_assisted')
  );

  return jsonb_build_object('success', true);
end;
$$;

revoke execute on function private.link_customer_account_with_code(uuid, text) from public;

create function public.link_customer_account_with_code(p_customer_id uuid, p_code_hash text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.link_customer_account_with_code(p_customer_id, p_code_hash);
$$;

revoke execute on function public.link_customer_account_with_code(uuid, text) from public;
revoke execute on function public.link_customer_account_with_code(uuid, text) from anon;
grant execute on function public.link_customer_account_with_code(uuid, text) to authenticated;

-- =====================================================================
-- unlink_salon_assisted_customer_account — the narrow correction path.
-- Gated on the SAME permission that creates a link (not "did I
-- personally create this one" — customer_account_links has no actor
-- column, and requiring the original linker specifically would be
-- operationally brittle). Structurally restricted to claimed_via =
-- 'salon_assisted' only: future_booking/verified_booking_claim links
-- carry stronger, customer-owned identity evidence and must never be
-- staff-reversible here, full stop.
-- =====================================================================
create function private.unlink_salon_assisted_customer_account(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer record;
  v_link record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'LK001';
  end if;

  select c.id, c.tenant_id into v_customer
  from public.customers c
  where c.id = p_customer_id and c.deleted_at is null;

  if not found then
    raise exception 'invalid customer' using errcode = 'LK004';
  end if;

  if not private.has_permission(v_customer.tenant_id, 'customers.link_account') then
    raise exception 'permission denied' using errcode = 'LK002';
  end if;

  select id, claimed_via into v_link
  from public.customer_account_links
  where tenant_id = v_customer.tenant_id and customer_id = v_customer.id and deleted_at is null
  for update;

  -- No primary is automatically promoted for this account/tenant after
  -- this soft-delete (2G.3.2 correction) — leaving zero-primary
  -- temporarily is preferable to giving an unrelated historical row
  -- routing significance just because a different link was corrected.
  -- A later authenticated future booking (2G.1) can establish a fresh
  -- primary the normal way; nothing here needs to reach for one.
  if not found or v_link.claimed_via <> 'salon_assisted' then
    raise exception 'not eligible for unlink' using errcode = 'LK004';
  end if;

  update public.customer_account_links
  set deleted_at = now()
  where id = v_link.id;

  perform private.log_audit_event(
    v_customer.tenant_id, 'customer_account_link.unlinked', 'customer', v_customer.id,
    jsonb_build_object('claimedVia', 'salon_assisted', 'active', true),
    jsonb_build_object('active', false)
  );

  return jsonb_build_object('success', true);
end;
$$;

revoke execute on function private.unlink_salon_assisted_customer_account(uuid) from public;

create function public.unlink_salon_assisted_customer_account(p_customer_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.unlink_salon_assisted_customer_account(p_customer_id);
$$;

revoke execute on function public.unlink_salon_assisted_customer_account(uuid) from public;
revoke execute on function public.unlink_salon_assisted_customer_account(uuid) from anon;
grant execute on function public.unlink_salon_assisted_customer_account(uuid) to authenticated;

-- =====================================================================
-- get_customer_account_link_status — read-only, minimal-disclosure
-- status for the staff CRM UI. Gated on customers.view (the same
-- permission that already lets staff see the record at all), NOT
-- customers.link_account — showing "this row is linked" is a natural
-- extension of viewing the customer, distinct from the mutations
-- themselves. Never returns user_id, email, or any other identity
-- field of the linked account — only enough for the UI to decide which
-- button to show.
-- =====================================================================
create function private.get_customer_account_link_status(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customer record;
  v_link record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'LK001';
  end if;

  select c.id, c.tenant_id into v_customer
  from public.customers c
  where c.id = p_customer_id and c.deleted_at is null;

  if not found then
    raise exception 'invalid customer' using errcode = 'LK004';
  end if;

  if not private.has_permission(v_customer.tenant_id, 'customers.view') then
    raise exception 'permission denied' using errcode = 'LK002';
  end if;

  select claimed_via, is_primary into v_link
  from public.customer_account_links
  where tenant_id = v_customer.tenant_id and customer_id = v_customer.id and deleted_at is null;

  if not found then
    return jsonb_build_object('isLinked', false);
  end if;

  return jsonb_build_object(
    'isLinked', true,
    'claimedVia', v_link.claimed_via,
    'isPrimary', v_link.is_primary,
    'canUnlink', v_link.claimed_via = 'salon_assisted'
  );
end;
$$;

revoke execute on function private.get_customer_account_link_status(uuid) from public;

create function public.get_customer_account_link_status(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_customer_account_link_status(p_customer_id);
$$;

revoke execute on function public.get_customer_account_link_status(uuid) from public;
revoke execute on function public.get_customer_account_link_status(uuid) from anon;
grant execute on function public.get_customer_account_link_status(uuid) to authenticated;
