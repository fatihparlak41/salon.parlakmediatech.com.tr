-- Faz NOTIF.2D — one new, narrowly-scoped RPC so the manual "send a test
-- push to my own device" Server Action can read the raw subscription
-- material (endpoint/p256dh/auth_key) it needs server-side, without
-- widening push_subscriptions' access at all.
--
-- =====================================================================
-- WHY A NEW RPC, NOT list_my_devices OR A service_role READ
-- =====================================================================
-- list_my_devices (Faz NOTIF.2A, 20260908090000) deliberately never
-- selects endpoint/p256dh/auth_key — "these have no reason to ever reach
-- browser JS once a subscription exists" — and that invariant must not
-- be weakened just because the manual test-send flow also happens to
-- need those columns; it needs them SERVER-SIDE only, never returned to
-- the browser. push_subscriptions itself has zero grants to
-- authenticated/anon and RLS enabled with zero policies (20260908090000)
-- — the only way to read it at all is a SECURITY DEFINER function, same
-- as every other access path to this table. Reusing service_role here
-- was considered and rejected: grepping this codebase shows
-- lib/supabase/admin.ts (the service_role client) used in exactly one
-- place, for an unrelated narrow purpose (public-booking Turnstile
-- verification) — service_role is not this project's pattern for "a
-- server action needs a privileged read", a new tightly-scoped RPC is.
--
-- =====================================================================
-- SCOPE
-- =====================================================================
-- Gated on BOTH an active tenant membership for p_tenant_id AND
-- settings.manage — matching set_online_booking_enabled's own gate
-- (20260903120000) exactly, since the settings page that will call this
-- already requires settings.manage to even render the notification
-- card, and this reads more sensitive material than a simple toggle.
-- Returns only the CALLER's own active (not revoked) rows for their own
-- membership in p_tenant_id — never another tenant's, never another
-- user's, never a revoked row. The name itself says what this is for —
-- deliberately not a generic "get my push subscriptions" the way
-- list_my_devices reads; a future caller reaching for subscription
-- material should have to notice this name and ask whether they really
-- need raw keys server-side, or whether list_my_devices' redacted shape
-- already covers it.

create function private.get_my_push_subscriptions_for_test_send(p_tenant_id uuid)
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
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'NF001';
  end if;

  if not private.has_permission(p_tenant_id, 'settings.manage') then
    raise exception 'settings.manage required';
  end if;

  select id into v_membership_id
  from public.tenant_memberships
  where tenant_id = p_tenant_id
    and user_id = auth.uid()
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

comment on function private.get_my_push_subscriptions_for_test_send(uuid) is
  'Faz NOTIF.2D. Server-only material read for the manual test-send Server Action — returns endpoint/p256dh/authKey for the caller''s own active, non-revoked push_subscriptions row(s) in p_tenant_id. Gated on active membership AND settings.manage (matches set_online_booking_enabled''s gate, 20260903120000). Never call this to satisfy a browser-facing read — that is what the redacted list_my_devices is for.';

revoke execute on function private.get_my_push_subscriptions_for_test_send(uuid) from public;

create function public.get_my_push_subscriptions_for_test_send(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_my_push_subscriptions_for_test_send(p_tenant_id);
$$;

revoke execute on function public.get_my_push_subscriptions_for_test_send(uuid) from public;
revoke execute on function public.get_my_push_subscriptions_for_test_send(uuid) from anon;
grant execute on function public.get_my_push_subscriptions_for_test_send(uuid) to authenticated;
