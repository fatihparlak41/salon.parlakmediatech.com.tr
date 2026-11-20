-- Faz SAAS.1C.2c-A2 (1/3) - enforcement hook integration: the CORE (classification, central guard, decision recording, coverage check).
--
-- A1 (live since 2026-11-20) created the control plane and left the stage at 0. A2 connects the decision engine to the real write paths in THREE
-- migrations, deliberately separated so each can be reviewed and rolled back on its own:
--   (1/3) this file: registry classification columns, the ONE central guard `private.billing_guard`, the decision recorder, the lazy tenant resolver,
--          the read-side public-booking gate, the hook-coverage function and one added preflight check. Nothing is hooked yet.
--   (2/3) function hooks: ONE marked line is injected at the start of each registered tenant business writer (and the public booking read gate).
--   (3/3) direct-table triggers: BEFORE triggers for the registered direct API writes (they act only when the writer is an API role).
--
-- STAGE 0 IS INERT: the guard's first statement reads the stage singleton and returns when it is 0 (no tenant lookup, no registry lookup, no
-- sub-transaction, no write, no error). Stage 1 only observes (records allow / would_block, never refuses; a guard failure fails OPEN and is counted).
-- Stages 2-4 apply the accepted policy of private.billing_categories through the existing A1 decision engine (private.billing_decide).
-- This migration does NOT change the stage and writes no shadow row.
--
-- ROLLBACK: rollback-saas-1c-2c-a2.sql (removes (3/3), then (2/3), then this file; restores the A1 preflight function; the A1 control plane stays).

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. classification: every registered action gets exactly one class, an audience and (when it can ever be refused) a hook description
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table private.billing_action_registry
  add column enforcement_class text,
  add column hooked boolean,
  add column audience text,
  add column scope text,
  add column scope_arg text;

update private.billing_action_registry r
   set enforcement_class = v.c, hooked = v.h, audience = v.a, scope = v.s, scope_arg = v.sa
  from (values
    ('fn:accept_team_invitation', 'TENANT_BUSINESS_WRITE', true, 'self', 'invitation_token', 'p_token'),
    ('fn:admin_billing_activate_paid', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_cancel', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_change_plan', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_enforcement_preflight', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_extend_grace', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_extend_trial', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_mark_past_due', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_restore_active', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_set_mode', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_billing_set_protection', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_set_billing_enforcement_stage', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:admin_set_tenant_lifecycle', 'CONTROL_PLANE', false, 'member', null, null),
    ('fn:begin_customer_notification_send', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:cancel_expense', 'EXISTING_RECORD_OPERATION', true, 'member', 'expense', 'p_expense_id'),
    ('fn:cancel_my_appointment', 'EXISTING_RECORD_OPERATION', false, 'self', null, null),
    ('fn:claim_customer_notification_jobs', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:claim_my_recent_booking', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:claim_notification_delivery_targets', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:commit_customer_import', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:complete_appointment', 'EXISTING_RECORD_OPERATION', true, 'member', 'appointment', 'p_appointment_id'),
    ('fn:complete_tenant_export', 'EXPORT', false, 'member', null, null),
    ('fn:confirm_treatment_photo', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:consume_tenant_export_token', 'EXPORT', false, 'member', null, null),
    ('fn:create_appointment', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:create_expense', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:create_guest_booking', 'PUBLIC_BOOKING_WRITE', true, 'public', 'slug', 'p_tenant_slug'),
    ('fn:create_my_link_code', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:create_role', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:create_team_invitation', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:create_tenant', 'OTHER', false, 'member', null, null),
    ('fn:delete_treatment_photo', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:fail_tenant_export', 'EXPORT', false, 'member', null, null),
    ('fn:get_or_create_appointment_sale', 'EXISTING_RECORD_OPERATION', true, 'member', 'appointment', 'p_appointment_id'),
    ('fn:link_customer_account_with_code', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:link_staff_membership', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:log_team_invitation_email_delivery', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:materialize_notification_deliveries', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:materialize_pending_notification_events', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:onboarding_add_services', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:onboarding_add_staff', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:onboarding_apply_weekly_hours', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:onboarding_set_staff_services', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:prepare_notification_delivery_targets', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:purge_customer_notification_data', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:purge_expired_notification_event_display_snapshots', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:reactivate_membership', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:record_appointment_payment', 'EXISTING_RECORD_OPERATION', true, 'member', 'sale', 'p_sale_id'),
    ('fn:record_customer_notification_result', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:record_expense_payment', 'EXISTING_RECORD_OPERATION', true, 'member', 'expense', 'p_expense_id'),
    ('fn:record_notification_delivery_target_result', 'SYSTEM_WRITE', false, 'member', null, null),
    ('fn:register_treatment_photo', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:remove_membership_access', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:remove_push_subscription', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:request_tenant_export', 'EXPORT', false, 'member', null, null),
    ('fn:reschedule_appointment', 'EXISTING_RECORD_OPERATION', true, 'member', 'appointment', 'p_appointment_id'),
    ('fn:reschedule_my_appointment', 'EXISTING_RECORD_OPERATION', true, 'self', 'appointment', 'p_appointment_id'),
    ('fn:resend_team_invitation', 'TENANT_BUSINESS_WRITE', true, 'member', 'invitation', 'p_invitation_id'),
    ('fn:revoke_team_invitation', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:save_push_subscription', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:set_commission_rule', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:set_customer_notification_setting', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:set_online_booking_enabled', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:set_treatment_note', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:suspend_membership', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:unlink_salon_assisted_customer_account', 'EXISTING_RECORD_OPERATION', true, 'member', 'customer', 'p_customer_id'),
    ('fn:unlink_staff_membership', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:update_appointment_sale_pricing', 'EXISTING_RECORD_OPERATION', true, 'member', 'sale', 'p_sale_id'),
    ('fn:update_appointment_status', 'EXISTING_RECORD_OPERATION', true, 'member', 'appointment', 'p_appointment_id'),
    ('fn:update_expense', 'EXISTING_RECORD_OPERATION', true, 'member', 'expense', 'p_expense_id'),
    ('fn:update_membership_role', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:update_my_account_profile', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:update_my_notification_preferences', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:update_role_permissions', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('fn:update_salon_profile', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant', 'p_tenant_id'),
    ('fn:void_appointment_payment', 'EXISTING_RECORD_OPERATION', true, 'member', 'payment', 'p_payment_id'),
    ('fn:void_expense_payment', 'EXISTING_RECORD_OPERATION', true, 'member', 'expense_payment', 'p_payment_id'),
    ('table:branches:INSERT', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant_col', null),
    ('table:branches:UPDATE', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant_col', null),
    ('table:customers:INSERT', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant_col', null),
    ('table:customers:UPDATE', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant_col', null),
    ('table:platform_admins:INSERT', 'CONTROL_PLANE', false, 'member', null, null),
    ('table:platform_admins:UPDATE', 'CONTROL_PLANE', false, 'member', null, null),
    ('table:profiles:UPDATE', 'SECURITY_ACCOUNT_ACTION', false, 'member', null, null),
    ('table:service_branches:DELETE', 'EXISTING_RECORD_OPERATION', true, 'member', 'relation:services:service_id', null),
    ('table:service_branches:INSERT', 'EXISTING_RECORD_OPERATION', true, 'member', 'relation:services:service_id', null),
    ('table:services:INSERT', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant_col', null),
    ('table:services:UPDATE', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant_col', null),
    ('table:staff_branches:DELETE', 'EXISTING_RECORD_OPERATION', true, 'member', 'relation:staff_members:staff_member_id', null),
    ('table:staff_branches:INSERT', 'EXISTING_RECORD_OPERATION', true, 'member', 'relation:staff_members:staff_member_id', null),
    ('table:staff_members:INSERT', 'TENANT_BUSINESS_WRITE', true, 'member', 'tenant_col', null),
    ('table:staff_members:UPDATE', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant_col', null),
    ('table:staff_schedule_exceptions:INSERT', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant_col', null),
    ('table:staff_schedule_exceptions:UPDATE', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant_col', null),
    ('table:staff_schedules:INSERT', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant_col', null),
    ('table:staff_schedules:UPDATE', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenant_col', null),
    ('table:staff_services:DELETE', 'EXISTING_RECORD_OPERATION', true, 'member', 'relation:staff_members:staff_member_id', null),
    ('table:staff_services:INSERT', 'EXISTING_RECORD_OPERATION', true, 'member', 'relation:staff_members:staff_member_id', null),
    ('table:tenants:UPDATE', 'EXISTING_RECORD_OPERATION', true, 'member', 'tenants_id', null)
  ) as v(action_key, c, h, a, s, sa)
 where r.action_key = v.action_key;

do $a2$
declare
  v_missing integer;
  v_total integer;
begin
  select count(*) into v_missing from private.billing_action_registry where enforcement_class is null;
  select count(*) into v_total from private.billing_action_registry;
  if v_missing <> 0 or v_total <> 99 then
    raise exception 'A2 classification backfill incomplete: % unclassified of % registry rows (expected 99 / 0)', v_missing, v_total;
  end if;
end
$a2$;

alter table private.billing_action_registry
  alter column enforcement_class set not null,
  alter column hooked set not null,
  alter column audience set not null;
alter table private.billing_action_registry
  add constraint billing_action_registry_class_check check (enforcement_class in
    ('TENANT_BUSINESS_WRITE', 'PUBLIC_BOOKING_WRITE', 'EXISTING_RECORD_OPERATION', 'SYSTEM_WRITE', 'SECURITY_ACCOUNT_ACTION', 'CONTROL_PLANE', 'EXPORT', 'OTHER')),
  add constraint billing_action_registry_audience_check check (audience in ('member', 'public', 'self')),
  add constraint billing_action_registry_scope_check check (scope is null or scope in
    ('tenant', 'slug', 'appointment', 'sale', 'payment', 'expense', 'expense_payment', 'customer', 'invitation', 'invitation_token', 'tenant_col', 'tenants_id')
    or scope like 'relation:%'),
  -- a hooked action is a business action with a scope; an action that is not hooked carries no scope (control plane, export, security, system: never refused)
  add constraint billing_action_registry_hook_shape check (
    (hooked and enforcement_class in ('TENANT_BUSINESS_WRITE', 'PUBLIC_BOOKING_WRITE', 'EXISTING_RECORD_OPERATION') and scope is not null
       and ((kind = 'function' and scope_arg is not null) or (kind = 'table_op' and scope_arg is null)))
    or (not hooked and scope is null and scope_arg is null));

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. lazy tenant resolver: the guard resolves the tenant from the fixed id / key the hook passes, ONLY after the stage is known to be > 0
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function private.billing_scope_tenant(p_scope text, p_id uuid, p_key text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_scope
    when 'tenant' then p_id
    when 'slug' then (select t.id from public.tenants t where t.slug = p_key)
    when 'appointment' then (select a.tenant_id from public.appointments a where a.id = p_id)
    when 'sale' then (select s.tenant_id from public.appointment_sales s where s.id = p_id)
    when 'payment' then (select p.tenant_id from public.payments p where p.id = p_id)
    when 'expense' then (select e.tenant_id from public.expenses e where e.id = p_id)
    when 'expense_payment' then (select p.tenant_id from public.expense_payments p where p.id = p_id)
    when 'customer' then (select c.tenant_id from public.customers c where c.id = p_id)
    when 'invitation' then (select i.tenant_id from public.team_invitations i where i.id = p_id)
    when 'invitation_token' then (select i.tenant_id from public.team_invitations i where i.token_hash = encode(extensions.digest(p_key, 'sha256'), 'hex'))
  end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. recording (stage >= 1): one aggregate counter row per day / tenant / stage / category / action / mode / decision / reason, plus a capped sample
--    for every refused or would-be-refused decision and for protected overrides. No PII: ids, category, action key, mode and reason only.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function private.billing_health_bump(p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.billing_guard_health as h (day, kind, n) values (current_date, p_kind, 1)
  on conflict (day, kind) do update set n = h.n + 1, last_at = now();
exception when others then
  null; -- the health counter must never break the caller
end;
$$;

create or replace function private.billing_decision_record(p_tenant_id uuid, p_stage smallint, p_version integer, p_category text, p_action_key text, p_decision jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision text := p_decision ->> 'decision';
  v_mode text := coalesce(p_decision ->> 'mode', 'full');
  v_reason text := coalesce(p_decision ->> 'reason', 'unknown');
  v_override boolean := coalesce((p_decision ->> 'protectedOverride')::boolean, false);
  v_sample_decision text;
begin
  insert into private.billing_decision_counters as c (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version)
  values (current_date, p_tenant_id, p_stage, p_category, p_action_key, v_mode, v_decision, v_reason, 1, p_version)
  on conflict (day, tenant_id, stage, category, action_key, mode, decision, reason)
  do update set n = c.n + 1, last_at = now(), config_version = excluded.config_version;

  v_sample_decision := case when v_decision in ('would_block', 'blocked') then v_decision when v_override then 'protected_override' else null end;
  if v_sample_decision is not null
     and (select count(*) from private.billing_shadow_samples s where s.tenant_id = p_tenant_id and s.at >= current_date) < 50 then
    insert into private.billing_shadow_samples (tenant_id, stage, category, action_key, mode, decision, reason, config_version)
    values (p_tenant_id, p_stage, p_category, p_action_key, v_mode, v_sample_decision, v_reason, p_version);
  end if;
  -- a protected tenant must NEVER be refused or would-be-refused: this is a bug signal that holds the preflight
  if coalesce((p_decision ->> 'protected')::boolean, false) and v_decision in ('would_block', 'blocked') then
    perform private.billing_health_bump('protected_would_block');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 4. THE central guard. Every hook (function or trigger) calls this and nothing else: the action key is a literal chosen by the migration, never
--    by the client; the tenant is resolved server-side from the id / key the hook passes; the actor is auth.uid() inside the callee checks.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function private.billing_guard(p_action_key text, p_scope text, p_id uuid default null, p_key text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_stage smallint;
  v_version integer;
  v_cat text;
  v_aud text;
  v_class text;
  v_tenant uuid;
  v_d jsonb;
  v_code text;
  v_growth boolean := false;
  v_protected boolean;
begin
  -- STAGE 0: one singleton read, then return. Nothing else runs (no registry, no tenant, no sub-transaction, no write).
  select c.stage, c.version into v_stage, v_version from private.billing_enforcement_config c where c.id = 1;
  if v_stage is null or v_stage = 0 then
    return;
  end if;
  -- operator sessions (migrations, backups, break-glass) are exempt by the exact login-role list the lifecycle and branch guards use;
  -- service_role is NOT exempt: its only way in is a definer function whose hook names the action
  if session_user in ('postgres', 'supabase_admin', 'cli_login_postgres') then
    return;
  end if;

  begin
    select r.category, r.audience, r.enforcement_class into v_cat, v_aud, v_class from private.billing_action_registry r where r.action_key = p_action_key;
    if not found then
      perform private.billing_health_bump('policy_miss'); -- an unregistered action reached the guard: counted, holds the preflight, never silently allowed
      return;
    end if;
    v_growth := v_class in ('TENANT_BUSINESS_WRITE', 'PUBLIC_BOOKING_WRITE');
    if p_scope is null or p_scope not in ('tenant', 'slug', 'appointment', 'sale', 'payment', 'expense', 'expense_payment', 'customer', 'invitation', 'invitation_token', 'row') then
      raise exception 'billing_guard: unknown scope %', p_scope;
    end if;
    v_tenant := case when p_scope = 'row' then p_id else private.billing_scope_tenant(p_scope, p_id, p_key) end;
    if v_tenant is null then
      return; -- no such tenant / record: the callee's own validation answers, exactly as before
    end if;
    -- the guard speaks only to a member of the tenant (or to the public booking gateway / the customer / the invitee), so it can never disclose
    -- the billing state of a tenant the caller has nothing to do with: anybody else gets the callee's own authorization error
    if v_aud = 'member' and not private.is_tenant_member(v_tenant) then
      return;
    end if;
    v_d := private.billing_decide(v_tenant, v_cat, v_stage);
    if coalesce((v_d ->> 'policyMiss')::boolean, false) then
      perform private.billing_health_bump('unknown_category');
      return;
    end if;
    perform private.billing_decision_record(v_tenant, v_stage, v_version, v_cat, p_action_key, v_d);
    if v_d ->> 'decision' = 'blocked' then
      v_code := coalesce(v_d ->> 'code', 'BL001');
    end if;
  exception when others then
    -- a guard failure. Stage 1: fail OPEN, counted. Stages >= 2: a business-growth action of an unprotected tenant fails CLOSED (BL004), everything
    -- else (the work of closing / correcting existing records) fails open; a protected tenant always fails open. Always counted.
    v_code := null;
    perform private.billing_health_bump('guard_error');
    if v_stage >= 2 and v_growth then
      begin
        select coalesce(s.protected, false) into v_protected from public.subscriptions s where s.tenant_id = v_tenant;
      exception when others then
        v_protected := null;
      end;
      if v_protected is not true then
        v_code := 'BL004';
      end if;
    end if;
  end;

  if v_code is not null then
    raise exception '%', case v_code when 'BL003' then 'public_booking_unavailable' when 'BL002' then 'tenant_blocked' when 'BL004' then 'enforcement_guard_error' else 'subscription_read_only' end
      using errcode = v_code;
  end if;
end;
$$;

-- read-side gate for the public booking pages (availability / eligible staff): stable, writes nothing, answers true at stages 0 and 1
create or replace function private.billing_public_booking_open(p_tenant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_stage smallint;
begin
  select c.stage into v_stage from private.billing_enforcement_config c where c.id = 1;
  if v_stage is null or v_stage < 2 then
    return true;
  end if;
  return coalesce(private.billing_decide(p_tenant_id, 'PUBLIC_BOOKING_CREATE', v_stage) ->> 'decision', 'allow') <> 'blocked';
exception when others then
  return true; -- a read gate fails open (the write point is the authority)
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 5. hook coverage: which registered action is missing its hook / trigger, or carries one it must not have (catalog based, read only)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function private.billing_hook_coverage()
returns table (action_key text, problem text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  v_def text;
  v_n integer;
  v_has boolean;
  v_ev integer;
  v_cov boolean;
begin
  for r in select g.action_key as ak, g.kind, g.hooked from private.billing_action_registry g order by g.action_key loop
    if r.kind = 'function' then
      select count(*) into v_n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = substr(r.ak, 4);
      if v_n <> 1 then
        action_key := r.ak; problem := 'function_missing_or_overloaded'; return next;
        continue;
      end if;
      select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = substr(r.ak, 4);
      v_has := position('-- a2-billing-hook' in v_def) > 0 and position('''' || r.ak || '''' in v_def) > 0;
      if r.hooked and not v_has then
        action_key := r.ak; problem := 'missing_hook'; return next;
      elsif not r.hooked and position('-- a2-billing-hook' in v_def) > 0 then
        action_key := r.ak; problem := 'unexpected_hook'; return next;
      end if;
    else
      v_ev := case split_part(r.ak, ':', 3) when 'INSERT' then 4 when 'DELETE' then 8 when 'UPDATE' then 16 end;
      select exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname = split_part(r.ak, ':', 2)
                        and t.tgname = 'billing_a2_guard' and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & v_ev) = v_ev
                        -- the WHEN (current_user in (<API roles>)) clause is part of the contract: without it a definer RPC's own write would be guarded again
                        and position(' when ' in lower(pg_get_triggerdef(t.oid))) > 0 and position('current_user' in lower(pg_get_triggerdef(t.oid))) > 0)
        into v_cov;
      if r.hooked and not v_cov then
        action_key := r.ak; problem := 'missing_trigger'; return next;
      elsif not r.hooked and v_cov then
        action_key := r.ak; problem := 'unexpected_trigger'; return next;
      end if;
    end if;
  end loop;
  -- the read-side public booking gate
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname = 'resolve_bookable_tenant';
  if position('-- a2-billing-hook' in coalesce(v_def, '')) = 0 then
    action_key := 'read:resolve_bookable_tenant'; problem := 'missing_hook'; return next;
  end if;
  return;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 6. the A1 preflight gains ONE check (hook coverage); everything else is the A1 function unchanged
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function private.billing_preflight_core(p_target smallint, p_expected_protected integer default null, p_app_sha text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg private.billing_enforcement_config%rowtype;
  v_checks jsonb := '[]'::jsonb;
  v_req private.billing_stages%rowtype;
  v_cnt jsonb;
  v_n integer;
  v_a integer;
  v_b integer;
  v_c integer;
  v_unreg jsonb;
  v_days numeric;
  v_passed boolean;
  v_hash text;
  v_slim jsonb;
  v_head text;
begin
  select * into v_cfg from private.billing_enforcement_config where id = 1;
  select * into v_req from private.billing_stages where stage = p_target;

  v_checks := v_checks || private.billing_check('config_valid',
    v_cfg.id is not null and v_cfg.stage between 0 and 4 and (select count(*) from private.billing_enforcement_config) = 1,
    jsonb_build_object('stage', v_cfg.stage, 'version', v_cfg.version));

  v_checks := v_checks || private.billing_check('transition_valid',
    p_target is not null and p_target between 0 and 4 and p_target <> v_cfg.stage and (p_target < v_cfg.stage or p_target = v_cfg.stage + 1),
    jsonb_build_object('current', v_cfg.stage, 'target', p_target));

  select count(*) into v_n from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('request_tenant_export', 'consume_tenant_export_token', 'export_read_section', 'complete_tenant_export', 'fail_tenant_export', 'get_tenant_export_status');
  v_checks := v_checks || private.billing_check('export_capability',
    v_n = 6 and to_regclass('private.tenant_export_requests') is not null and to_regclass('private.tenant_export_audit') is not null,
    jsonb_build_object('rpcs', v_n));

  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select max(version) from supabase_migrations.schema_migrations' into v_head;
  end if;
  v_checks := v_checks || private.billing_check('migration_head', coalesce(v_head >= '20261105090000', false), jsonb_build_object('head', v_head));

  select count(*) into v_a from private.billing_action_registry r
   where (r.kind = 'function' and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = substr(r.action_key, 4)))
      or (r.kind = 'table_op' and not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname = split_part(r.action_key, ':', 2)));
  v_checks := v_checks || private.billing_check('registry_integrity', v_a = 0, jsonb_build_object('stale_entries', v_a));

  select coalesce(jsonb_agg(u.action_key order by u.action_key), '[]'::jsonb) into v_unreg from private.billing_registry_unregistered() u;
  v_checks := v_checks || private.billing_check('registry_complete', jsonb_array_length(v_unreg) = 0, jsonb_build_object('unregistered', jsonb_array_length(v_unreg), 'keys', v_unreg));

  -- A2: every registered action that can be refused has its hook / trigger, and nothing else carries one
  v_checks := v_checks || private.billing_check('hook_coverage', (select count(*) from private.billing_hook_coverage()) = 0,
    jsonb_build_object('problems', (select count(*) from private.billing_hook_coverage()), 'keys', (select coalesce(jsonb_agg(c.action_key || ':' || c.problem order by c.action_key), '[]'::jsonb) from private.billing_hook_coverage() c)));

  select count(*) into v_a from public.tenants t where t.deleted_at is null and not exists (select 1 from public.subscriptions s where s.tenant_id = t.id);
  select count(*) into v_b from public.subscriptions s where not exists (select 1 from public.tenants t where t.id = s.tenant_id);
  v_checks := v_checks || private.billing_check('subscription_relationship', v_a = 0 and v_b = 0, jsonb_build_object('tenants_without_subscription', v_a, 'orphan_subscriptions', v_b));

  select count(*) into v_a from public.subscriptions s where s.status = 'trialing' and s.trial_started_at is not null and s.grace_ends_at is null;
  v_checks := v_checks || private.billing_check('trial_grace_boundary', v_a = 0, jsonb_build_object('trials_without_grace', v_a));

  select count(*) into v_a from public.subscriptions s where s.status = 'past_due' and s.grace_ends_at is null and s.current_period_end is null;
  v_checks := v_checks || private.billing_check('past_due_bounded', v_a = 0, jsonb_build_object('open_ended_past_due', v_a));

  select count(*) filter (where s.billing_mode <> 'paid' and s.status <> 'active'),
         count(*) filter (where s.billing_mode = 'paid' and s.status = 'active' and s.current_period_end is null),
         count(*) filter (where s.status = 'canceled' and s.current_period_end is null)
    into v_a, v_b, v_c from public.subscriptions s;
  v_checks := v_checks || private.billing_check('status_mode_shape', v_a + v_b + v_c = 0,
    jsonb_build_object('nonpaid_not_active', v_a, 'paid_active_without_period_end', v_b, 'canceled_without_period_end', v_c));

  select count(*) into v_a from public.subscriptions s
   where (s.current_period_start is not null and s.current_period_end is not null and s.current_period_end < s.current_period_start)
      or (s.trial_started_at is not null and s.trial_ends_at is not null and s.trial_ends_at <= s.trial_started_at)
      or (s.trial_ends_at is not null and s.grace_ends_at is not null and s.grace_ends_at < s.trial_ends_at)
      or ((s.trial_started_at is null) <> (s.trial_ends_at is null));
  v_checks := v_checks || private.billing_check('dates_wellformed', v_a = 0, jsonb_build_object('malformed_date_rows', v_a));

  select count(*) into v_a from public.subscriptions s
   where s.status is null or s.status not in ('trialing', 'active', 'past_due', 'canceled', 'expired')
      or s.billing_mode is null or s.billing_mode not in ('paid', 'complimentary', 'internal', 'pilot')
      or not exists (select 1 from public.plans p where p.id = s.plan_id);
  v_checks := v_checks || private.billing_check('status_values_known', v_a = 0, jsonb_build_object('unknown_rows', v_a));

  select count(*) into v_a from public.tenants t
   where t.deleted_at is null
     and (private.tenant_access_state(t.id) is null
          or (private.tenant_access_state(t.id) ->> 'mode') is null
          or (private.tenant_access_state(t.id) ->> 'mode') not in ('full', 'grace', 'read_only', 'blocked')
          or private.billing_effective_access(t.id) is null);
  v_checks := v_checks || private.billing_check('access_state_resolves', v_a = 0, jsonb_build_object('unresolved_tenants', v_a));

  select count(*),
         count(*) filter (where (private.billing_effective_access(s.tenant_id) ->> 'mode') is distinct from 'full'
                           and exists (select 1 from public.tenants t where t.id = s.tenant_id and t.deleted_at is null))
    into v_a, v_b from public.subscriptions s where s.protected;
  v_checks := v_checks || private.billing_check('protected_health', v_b = 0 and (p_expected_protected is null or p_expected_protected = v_a),
    jsonb_build_object('protected', v_a, 'not_full', v_b, 'expected', p_expected_protected));

  v_cnt := private.billing_enforcement_counters(v_cfg.stage, v_cfg.stage_changed_at);
  v_checks := v_checks || private.billing_check('counters_healthy',
    (v_cnt ->> 'guard_errors')::bigint = 0 and (v_cnt ->> 'policy_misses')::bigint = 0 and (v_cnt ->> 'unknown_category')::bigint = 0 and (v_cnt ->> 'protected_would_block')::bigint = 0,
    jsonb_build_object('guard_errors', v_cnt -> 'guard_errors', 'policy_misses', v_cnt -> 'policy_misses', 'unknown_category', v_cnt -> 'unknown_category',
                       'protected_would_block', v_cnt -> 'protected_would_block'));

  v_days := extract(epoch from (now() - v_cfg.stage_changed_at)) / 86400.0;
  v_checks := v_checks || private.billing_check('stage_requirements',
    p_target is null or p_target <= v_cfg.stage
    or (v_days >= v_req.min_dwell_days and (v_cnt ->> 'decisions')::bigint >= v_req.min_decisions),
    jsonb_build_object('days_in_stage', round(v_days, 2), 'required_days', v_req.min_dwell_days, 'decisions', v_cnt -> 'decisions', 'required_decisions', v_req.min_decisions,
                       'would_block', v_cnt -> 'would_block'));

  select coalesce(bool_and((c ->> 'pass')::boolean), false) into v_passed from jsonb_array_elements(v_checks) c;
  -- the hash covers ONLY the verdicts (id + pass), the target, the config version and the operator context: volatile values stay out so it is stable
  select jsonb_agg(jsonb_build_object('id', c ->> 'id', 'pass', (c ->> 'pass')::boolean) order by c ->> 'id') into v_slim from jsonb_array_elements(v_checks) c;
  v_hash := encode(sha256(convert_to(jsonb_build_object('target', p_target, 'version', v_cfg.version, 'checks', v_slim,
                                      'expectedProtected', p_expected_protected, 'appSha', p_app_sha)::text, 'UTF8')), 'hex');
  return jsonb_build_object('targetStage', p_target, 'currentStage', v_cfg.stage, 'configVersion', v_cfg.version, 'checks', v_checks, 'passed', v_passed, 'hash', v_hash,
                            'context', jsonb_build_object('expectedProtected', p_expected_protected, 'appSha', p_app_sha), 'counters', v_cnt);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 7. exposure: private helpers, closed to every API role (they run inside the definer functions and triggers that call them)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
revoke all on function private.billing_scope_tenant(text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.billing_health_bump(text) from public, anon, authenticated, service_role;
revoke all on function private.billing_decision_record(uuid, smallint, integer, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.billing_guard(text, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.billing_public_booking_open(uuid) from public, anon, authenticated, service_role;
revoke all on function private.billing_hook_coverage() from public, anon, authenticated, service_role;
