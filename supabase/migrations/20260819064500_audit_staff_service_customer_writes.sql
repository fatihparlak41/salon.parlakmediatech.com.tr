-- Phase 2A.1 review — audit strategy decision.
--
-- The original Phase 2 spec: "use the existing append-only audit log
-- architecture for staff/service/customer/appointment create/update/
-- reschedule/cancel/reassignment." Appointments already comply
-- (create_appointment/reschedule_appointment/update_appointment_status
-- each call private.log_audit_event — 20260819052733). staff_members/
-- services/customers did not: Phase 2A gave them direct RLS-gated table
-- grants with no RPC layer (deliberately — these are plain CRUD with no
-- invariant an RLS with-check can't already express, unlike appointments'
-- conflict/eligibility/working-hours rules), and log_audit_event is only
-- reachable from inside a SECURITY DEFINER function (authenticated has no
-- direct EXECUTE on it — 20260816090008) — so nothing was ever calling it
-- for these three tables.
--
-- Decision: audit via an AFTER INSERT OR UPDATE trigger, not by adding an
-- RPC layer. An RPC layer here would exist ONLY to get a privileged call
-- site for audit logging — it would add no validation an RLS with-check
-- doesn't already provide, which is exactly the premature-RPC /
-- unnecessary-abstraction Phase 2 explicitly warned against, and would
-- expand Phase 2A.1's scope into what Phase 2B's write architecture
-- should decide. A SECURITY DEFINER trigger function is the same
-- privilege-bridge pattern already used throughout this schema (every
-- RPC's private.* implementation) — here bridging a direct authenticated
-- table write to the one function that may write audit_logs, without
-- otherwise changing who can do what.
--
-- Scope, deliberately: staff_members/services/customers only — matching
-- the spec's literal list. staff_schedules/staff_schedule_exceptions/
-- staff_services/staff_branches/service_branches are lower-stakes,
-- higher-churn operational relationships (a schedule tweak, an
-- eligibility toggle) rather than the kind of "who changed this business
-- record and when" trail the spec is asking for; adding audit rows for
-- every one of those too, with no stated need, would be over-engineering
-- this pass rather than closing the gap it actually found.
--
-- No field-level "was this meaningful" filtering: every INSERT/UPDATE is
-- logged with the full before/after row via to_jsonb(old)/to_jsonb(new),
-- same shape as every existing log_audit_event call site. Simpler than
-- diffing columns, and matches how appointment mutations are already
-- audited (their trigger calls log a full jsonb snapshot too).

create or replace function private.audit_staff_member_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    perform private.log_audit_event(new.tenant_id, 'staff_member.created', 'staff_member', new.id, null, to_jsonb(new));
  else
    perform private.log_audit_event(new.tenant_id, 'staff_member.updated', 'staff_member', new.id, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$$;

create trigger audit_staff_member_change
  after insert or update on public.staff_members
  for each row execute function private.audit_staff_member_change();

create or replace function private.audit_service_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    perform private.log_audit_event(new.tenant_id, 'service.created', 'service', new.id, null, to_jsonb(new));
  else
    perform private.log_audit_event(new.tenant_id, 'service.updated', 'service', new.id, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$$;

create trigger audit_service_change
  after insert or update on public.services
  for each row execute function private.audit_service_change();

create or replace function private.audit_customer_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    perform private.log_audit_event(new.tenant_id, 'customer.created', 'customer', new.id, null, to_jsonb(new));
  else
    perform private.log_audit_event(new.tenant_id, 'customer.updated', 'customer', new.id, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$$;

create trigger audit_customer_change
  after insert or update on public.customers
  for each row execute function private.audit_customer_change();

revoke execute on function private.audit_staff_member_change() from public;
revoke execute on function private.audit_service_change() from public;
revoke execute on function private.audit_customer_change() from public;
