-- Faz NOTIF.2A — database/security foundation for Notification V1's push
-- subscriptions and per-membership preferences. No delivery, no outbox,
-- no VAPID, no Service Worker — schema + narrow RPCs only, exactly the
-- same "private.* does the work, a thin public.* wrapper is the only
-- client-callable surface, both revoked from PUBLIC" shape already used
-- throughout this project (e.g. 20260819052733, 20260823201517).
--
-- =====================================================================
-- WHY public.*, NOT private.* TABLES — a correction to the NOTIF.1
-- audit's own pseudo-SQL, per this phase's explicit "do not blindly
-- copy it" instruction
-- =====================================================================
-- Freshly checked before writing this file: no table has ever been
-- created directly in the private schema anywhere in this project's
-- migration history (grepped `create table private\.` across every
-- migration — zero hits). private is used for functions (and one view)
-- only; every actual data table lives in public, and "authenticated
-- cannot touch this directly" is achieved the same way audit_logs
-- already achieves it (20260815120013) — RLS enabled, and here, unlike
-- audit_logs (which does grant SELECT, since viewing logs is the
-- point), NO grant of any kind to authenticated or anon on either table
-- below. Postgres requires both a grant AND a satisfied RLS policy to
-- read/write a row; omitting the grant entirely is a second, redundant
-- layer on top of RLS having no permissive policies at all — even a
-- future accidental policy addition still can't be reached without a
-- grant that this migration deliberately never issues. All access is
-- through the SECURITY DEFINER RPCs below, which bypass both (they run
-- as the function owner, same as every other RPC in this schema).
--
-- =====================================================================
-- WHY NO COMPOSITE TENANT-SAFE FK (unlike staff_members/
-- actual_staff_member_id) — the other deliberate deviation from the
-- NOTIF.1 sketch
-- =====================================================================
-- The composite (id, tenant_id) FK trick used for
-- staff_members.tenant_membership_id and
-- appointment_items.actual_staff_member_id exists specifically to keep
-- TWO independently-settable tenant-scoped columns on the same row from
-- disagreeing (a staff row has its own real tenant_id independent of
-- whichever membership it optionally links to). Neither table below has
-- a second, independently-set tenant-scoped column at all —
-- tenant_membership_id is the ONLY source of tenant context on either
-- row, so there is nothing for a second column to disagree with. A
-- plain single-column FK to tenant_memberships(id) is the minimum
-- correct model here, not an under-built one.
--
-- =====================================================================
-- WHY p_tenant_id, NEVER A CLIENT-SUPPLIED MEMBERSHIP ID — matches the
-- established has_permission(p_tenant_id, ...)/is_tenant_member(p_tenant_id)
-- idiom exactly (20260815120014)
-- =====================================================================
-- Every RPC below takes p_tenant_id (the tenant the browser is already
-- operating in, exactly like every other authenticated call site in
-- this app) and derives "the caller's own active membership for that
-- tenant" itself, from auth.uid(). The client is never asked for, and
-- never trusted with, a raw tenant_membership_id, a user_id, or any
-- other internal identifier — there is nothing to spoof because nothing
-- identity-bearing is ever accepted as input.
--
-- =====================================================================
-- ENDPOINT UNIQUENESS AND THE ACCOUNT-SWITCH RULE
-- =====================================================================
-- endpoint is globally unique on purpose, not per-membership: a single
-- browser has exactly one PushSubscription per origin/service-worker
-- registration, full stop — this isn't a design choice, it's how the
-- Web Push API itself works. One physical device can only ever be
-- "pointed at" one tenant-membership's notifications at a time. Given
-- that, save_push_subscription's ON CONFLICT (endpoint) DO UPDATE
-- reassigns an existing row's tenant_membership_id (plus its keys) to
-- whichever membership the CURRENT caller was just proven to own,
-- rather than erroring or creating a second row for the same physical
-- endpoint. That reassignment is the account-switch safety property
-- itself: the row now has exactly one tenant_membership_id, so the
-- previous owner cannot still be a recipient through it — there is
-- structurally no "leftover" state where two memberships both point at
-- the same endpoint.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_membership_id uuid not null references public.tenant_memberships (id),
  endpoint text not null check (char_length(endpoint) between 1 and 1024),
  -- Web Push subscription.keys.p256dh / .auth — base64url-encoded,
  -- bounded generously above their real-world sizes (~87 / ~22 chars)
  -- as a sanity/abuse check, same discipline as every other user-
  -- suppliable text column in this schema. Named auth_key, not auth:
  -- the bare word would sit uncomfortably close to the auth schema
  -- (auth.users, auth.uid()) in code that also lives under
  -- search_path='' — auth_key reads unambiguously in every context.
  p256dh text not null check (char_length(p256dh) between 1 and 256),
  auth_key text not null check (char_length(auth_key) between 1 and 256),
  device_label text check (device_label is null or char_length(device_label) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint push_subscriptions_endpoint_key unique (endpoint)
);

comment on table public.push_subscriptions is
  'Faz NOTIF.2A — one row per physical browser push endpoint, owned by exactly one tenant_membership_id at a time (endpoint is globally unique — see this migration''s own header for why reassignment-on-conflict, not per-membership uniqueness, is the correct model). No direct grant to authenticated/anon whatsoever — save/remove/list only via the SECURITY DEFINER RPCs below. Never exposes endpoint/p256dh/auth_key outside those RPCs; list_my_devices deliberately omits all three.';

-- Active (not revoked) subscriptions for a membership — the shape every
-- future delivery-worker read and list_my_devices call both need.
create index push_subscriptions_membership_idx
  on public.push_subscriptions (tenant_membership_id)
  where revoked_at is null;

create trigger set_updated_at
  before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

alter table public.push_subscriptions enable row level security;
-- No policy is added here, deliberately — RLS enabled with zero
-- policies denies every command to every role except the table owner,
-- and there is no grant below for authenticated/anon to even attempt
-- one. Both layers agree: browser access is impossible outside the
-- RPCs.

create table public.notification_preferences (
  tenant_membership_id uuid primary key references public.tenant_memberships (id),
  new_appointment boolean not null default true,
  cancellation boolean not null default true,
  reschedule boolean not null default true,
  assignment_change boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.notification_preferences is
  'Faz NOTIF.2A — one row per tenant_membership_id, lazily created on first update (see update_my_notification_preferences). A membership with no row here is read as all-true defaults by get_my_notification_preferences, never backfilled. No direct grant to authenticated/anon — get/update only via the SECURITY DEFINER RPCs below, which accept exactly these four named booleans and nothing else (no generic patch surface).';

create trigger set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

alter table public.notification_preferences enable row level security;
-- Same "no policy, no grant" double-lock as push_subscriptions above.

-- =====================================================================
-- save_push_subscription — insert-or-reassign one device to the
-- caller's own active membership for p_tenant_id.
-- =====================================================================
create function private.save_push_subscription(
  p_tenant_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth_key text,
  p_device_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'NF001';
  end if;

  if p_endpoint is null or length(btrim(p_endpoint)) = 0
     or p_p256dh is null or length(btrim(p_p256dh)) = 0
     or p_auth_key is null or length(btrim(p_auth_key)) = 0 then
    raise exception 'endpoint, p256dh, and auth_key are required' using errcode = 'NF002';
  end if;

  -- The one ownership check every RPC in this file performs the same
  -- way: this tenant, this caller, active, not deleted — byte-for-byte
  -- the same predicate private.has_permission/is_tenant_member already
  -- use (20260815120014), just selecting the membership id itself
  -- rather than a boolean.
  select id into v_membership_id
  from public.tenant_memberships
  where tenant_id = p_tenant_id
    and user_id = auth.uid()
    and status = 'active'
    and deleted_at is null;

  if v_membership_id is null then
    raise exception 'active tenant membership required' using errcode = 'NF003';
  end if;

  insert into public.push_subscriptions (
    tenant_membership_id, endpoint, p256dh, auth_key, device_label, last_seen_at, revoked_at
  )
  values (
    v_membership_id, p_endpoint, p_p256dh, p_auth_key, p_device_label, now(), null
  )
  on conflict (endpoint) do update
  set tenant_membership_id = excluded.tenant_membership_id,
      p256dh = excluded.p256dh,
      auth_key = excluded.auth_key,
      device_label = excluded.device_label,
      updated_at = now(),
      last_seen_at = now(),
      revoked_at = null
  returning id into v_subscription_id;

  return jsonb_build_object('id', v_subscription_id, 'deviceLabel', p_device_label);
end;
$$;

comment on function private.save_push_subscription(uuid, text, text, text, text) is
  'Faz NOTIF.2A. Derives the caller''s own active membership for p_tenant_id from auth.uid() — never accepts one as input. ON CONFLICT (endpoint) reassigns an existing row to the newly-proven membership (the account-switch safety property — see this migration''s header). Returns only the new row''s id and label, never endpoint/p256dh/auth_key back to the caller.';

-- =====================================================================
-- remove_push_subscription — soft-revoke exactly one of the caller's
-- own devices. Ownership-only gate, deliberately NOT gated on the
-- caller's membership still being active: revoking your own device
-- must keep working even for someone whose membership was just
-- suspended, so they can clean up their own state.
-- =====================================================================
create function private.remove_push_subscription(p_subscription_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'NF001';
  end if;

  select tm.user_id into v_owner_user_id
  from public.push_subscriptions ps
  join public.tenant_memberships tm on tm.id = ps.tenant_membership_id
  where ps.id = p_subscription_id;

  -- "doesn't exist" and "exists but belongs to someone else" collapse
  -- to the identical NF004 — no existence side channel, same rule
  -- cancel_my_appointment's AC003 already documents (20260823201517).
  if v_owner_user_id is null or v_owner_user_id <> auth.uid() then
    raise exception 'subscription not found' using errcode = 'NF004';
  end if;

  update public.push_subscriptions
  set revoked_at = now()
  where id = p_subscription_id
    and revoked_at is null;
end;
$$;

comment on function private.remove_push_subscription(uuid) is
  'Faz NOTIF.2A. Soft-revoke only (revoked_at, not a delete) — preserves the row for delivery-worker cleanup/audit later. Ownership proven via a join back through tenant_memberships.user_id; never trusts a caller-supplied membership or tenant id because none is accepted.';

-- =====================================================================
-- list_my_devices — metadata only. Deliberately never selects
-- endpoint/p256dh/auth_key.
-- =====================================================================
create function private.list_my_devices(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ps.id,
    'deviceLabel', ps.device_label,
    'createdAt', ps.created_at,
    'lastSeenAt', ps.last_seen_at,
    'revoked', ps.revoked_at is not null
  ) order by ps.created_at desc), '[]'::jsonb)
  from public.push_subscriptions ps
  join public.tenant_memberships tm on tm.id = ps.tenant_membership_id
  where tm.tenant_id = p_tenant_id
    and tm.user_id = auth.uid()
    and tm.status = 'active'
    and tm.deleted_at is null;
$$;

comment on function private.list_my_devices(uuid) is
  'Faz NOTIF.2A. Returns id/deviceLabel/createdAt/lastSeenAt/revoked only — never endpoint, p256dh, or auth_key, which have no reason to ever reach browser JS once a subscription exists. Empty array for no active membership (no side channel), same convention as this project''s public-booking RPCs.';

-- =====================================================================
-- get_my_notification_preferences — all-true defaults when no row
-- exists yet (lazy creation happens only on update, below).
-- =====================================================================
create function private.get_my_notification_preferences(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_prefs record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'NF001';
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

  select new_appointment, cancellation, reschedule, assignment_change
  into v_prefs
  from public.notification_preferences
  where tenant_membership_id = v_membership_id;

  if not found then
    return jsonb_build_object(
      'newAppointment', true, 'cancellation', true, 'reschedule', true, 'assignmentChange', true
    );
  end if;

  return jsonb_build_object(
    'newAppointment', v_prefs.new_appointment,
    'cancellation', v_prefs.cancellation,
    'reschedule', v_prefs.reschedule,
    'assignmentChange', v_prefs.assignment_change
  );
end;
$$;

comment on function private.get_my_notification_preferences(uuid) is
  'Faz NOTIF.2A. No-row-yet reads as all-true, matching notification_preferences''s own column defaults exactly — never backfilled, see that table''s comment.';

-- =====================================================================
-- update_my_notification_preferences — exactly four named booleans,
-- each optional (null = leave unchanged). No generic patch surface, no
-- field a caller could name that isn't one of these four.
-- =====================================================================
create function private.update_my_notification_preferences(
  p_tenant_id uuid,
  p_new_appointment boolean default null,
  p_cancellation boolean default null,
  p_reschedule boolean default null,
  p_assignment_change boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_prefs record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'NF001';
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

  insert into public.notification_preferences (
    tenant_membership_id, new_appointment, cancellation, reschedule, assignment_change
  )
  values (
    v_membership_id,
    coalesce(p_new_appointment, true),
    coalesce(p_cancellation, true),
    coalesce(p_reschedule, true),
    coalesce(p_assignment_change, true)
  )
  on conflict (tenant_membership_id) do update
  set new_appointment = coalesce(p_new_appointment, public.notification_preferences.new_appointment),
      cancellation = coalesce(p_cancellation, public.notification_preferences.cancellation),
      reschedule = coalesce(p_reschedule, public.notification_preferences.reschedule),
      assignment_change = coalesce(p_assignment_change, public.notification_preferences.assignment_change),
      updated_at = now()
  returning new_appointment, cancellation, reschedule, assignment_change
  into v_prefs;

  return jsonb_build_object(
    'newAppointment', v_prefs.new_appointment,
    'cancellation', v_prefs.cancellation,
    'reschedule', v_prefs.reschedule,
    'assignmentChange', v_prefs.assignment_change
  );
end;
$$;

comment on function private.update_my_notification_preferences(uuid, boolean, boolean, boolean, boolean) is
  'Faz NOTIF.2A. Lazy-creates the row on first call (ON CONFLICT DO UPDATE against a fresh INSERT, same idiom as this project''s other upsert-shaped RPCs). Every field defaults to null = "leave unchanged"; the four fixed parameter names are the entire surface — there is no field name a caller could supply that reaches an unintended column.';

revoke execute on function private.save_push_subscription(uuid, text, text, text, text) from public;
revoke execute on function private.remove_push_subscription(uuid) from public;
revoke execute on function private.list_my_devices(uuid) from public;
revoke execute on function private.get_my_notification_preferences(uuid) from public;
revoke execute on function private.update_my_notification_preferences(uuid, boolean, boolean, boolean, boolean) from public;

create function public.save_push_subscription(
  p_tenant_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth_key text,
  p_device_label text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.save_push_subscription(p_tenant_id, p_endpoint, p_p256dh, p_auth_key, p_device_label);
$$;

create function public.remove_push_subscription(p_subscription_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.remove_push_subscription(p_subscription_id);
$$;

create function public.list_my_devices(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.list_my_devices(p_tenant_id);
$$;

create function public.get_my_notification_preferences(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_my_notification_preferences(p_tenant_id);
$$;

create function public.update_my_notification_preferences(
  p_tenant_id uuid,
  p_new_appointment boolean default null,
  p_cancellation boolean default null,
  p_reschedule boolean default null,
  p_assignment_change boolean default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.update_my_notification_preferences(
    p_tenant_id, p_new_appointment, p_cancellation, p_reschedule, p_assignment_change
  );
$$;

-- Explicit PUBLIC revoke first (whatever Postgres's own default grant
-- might otherwise leave — the same defensive-revoke-then-grant order
-- every other RPC batch in this schema follows, e.g. 20260819052733's
-- own closing block), then anon explicitly denied, then authenticated
-- only.
revoke execute on function public.save_push_subscription(uuid, text, text, text, text) from public;
revoke execute on function public.remove_push_subscription(uuid) from public;
revoke execute on function public.list_my_devices(uuid) from public;
revoke execute on function public.get_my_notification_preferences(uuid) from public;
revoke execute on function public.update_my_notification_preferences(uuid, boolean, boolean, boolean, boolean) from public;

revoke execute on function public.save_push_subscription(uuid, text, text, text, text) from anon;
revoke execute on function public.remove_push_subscription(uuid) from anon;
revoke execute on function public.list_my_devices(uuid) from anon;
revoke execute on function public.get_my_notification_preferences(uuid) from anon;
revoke execute on function public.update_my_notification_preferences(uuid, boolean, boolean, boolean, boolean) from anon;

grant execute on function public.save_push_subscription(uuid, text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(uuid) to authenticated;
grant execute on function public.list_my_devices(uuid) to authenticated;
grant execute on function public.get_my_notification_preferences(uuid) to authenticated;
grant execute on function public.update_my_notification_preferences(uuid, boolean, boolean, boolean, boolean) to authenticated;
