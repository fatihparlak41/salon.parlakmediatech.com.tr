-- Faz 2I.2F (Batch A) — owner-managed branch contact/social profile,
-- surfaced on the public booking page before the Gökhan İlhan Hair
-- Studio pilot goes live. Branch-level, not tenant-level: SalonOS
-- already supports multiple branches (20260815120004) and different
-- branches can have different phone numbers, WhatsApp numbers and
-- locations — a tenant-level field would be wrong the moment a second
-- branch exists. address/phone already exist on branches from Phase 1;
-- this adds only what's missing.
--
-- All three nullable/optional, same as address/phone themselves — no
-- format CHECK constraints here, matching that existing precedent:
-- format validation for this write path lives in the Zod schema
-- (lib/modules/branches/schemas.ts), exactly like customers.phone/email
-- (20260819052430) have none at the DB layer either. This is a
-- different situation from create_guest_booking's own inline phone/
-- email regex checks (20260822160000) — that function is reachable by
-- the booking_gateway role from unauthenticated traffic, so the DB is
-- the only trust boundary there. Here the only write path is an
-- authenticated Next.js Server Action that already validates with Zod
-- before ever reaching Postgres — a second enforcement layer at the DB
-- would be redundant, not defense in depth.
alter table public.branches
  add column whatsapp_phone text,
  add column instagram_handle text,
  add column location_url text;

comment on column public.branches.whatsapp_phone is
  'Digits + optional leading "+", normalized at write time in lib/modules/branches/normalize.ts using the same algorithm as private.normalize_phone (20260821120000). The public wa.me link is derived from this by stripping the leading "+" — never stored as a pre-built URL.';
comment on column public.branches.instagram_handle is
  'Handle only — no leading "@", not a URL. Normalized/validated at write time in lib/modules/branches/normalize.ts. The public instagram.com link is derived from this.';
comment on column public.branches.location_url is
  'A caller-supplied http(s) URL (typically a Google Maps share link), rendered as-is via a "Yol Tarifi" link. No lat/lng parsing, no host allowlist beyond the http(s) scheme check enforced in lib/modules/branches/normalize.ts.';

-- No grant changes. branches already has
-- `grant select, insert, update on public.branches to authenticated`
-- (20260815120004, confirmed still exactly that in
-- 20260816090006_revoke_anon_and_tighten_grants.sql) — an unqualified
-- table-level GRANT covers every column, including ones added later by
-- ALTER TABLE ADD COLUMN, so these 3 new columns are already covered.
-- Writes are gated by the existing branches_update_settings_manage RLS
-- policy (20260816090004): `using/with check
-- (private.has_permission(tenant_id, 'settings.manage') or
-- private.is_platform_admin())` — tenant-isolated by construction,
-- since `tenant_id` there is the ROW's own column, checked per row. This
-- is the identical shape to tenants_update_settings_manage, which
-- updateSelfServicePolicyAction (lib/modules/settings/actions.ts)
-- already relies on via a direct authenticated UPDATE — no SECURITY
-- DEFINER RPC is needed here for the same reason none was needed there:
-- the direct-UPDATE path does not violate the current security model,
-- so adding one would be an unnecessary new privileged codepath, not a
-- safer one. No new permission either — settings.manage already governs
-- this exact policy.
--
-- tests/security-grants-regression.test.ts's
-- AUTHENTICATED_TABLE_WHITELIST already lists branches as
-- ["INSERT", "SELECT", "UPDATE"] at the table level (not per-column) —
-- that test needs no update for this migration, and its unchanged pass
-- is itself proof no grant widened.

-- get_public_booking_context (20260822150500) is CREATE OR REPLACE on a
-- pre-existing function — Postgres preserves its prior grants
-- (anon, authenticated; already revoked from PUBLIC in
-- 20260822151000) across a body-only replace, so no grant statements
-- are repeated here, matching the established convention for every
-- other private.*/public.* function touched by CREATE OR REPLACE
-- elsewhere in this codebase (e.g. every phase that only changed a
-- function body). Same argument list as before (p_tenant_slug text) —
-- no signature change, so the anon-function-allowlist signature test in
-- tests/public-booking-flow.test.ts also needs no update.
--
-- Adds phone + the 3 new fields to each branch's public jsonb object.
-- jsonb_build_object emits a real JSON null for a null column exactly
-- like address already does today — this is what lets the client hide
-- an action button when a field was never configured, per the "blank/
-- null public fields hide actions" requirement. Deliberately still no
-- price/duration/capacity anywhere in this object — unchanged from
-- before.
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
              'durationMinutes', s.duration_minutes, 'price', s.price
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
