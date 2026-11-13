-- Faz SAAS.1C.2a (2/3) - manual billing + tenant lifecycle RPC foundation (platform OWNER only).
--
-- Until a payment provider exists the platform owner manages subscriptions by hand. This migration adds the ONLY sanctioned write path:
-- ONE private core (private.billing_manual_action) behind 10 typed public wrappers. There is no Super Admin write UI in this phase; the wrappers are
-- reachable by an authenticated platform OWNER session and by the operator break-glass procedure (which sets the jwt subject inside one transaction).
--
-- Every call, in ONE transaction:
--   * platform OWNER only (role 'owner' AND active). The `support` role, tenant users and anonymous callers are refused. auth.uid() is checked explicitly;
--     nothing reads user_metadata.
--   * reason (5..500 chars), request_id and expected_version are REQUIRED.
--   * the tenant row and then the subscription row are locked FOR UPDATE (fixed order tenants -> subscriptions).
--   * idempotency: a (actor, request_id) pair is unique (partial unique index). A replay with the same payload returns the original result and writes
--     nothing; the same request_id with a different payload/tenant/action is refused (request_conflict).
--   * stale-write detection: subscriptions.version (or tenants.lifecycle_version for the two lifecycle actions) must equal expected_version.
--     The version is maintained by a trigger, so ANY change to the managed columns (manual action, trial start, a future provider webhook) bumps it.
--   * a closed transition table; anything else is invalid_transition.
--   * protected tenants (pilot / internal salons: subscriptions.protected) can never be moved into a state that is not 'active, non-paid, full access'.
--     This is enforced by the database (pre-checks plus a post-condition on the resulting access state), NOT by the typed-slug confirmation, which
--     is only an operator brake on dangerous actions. Removing the protection is its own audited action.
--   * one append-only subscription_events row: actor, reason, request id/hash, action type and the full before/after snapshots.
--   * provider identifiers (provider, provider_customer_id, provider_subscription_id) are never read or written by any of these functions.
--
-- Data changes on existing rows (reported for the PROD release): subscriptions.version = 1 (default), subscriptions.protected = true for rows whose
-- billing_mode is 'pilot' or 'internal' (the three protected PROD salons). No status, plan, date or billing-mode value is changed.
--
-- ROLLBACK: see the 1C.2a rollback script (drops the wrappers, the core, the helpers and the trigger, then the added columns and index, restores the
-- previous event-type constraint).

-- 1. schema -----------------------------------------------------------------------------------------------------------------------------------
alter table public.subscriptions add column if not exists version integer not null default 1;
alter table public.subscriptions add column if not exists protected boolean not null default false;
comment on column public.subscriptions.version is 'Row revision. Bumped by the subscriptions_bump_version trigger whenever a managed column changes; compared by the manual billing RPCs (expected_version).';
comment on column public.subscriptions.protected is 'Protected tenants (pilot / internal) can never be moved into a blocked or read-only state by a manual operation. Cleared only by the audited admin_billing_set_protection action.';

-- protected tenants are recognised by their billing mode, not by slug or name; the update runs BEFORE the version trigger exists, so versions stay 1
update public.subscriptions set protected = true where billing_mode in ('pilot', 'internal');

alter table public.subscription_events add column if not exists request_id uuid;
alter table public.subscription_events add column if not exists request_hash text;
create unique index if not exists subscription_events_actor_request_uidx
  on public.subscription_events (actor_user_id, request_id)
  where request_id is not null;

alter table public.subscription_events drop constraint if exists subscription_events_event_type_check;
alter table public.subscription_events add constraint subscription_events_event_type_check check (event_type = any (array[
  'created', 'backfilled', 'trial_started', 'status_changed', 'plan_changed', 'billing_mode_changed', 'override_changed', 'note',
  'trial_extended', 'grace_extended', 'cancel_scheduled', 'cancel_unscheduled', 'period_set', 'protection_changed', 'tenant_lifecycle_changed'
]));

-- 2. version trigger -------------------------------------------------------------------------------------------------------------------------
create or replace function private.subscriptions_bump_version()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  -- the version is never client-assignable: it is old+1 when anything but updated_at/version changed, otherwise unchanged
  if (to_jsonb(new) - 'updated_at' - 'version') is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$function$;
revoke all on function private.subscriptions_bump_version() from public, anon, authenticated, service_role;

drop trigger if exists subscriptions_bump_version on public.subscriptions;
create trigger subscriptions_bump_version
  before update on public.subscriptions
  for each row execute function private.subscriptions_bump_version();

-- 3. authorization: platform OWNER (not merely a platform admin) ----------------------------------------------------------------------------
create or replace function private.admin_require_owner()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid() and pa.is_active = true and pa.role = 'owner') then
    raise exception 'platform owner required';
  end if;
end;
$function$;
revoke all on function private.admin_require_owner() from public, anon, authenticated, service_role;

-- 4. snapshots ------------------------------------------------------------------------------------------------------------------------------
create or replace function private.billing_snapshot(p_sub public.subscriptions)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'status', p_sub.status,
    'billingMode', p_sub.billing_mode,
    'planKey', (select p.key from public.plans p where p.id = p_sub.plan_id),
    'trialStartedAt', p_sub.trial_started_at,
    'trialEndsAt', p_sub.trial_ends_at,
    'graceEndsAt', p_sub.grace_ends_at,
    'currentPeriodStart', p_sub.current_period_start,
    'currentPeriodEnd', p_sub.current_period_end,
    'cancelAtPeriodEnd', p_sub.cancel_at_period_end,
    'canceledAt', p_sub.canceled_at,
    'protected', p_sub.protected,
    'version', p_sub.version
  );
$function$;
revoke all on function private.billing_snapshot(public.subscriptions) from public, anon, authenticated, service_role;

-- 5. the single core -----------------------------------------------------------------------------------------------------------------------
create or replace function private.billing_manual_action(
  p_tenant_id uuid,
  p_action text,
  p_params jsonb,
  p_reason text,
  p_request_id uuid,
  p_expected_version integer,
  p_confirm_slug text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
  v_hash text;
  v_now timestamptz := now();
  v_lifecycle boolean := p_action in ('tenant_suspend', 'tenant_unsuspend');
  v_t public.tenants%rowtype;
  v_sub public.subscriptions%rowtype;
  v_new public.subscriptions%rowtype;
  v_prev public.subscription_events%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_event_type text;
  v_event_id uuid;
  v_from_status text;
  v_to_status text;
  v_from_plan uuid;
  v_to_plan uuid;
  v_plan_id uuid;
  v_ts timestamptz;
  v_days integer;
  v_mode text;
  v_cur_version integer;
  v_new_tenant_status text;
  v_state jsonb;
begin
  perform private.admin_require_owner();

  if p_request_id is null then raise exception 'request_id_required'; end if;
  if p_expected_version is null then raise exception 'expected_version_required'; end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then raise exception 'reason_required'; end if;
  if p_action is null or p_action not in ('activate_paid', 'set_mode', 'extend_trial', 'extend_grace', 'mark_past_due', 'restore_active',
                                          'cancel_at_period_end', 'undo_cancel_at_period_end', 'cancel_immediate', 'change_plan',
                                          'set_protection', 'tenant_suspend', 'tenant_unsuspend') then
    raise exception 'invalid_action';
  end if;

  -- the payload fingerprint: tenant + action + parameters + reason + expected version (the slug confirmation is an operator brake, not payload)
  v_hash := encode(sha256(convert_to(p_tenant_id::text || '|' || p_action || '|' || v_params::text || '|' || v_reason || '|' || p_expected_version::text, 'UTF8')), 'hex');

  -- fixed lock order: tenant, then subscription
  select * into v_t from public.tenants where id = p_tenant_id for update;
  if not found then raise exception 'tenant_not_found'; end if;
  select * into v_sub from public.subscriptions where tenant_id = p_tenant_id for update;

  -- idempotency (after the locks, so a concurrent twin waits for the first commit and then sees its event)
  select * into v_prev from public.subscription_events where actor_user_id = v_actor and request_id = p_request_id;
  if found then
    if v_prev.request_hash is not distinct from v_hash then
      return jsonb_build_object('ok', true, 'replayed', true, 'eventId', v_prev.id, 'tenantId', p_tenant_id, 'action', p_action,
                                'version', coalesce((v_prev.metadata -> 'after' ->> 'version')::integer, (v_prev.metadata -> 'after' ->> 'lifecycleVersion')::integer),
                                'before', v_prev.metadata -> 'before', 'after', v_prev.metadata -> 'after');
    end if;
    raise exception 'request_conflict';
  end if;

  if v_t.deleted_at is not null then raise exception 'tenant_deleted'; end if;
  if not v_lifecycle and v_sub.id is null then raise exception 'subscription_not_found'; end if;

  v_cur_version := case when v_lifecycle then v_t.lifecycle_version else v_sub.version end;
  if v_cur_version <> p_expected_version then raise exception 'stale_version'; end if;

  -- protected tenants: the database refuses every action that could leave them blocked / read-only / paid-expiring
  if v_sub.protected and p_action in ('activate_paid', 'extend_trial', 'extend_grace', 'mark_past_due', 'cancel_at_period_end', 'cancel_immediate', 'tenant_suspend') then
    raise exception 'protected_tenant';
  end if;

  v_new := v_sub;

  if v_lifecycle then
    v_before := jsonb_build_object('status', v_t.status, 'deletedAt', v_t.deleted_at, 'slug', v_t.slug, 'lifecycleVersion', v_t.lifecycle_version);
    v_from_status := v_t.status;
    v_event_type := 'tenant_lifecycle_changed';
    if p_action = 'tenant_suspend' then
      if v_t.status not in ('trial', 'active') then raise exception 'invalid_transition'; end if;
      if p_confirm_slug is distinct from v_t.slug then raise exception 'confirmation_required'; end if;
      v_new_tenant_status := 'suspended';
    else
      if v_t.status <> 'suspended' then raise exception 'invalid_transition'; end if;
      select e.metadata -> 'before' ->> 'status' into v_new_tenant_status
        from public.subscription_events e
       where e.tenant_id = p_tenant_id and e.event_type = 'tenant_lifecycle_changed' and e.metadata ->> 'action' = 'tenant_suspend'
       order by e.created_at desc limit 1;
      if v_new_tenant_status is null or v_new_tenant_status not in ('trial', 'active') then v_new_tenant_status := 'trial'; end if;
    end if;
    v_to_status := v_new_tenant_status;

    perform set_config('salonos.sanctioned_lifecycle', 'on', true);
    update public.tenants set status = v_new_tenant_status where id = p_tenant_id returning * into v_t;
    perform set_config('salonos.sanctioned_lifecycle', 'off', true);

    v_after := jsonb_build_object('status', v_t.status, 'deletedAt', v_t.deleted_at, 'slug', v_t.slug, 'lifecycleVersion', v_t.lifecycle_version);
  else
    v_before := private.billing_snapshot(v_sub);
    v_from_status := v_sub.status;
    v_from_plan := v_sub.plan_id;

    if p_action = 'activate_paid' then
      begin
        v_ts := (v_params ->> 'periodEnd')::timestamptz;
      exception when others then
        raise exception 'invalid_parameter';
      end;
      if v_ts is null or v_ts <= v_now + interval '1 hour' or v_ts > v_now + interval '400 days' then raise exception 'invalid_parameter'; end if;
      if v_params ->> 'planKey' is not null then
        select p.id into v_plan_id from public.plans p where p.key = v_params ->> 'planKey' and p.is_active;
        if not found then raise exception 'plan_not_found'; end if;
        v_new.plan_id := v_plan_id;
      end if;
      if v_sub.billing_mode = 'paid' and v_sub.status = 'active' and v_sub.current_period_end is not null then
        if v_ts <= v_sub.current_period_end then raise exception 'period_not_extended'; end if;
        v_new.current_period_end := v_ts;
      else
        v_new.current_period_start := v_now;
        v_new.current_period_end := v_ts;
      end if;
      -- paying ends a running trial: the history stays, but a trial end in the future would conflict with later grace dates
      if v_sub.trial_ends_at is not null and v_sub.trial_ends_at > v_now then
        v_new.trial_ends_at := v_now;
      end if;
      v_new.billing_mode := 'paid';
      v_new.status := 'active';
      v_new.grace_ends_at := null;
      v_new.cancel_at_period_end := false;
      v_new.canceled_at := null;
      v_event_type := 'period_set';

    elsif p_action = 'set_mode' then
      v_mode := v_params ->> 'mode';
      if v_mode is null or v_mode not in ('complimentary', 'pilot', 'internal') then raise exception 'invalid_parameter'; end if;
      if v_sub.billing_mode = v_mode and v_sub.status = 'active' then raise exception 'invalid_transition'; end if;
      if v_mode = 'internal' and p_confirm_slug is distinct from v_t.slug then raise exception 'confirmation_required'; end if;
      v_new.billing_mode := v_mode;
      v_new.status := 'active';
      v_new.trial_started_at := null;
      v_new.trial_ends_at := null;
      v_new.grace_ends_at := null;
      v_new.current_period_start := null;
      v_new.current_period_end := null;
      v_new.cancel_at_period_end := false;
      v_new.canceled_at := null;
      if v_mode in ('pilot', 'internal') then v_new.protected := true; end if;
      v_event_type := 'billing_mode_changed';

    elsif p_action = 'extend_trial' then
      begin
        v_days := (v_params ->> 'days')::integer;
      exception when others then
        raise exception 'invalid_parameter';
      end;
      if v_days is null or v_days < 1 or v_days > 30 then raise exception 'invalid_parameter'; end if;
      if v_sub.billing_mode <> 'paid' or v_sub.status <> 'trialing' then raise exception 'invalid_transition'; end if;
      if v_sub.trial_started_at is null then raise exception 'trial_not_started'; end if;
      v_ts := v_sub.trial_ends_at + make_interval(days => v_days);
      if v_ts > v_sub.trial_started_at + interval '720 hours' + interval '60 days' then raise exception 'cap_exceeded'; end if;
      if v_ts <= v_now then raise exception 'invalid_parameter'; end if;
      v_new.trial_ends_at := v_ts;
      v_new.grace_ends_at := v_sub.grace_ends_at + make_interval(days => v_days);
      v_event_type := 'trial_extended';

    elsif p_action = 'extend_grace' then
      begin
        v_ts := (v_params ->> 'until')::timestamptz;
      exception when others then
        raise exception 'invalid_parameter';
      end;
      if v_ts is null or v_ts <= v_now or v_ts > v_now + interval '30 days' then raise exception 'invalid_parameter'; end if;
      if v_sub.billing_mode <> 'paid' or v_sub.status not in ('trialing', 'past_due') then raise exception 'invalid_transition'; end if;
      if v_sub.status = 'trialing' and v_sub.trial_started_at is null then raise exception 'trial_not_started'; end if;
      if v_ts <= coalesce(v_sub.grace_ends_at, case when v_sub.status = 'trialing' then v_sub.trial_ends_at else v_now end) then raise exception 'invalid_parameter'; end if;
      v_new.grace_ends_at := v_ts;
      v_event_type := 'grace_extended';

    elsif p_action = 'mark_past_due' then
      begin
        v_days := (v_params ->> 'graceDays')::integer;
      exception when others then
        raise exception 'invalid_parameter';
      end;
      if v_days is null or v_days < 1 or v_days > 30 then raise exception 'invalid_parameter'; end if;
      if v_sub.billing_mode <> 'paid' or v_sub.status <> 'active' then raise exception 'invalid_transition'; end if;
      if p_confirm_slug is distinct from v_t.slug then raise exception 'confirmation_required'; end if;
      v_new.status := 'past_due';
      v_new.grace_ends_at := v_now + make_interval(days => v_days);
      v_event_type := 'status_changed';

    elsif p_action = 'restore_active' then
      if v_sub.status not in ('past_due', 'expired', 'canceled') then raise exception 'invalid_transition'; end if;
      if v_sub.billing_mode = 'paid' then
        begin
          v_ts := (v_params ->> 'periodEnd')::timestamptz;
        exception when others then
          raise exception 'invalid_parameter';
        end;
        if v_ts is null or v_ts <= v_now + interval '1 hour' or v_ts > v_now + interval '400 days' then raise exception 'invalid_parameter'; end if;
        v_new.current_period_start := v_now;
        v_new.current_period_end := v_ts;
      end if;
      v_new.status := 'active';
      v_new.grace_ends_at := null;
      v_new.cancel_at_period_end := false;
      v_new.canceled_at := null;
      v_event_type := 'status_changed';

    elsif p_action = 'cancel_at_period_end' then
      if v_sub.billing_mode <> 'paid' or v_sub.status <> 'active' or v_sub.current_period_end is null or v_sub.current_period_end <= v_now or v_sub.cancel_at_period_end then
        raise exception 'invalid_transition';
      end if;
      v_new.cancel_at_period_end := true;
      v_event_type := 'cancel_scheduled';

    elsif p_action = 'undo_cancel_at_period_end' then
      if not v_sub.cancel_at_period_end or v_sub.status <> 'active' then raise exception 'invalid_transition'; end if;
      v_new.cancel_at_period_end := false;
      v_event_type := 'cancel_unscheduled';

    elsif p_action = 'cancel_immediate' then
      if v_sub.status = 'canceled' then raise exception 'invalid_transition'; end if;
      if p_confirm_slug is distinct from v_t.slug then raise exception 'confirmation_required'; end if;
      v_new.status := 'canceled';
      v_new.canceled_at := v_now;
      v_new.current_period_end := v_now;
      v_new.cancel_at_period_end := false;
      v_event_type := 'status_changed';

    elsif p_action = 'change_plan' then
      select p.id into v_plan_id from public.plans p where p.key = v_params ->> 'planKey' and p.is_active;
      if not found then raise exception 'plan_not_found'; end if;
      if v_plan_id = v_sub.plan_id then raise exception 'invalid_transition'; end if;
      v_new.plan_id := v_plan_id;
      v_event_type := 'plan_changed';

    elsif p_action = 'set_protection' then
      if (v_params ->> 'protected') is null or (v_params ->> 'protected') not in ('true', 'false') then raise exception 'invalid_parameter'; end if;
      if (v_params ->> 'protected')::boolean = v_sub.protected then raise exception 'invalid_transition'; end if;
      if not (v_params ->> 'protected')::boolean and p_confirm_slug is distinct from v_t.slug then raise exception 'confirmation_required'; end if;
      v_new.protected := (v_params ->> 'protected')::boolean;
      v_event_type := 'protection_changed';
    end if;

    -- the ONLY statement that writes the subscription: managed columns only, never a provider column
    update public.subscriptions
       set plan_id = v_new.plan_id,
           status = v_new.status,
           billing_mode = v_new.billing_mode,
           trial_started_at = v_new.trial_started_at,
           trial_ends_at = v_new.trial_ends_at,
           grace_ends_at = v_new.grace_ends_at,
           current_period_start = v_new.current_period_start,
           current_period_end = v_new.current_period_end,
           cancel_at_period_end = v_new.cancel_at_period_end,
           canceled_at = v_new.canceled_at,
           protected = v_new.protected
     where id = v_sub.id
     returning * into v_new;

    -- protected tenants must still be 'active, non-paid, full access' afterwards (set_protection only changes the flag itself)
    if v_sub.protected and p_action <> 'set_protection' then
      v_state := private.tenant_access_state(p_tenant_id);
      if v_new.status <> 'active' or v_new.billing_mode = 'paid' or (v_state ->> 'mode') is distinct from 'full' then
        raise exception 'protected_tenant';
      end if;
    end if;

    v_after := private.billing_snapshot(v_new);
    v_to_status := v_new.status;
    v_to_plan := v_new.plan_id;
  end if;

  begin
    insert into public.subscription_events (tenant_id, subscription_id, event_type, from_status, to_status, from_plan_id, to_plan_id, actor_user_id, reason, metadata, request_id, request_hash)
    values (p_tenant_id, v_sub.id, v_event_type, v_from_status, v_to_status, v_from_plan, v_to_plan, v_actor, v_reason,
            jsonb_build_object('action', p_action, 'params', v_params, 'before', v_before, 'after', v_after, 'requestId', p_request_id, 'source', 'rpc'),
            p_request_id, v_hash)
    returning id into v_event_id;
  exception when unique_violation then
    raise exception 'request_conflict';
  end;

  return jsonb_build_object('ok', true, 'replayed', false, 'eventId', v_event_id, 'tenantId', p_tenant_id, 'action', p_action,
                            'version', case when v_lifecycle then v_t.lifecycle_version else v_new.version end,
                            'before', v_before, 'after', v_after,
                            'accessState', private.tenant_access_state(p_tenant_id));
end;
$function$;
revoke all on function private.billing_manual_action(uuid, text, jsonb, text, uuid, integer, text) from public, anon, authenticated, service_role;

-- 6. the typed public wrappers (authenticated EXECUTE only; each checks auth.uid() and the platform OWNER role first) ---------------------------
create or replace function public.admin_billing_activate_paid(p_tenant_id uuid, p_period_end timestamptz, p_reason text, p_request_id uuid, p_expected_version integer, p_plan_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.admin_require_owner();
  return private.billing_manual_action(p_tenant_id, 'activate_paid', jsonb_build_object('periodEnd', to_char(p_period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'planKey', p_plan_key), p_reason, p_request_id, p_expected_version, null);
end;
$function$;

create or replace function public.admin_billing_set_mode(p_tenant_id uuid, p_mode text, p_reason text, p_request_id uuid, p_expected_version integer, p_confirm_slug text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.admin_require_owner();
  return private.billing_manual_action(p_tenant_id, 'set_mode', jsonb_build_object('mode', p_mode), p_reason, p_request_id, p_expected_version, p_confirm_slug);
end;
$function$;

create or replace function public.admin_billing_extend_trial(p_tenant_id uuid, p_days integer, p_reason text, p_request_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.admin_require_owner();
  return private.billing_manual_action(p_tenant_id, 'extend_trial', jsonb_build_object('days', p_days), p_reason, p_request_id, p_expected_version, null);
end;
$function$;

create or replace function public.admin_billing_extend_grace(p_tenant_id uuid, p_until timestamptz, p_reason text, p_request_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.admin_require_owner();
  return private.billing_manual_action(p_tenant_id, 'extend_grace', jsonb_build_object('until', to_char(p_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), p_reason, p_request_id, p_expected_version, null);
end;
$function$;

create or replace function public.admin_billing_mark_past_due(p_tenant_id uuid, p_grace_days integer, p_reason text, p_request_id uuid, p_expected_version integer, p_confirm_slug text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.admin_require_owner();
  return private.billing_manual_action(p_tenant_id, 'mark_past_due', jsonb_build_object('graceDays', p_grace_days), p_reason, p_request_id, p_expected_version, p_confirm_slug);
end;
$function$;

create or replace function public.admin_billing_restore_active(p_tenant_id uuid, p_reason text, p_request_id uuid, p_expected_version integer, p_period_end timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.admin_require_owner();
  return private.billing_manual_action(p_tenant_id, 'restore_active', jsonb_build_object('periodEnd', to_char(p_period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), p_reason, p_request_id, p_expected_version, null);
end;
$function$;

create or replace function public.admin_billing_cancel(p_tenant_id uuid, p_mode text, p_reason text, p_request_id uuid, p_expected_version integer, p_confirm_slug text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_action text;
begin
  perform private.admin_require_owner();
  v_action := case p_mode
    when 'at_period_end' then 'cancel_at_period_end'
    when 'undo_at_period_end' then 'undo_cancel_at_period_end'
    when 'immediate' then 'cancel_immediate'
    else null end;
  if v_action is null then
    raise exception 'invalid_parameter';
  end if;
  return private.billing_manual_action(p_tenant_id, v_action, '{}'::jsonb, p_reason, p_request_id, p_expected_version, p_confirm_slug);
end;
$function$;

create or replace function public.admin_billing_change_plan(p_tenant_id uuid, p_plan_key text, p_reason text, p_request_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.admin_require_owner();
  return private.billing_manual_action(p_tenant_id, 'change_plan', jsonb_build_object('planKey', p_plan_key), p_reason, p_request_id, p_expected_version, null);
end;
$function$;

create or replace function public.admin_billing_set_protection(p_tenant_id uuid, p_protected boolean, p_reason text, p_request_id uuid, p_expected_version integer, p_confirm_slug text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.admin_require_owner();
  return private.billing_manual_action(p_tenant_id, 'set_protection', jsonb_build_object('protected', p_protected), p_reason, p_request_id, p_expected_version, p_confirm_slug);
end;
$function$;

create or replace function public.admin_set_tenant_lifecycle(p_tenant_id uuid, p_action text, p_reason text, p_request_id uuid, p_expected_version integer, p_confirm_slug text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_action text;
begin
  perform private.admin_require_owner();
  v_action := case p_action when 'suspend' then 'tenant_suspend' when 'unsuspend' then 'tenant_unsuspend' else null end;
  if v_action is null then
    raise exception 'invalid_parameter';
  end if;
  return private.billing_manual_action(p_tenant_id, v_action, '{}'::jsonb, p_reason, p_request_id, p_expected_version, p_confirm_slug);
end;
$function$;

revoke all on function public.admin_billing_activate_paid(uuid, timestamptz, text, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_set_mode(uuid, text, text, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_extend_trial(uuid, integer, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_extend_grace(uuid, timestamptz, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_mark_past_due(uuid, integer, text, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_restore_active(uuid, text, uuid, integer, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_cancel(uuid, text, text, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_change_plan(uuid, text, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_set_protection(uuid, boolean, text, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_tenant_lifecycle(uuid, text, text, uuid, integer, text) from public, anon, authenticated, service_role;

grant execute on function public.admin_billing_activate_paid(uuid, timestamptz, text, uuid, integer, text) to authenticated;
grant execute on function public.admin_billing_set_mode(uuid, text, text, uuid, integer, text) to authenticated;
grant execute on function public.admin_billing_extend_trial(uuid, integer, text, uuid, integer) to authenticated;
grant execute on function public.admin_billing_extend_grace(uuid, timestamptz, text, uuid, integer) to authenticated;
grant execute on function public.admin_billing_mark_past_due(uuid, integer, text, uuid, integer, text) to authenticated;
grant execute on function public.admin_billing_restore_active(uuid, text, uuid, integer, timestamptz) to authenticated;
grant execute on function public.admin_billing_cancel(uuid, text, text, uuid, integer, text) to authenticated;
grant execute on function public.admin_billing_change_plan(uuid, text, text, uuid, integer) to authenticated;
grant execute on function public.admin_billing_set_protection(uuid, boolean, text, uuid, integer, text) to authenticated;
grant execute on function public.admin_set_tenant_lifecycle(uuid, text, text, uuid, integer, text) to authenticated;
