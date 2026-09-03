-- Phase 2I.2C.1 — a tenant-facing toggle for the online_booking feature.
-- tenant_features has NO write grant to authenticated at all (20260815120012:
-- "platform_admin-only... enforced via the later policy") — it exists to
-- back per-tenant PLAN overrides (inventory, finance, commission, etc.),
-- which must stay platform/billing-controlled, not something any tenant
-- can self-grant. Rather than widen that table's grants (which would
-- hand every tenant self-service control over every future paid
-- feature), this adds one narrowly-scoped RPC that does exactly one
-- thing: sets the online_booking row for the CALLER's own tenant, gated
-- by settings.manage. No table grant changes at all — the function's own
-- SECURITY DEFINER privilege is the entire write path, exactly like
-- every other private.*/public.* RPC pair in this codebase.

create or replace function private.set_online_booking_enabled(p_tenant_id uuid, p_enabled boolean)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_feature_id uuid;
  v_old_enabled boolean;
  v_tenant_feature_id uuid;
begin
  if not private.has_permission(p_tenant_id, 'settings.manage') then
    raise exception 'settings.manage required';
  end if;

  select id into v_feature_id from public.features where key = 'online_booking';
  if v_feature_id is null then
    raise exception 'online_booking feature is missing from the catalog — seed data problem, not a user error';
  end if;

  select tf.id, tf.enabled into v_tenant_feature_id, v_old_enabled
  from public.tenant_features tf
  where tf.tenant_id = p_tenant_id and tf.feature_id = v_feature_id;

  insert into public.tenant_features (tenant_id, feature_id, enabled, granted_by)
  values (p_tenant_id, v_feature_id, p_enabled, auth.uid())
  on conflict (tenant_id, feature_id)
  do update set enabled = excluded.enabled, granted_by = excluded.granted_by;

  perform private.log_audit_event(
    p_tenant_id,
    'settings.online_booking_changed',
    'tenant_features',
    coalesce(v_tenant_feature_id, p_tenant_id),
    jsonb_build_object('enabled', v_old_enabled),
    jsonb_build_object('enabled', p_enabled)
  );

  return p_enabled;
end;
$function$;

-- private.set_online_booking_enabled is a brand-new function (unlike most
-- private.* functions touched elsewhere in this codebase, which are
-- `create or replace` on functions that already existed — and Postgres
-- preserves a function's existing grants across a body-only replace, so
-- those never needed a fresh revoke here). A genuinely new function gets
-- Postgres's own default: EXECUTE granted to PUBLIC unless revoked. Match
-- the convention used at every other private.* function's original
-- creation and revoke that default explicitly.
revoke execute on function private.set_online_booking_enabled(uuid, boolean) from public;

create or replace function public.set_online_booking_enabled(p_tenant_id uuid, p_enabled boolean)
 returns boolean
 language sql
 security definer
 set search_path to ''
as $function$
  select private.set_online_booking_enabled(p_tenant_id, p_enabled);
$function$;

revoke execute on function public.set_online_booking_enabled(uuid, boolean) from public;
grant execute on function public.set_online_booking_enabled(uuid, boolean) to authenticated;
