-- Faz NOTIF.2D.1 — security correction for 20260914120000 (left
-- unedited, forward-only fix here instead, per this phase's own rule).
--
-- =====================================================================
-- THE PROBLEM, CONFIRMED, NOT ASSUMED
-- =====================================================================
-- 20260914120000 granted `authenticated` EXECUTE on a function that
-- returns raw endpoint/p256dh/auth_key directly. The Server Action built
-- on top of it never surfaced that material to the UI, but that was
-- never the actual security boundary: ANY signed-in settings-manager
-- could open devtools and call
-- `supabase.rpc('get_my_push_subscriptions_for_test_send', {p_tenant_id})`
-- directly from browser JS and get back another device's subscription
-- secrets. "Scoped to my own membership + settings.manage" narrows WHO
-- can call it, but never answers WHETHER a browser should be able to
-- call it at all for this data. Push subscription delivery material
-- must be server-only, full stop — this migration removes the
-- browser-reachable path entirely and replaces it with one callable
-- only by service_role.
--
-- =====================================================================
-- WHY service_role, FRESHLY CONFIRMED (not copied from the phase
-- instructions blindly)
-- =====================================================================
-- Grepped the whole app for `from ["']@/lib/supabase/admin["']` and
-- `createAdminClient` before writing this: zero application-runtime
-- callers exist today. service_role's only current use is
-- tests/helpers.ts's fixture setup/teardown, and 20260817104813's own
-- header says so explicitly — "createAdminClient() has zero callers in
-- application code today... If a real runtime need for
-- createAdminClient() appears later (a webhook, a background job),
-- extend this list explicitly for that need — do not widen it back to
-- 'service_role is admin, grant everything'." This migration IS that
-- "later": the first real application-runtime use of service_role,
-- added as one narrow, explicitly-whitelisted function — the same
-- least-privilege spirit as that migration's own Part D, not a
-- broadening of it. lib/modules/public-booking/turnstile.ts (previously
-- misreported as an admin-client caller) uses plain fetch() to
-- Cloudflare's API and has nothing to do with Supabase at all —
-- corrected here after a fresh re-check.
--
-- =====================================================================
-- WHY p_user_id IS AN EXPLICIT PARAMETER, NEVER auth.uid()
-- =====================================================================
-- service_role has no signed-in session, so auth.uid() reads as null
-- under it — confirmed directly against private.has_permission's own
-- body (`tm.user_id = auth.uid()`), which is exactly why settings.manage
-- cannot be re-checked inside the new function below: has_permission
-- would silently and always return false under service_role, which
-- would look like "working" (fails closed) but for the wrong reason,
-- and would mask a real bug if this function were ever reached without
-- the caller having actually checked. Authorization is therefore done
-- ONCE, in the caller's own normal user-session context (requireUser +
-- hasPermission, both using the RLS-respecting client — see
-- lib/modules/settings/actions.ts), strictly BEFORE switching to the
-- service-role client. The browser is never asked for, and never
-- trusted with, a user_id — the Server Action resolves it itself from
-- the authenticated session.
--
-- =====================================================================
-- WHAT THE NEW FUNCTION DOES AND DOES NOT RE-CHECK
-- =====================================================================
-- It re-verifies the STRUCTURAL fact that (p_tenant_id, p_user_id)
-- resolves to an active, non-deleted membership — the same lookup every
-- other push_subscriptions RPC performs, just against an explicit
-- p_user_id instead of auth.uid(). This is defense-in-depth against a
-- caller bug, not a substitute for the permission check, which it
-- cannot perform (see above). It never re-derives or re-checks
-- settings.manage.

drop function if exists public.get_my_push_subscriptions_for_test_send(uuid);
drop function if exists private.get_my_push_subscriptions_for_test_send(uuid);

create function private.get_push_subscriptions_for_test_send(p_tenant_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_result jsonb;
begin
  if p_tenant_id is null or p_user_id is null then
    raise exception 'tenant_id and user_id are required' using errcode = 'NF002';
  end if;

  select id into v_membership_id
  from public.tenant_memberships
  where tenant_id = p_tenant_id
    and user_id = p_user_id
    and status = 'active'
    and deleted_at is null;

  if v_membership_id is null then
    raise exception 'active tenant membership required' using errcode = 'NF003';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ps.id,
    'endpoint', ps.endpoint,
    'p256dh', ps.p256dh,
    'authKey', ps.auth_key
  )), '[]'::jsonb)
  into v_result
  from public.push_subscriptions ps
  where ps.tenant_membership_id = v_membership_id
    and ps.revoked_at is null;

  return v_result;
end;
$$;

comment on function private.get_push_subscriptions_for_test_send(uuid, uuid) is
  'Faz NOTIF.2D.1. Server-only material read, reachable only through the public.* wrapper granted to service_role. Takes p_user_id explicitly — never auth.uid(), which is null under service_role. The caller (lib/modules/settings/actions.ts''s sendTestPushNotificationAction) must already have verified settings.manage in its own normal user-session context before calling this; this function only re-verifies the structural fact of an active membership, never the permission itself, since it has no session context to check it against.';

revoke execute on function private.get_push_subscriptions_for_test_send(uuid, uuid) from public;

create function public.get_push_subscriptions_for_test_send(p_tenant_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_push_subscriptions_for_test_send(p_tenant_id, p_user_id);
$$;

-- Explicit revoke-then-grant, matching every other RPC batch in this
-- schema (e.g. 20260908090000's own closing block) even though
-- 20260817104813's default-privileges fix already means a brand-new
-- public.* function starts with none of these three grants — belt and
-- suspenders against a future default-privileges change silently
-- reopening this specific function.
revoke execute on function public.get_push_subscriptions_for_test_send(uuid, uuid) from public;
revoke execute on function public.get_push_subscriptions_for_test_send(uuid, uuid) from anon;
revoke execute on function public.get_push_subscriptions_for_test_send(uuid, uuid) from authenticated;
grant execute on function public.get_push_subscriptions_for_test_send(uuid, uuid) to service_role;
