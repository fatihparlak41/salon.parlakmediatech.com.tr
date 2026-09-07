-- Faz 5A.1A — security hardening correction to Faz 5A.1
-- (20260905090000_personnel_performance_foundation.sql). That migration
-- is already applied to shared DEV and recorded in migration history —
-- it is NOT rewritten here; this corrects it forward instead.
--
-- ===================================================================
-- ISSUE FOUND
-- ===================================================================
-- The two reports.staff-based SELECT policies Faz 5A.1 added
-- (appointments_select_reports_staff, appointment_items_select_reports_staff)
-- granted GENERAL, UNRESTRICTED direct table access to anyone holding
-- reports.staff — not merely access to a curated personnel-performance
-- report. That is a real overreach: appointment_items carries `price`
-- (financial data Phase 5A explicitly excludes) and other fields with
-- no place in a personnel-performance surface, and appointments carries
-- operational/customer identifiers beyond what reporting needs.
-- reports.staff must authorize reading THE REPORT, never the raw
-- tables. Both dropped policies below are purely subtractive — the
-- pre-existing appointments.view-gated policies from 20260819052514 are
-- completely untouched, so nobody who could already read these tables
-- loses any access whatsoever.
drop policy "appointments_select_reports_staff" on public.appointments;
drop policy "appointment_items_select_reports_staff" on public.appointment_items;

-- ===================================================================
-- WHY THE VIEW MOVES TOO
-- ===================================================================
-- public.appointment_item_performance (Faz 5A.1) relied on
-- security_invoker=true to forward RLS to the calling user — which was
-- exactly why it needed the two policies just dropped: without them, a
-- reports.staff-only caller satisfies neither appointments.view nor (now)
-- anything else, so the view would return zero rows for the one
-- audience it exists to serve. A public, client-granted,
-- security_invoker view CANNOT be the authorization mechanism once
-- reports.staff no longer has base-table SELECT access — those two
-- facts are in direct tension, and the correct resolution is to stop
-- treating the view as a client-facing object at all.
--
-- FIX: drop the public view; recreate the identical correctness
-- relation as a PRIVATE-schema view instead. private is not in the
-- exposed API schema list and carries zero grant to any client role at
-- the SCHEMA level (`revoke all on schema private from public, anon,
-- authenticated`, 20260815120014) — nothing in `private` is reachable by
-- a client no matter what a view inside it does or doesn't set for
-- security_invoker, the same way private.has_permission/log_audit_event/
-- validate_and_insert_appointment_item etc. are already reachable only
-- from inside another trusted, already-permission-checked function, never
-- directly. No RPC is added here: Faz 5A.1 does not need one yet (no
-- dashboard exists until Faz 5A.3), and building one now would be
-- exactly the kind of broad SECURITY DEFINER read endpoint this
-- correction exists to avoid building prematurely.
--
-- IMPORTANT — tenant-scoping is no longer automatic for this relation.
-- A public, security_invoker view got tenant isolation for free from the
-- caller's own RLS. This private view has NO RLS/security_invoker
-- protection of its own — a function that queries it runs as the
-- function's OWNER (full visibility across every tenant), so whatever
-- reads this view next (Faz 5A.3's own narrow report RPC) MUST
-- explicitly check private.has_permission(p_tenant_id, 'reports.staff')
-- AND filter `tenant_id = p_tenant_id` itself, exactly like every other
-- private.* function in this codebase already does its own scoping
-- rather than leaning on RLS. This is a hard requirement for Faz 5A.3,
-- written down here so it is not lost between phases.
drop view public.appointment_item_performance;

create view private.appointment_item_performance
as
select
  ai.id as appointment_item_id,
  ai.tenant_id,
  ai.appointment_id,
  a.branch_id,
  a.customer_id,
  ai.service_id,
  s.name as service_name,
  s.category as service_category,
  ai.staff_member_id,
  sm.full_name as staff_member_name,
  ai.actual_staff_member_id,
  asm.full_name as actual_staff_member_name,
  coalesce(ai.actual_staff_member_id, ai.staff_member_id) as effective_performer_id,
  coalesce(asm.full_name, sm.full_name) as effective_performer_name,
  ai.appointment_status,
  ai.scheduled_start_at,
  ai.scheduled_end_at,
  ai.duration_minutes
from public.appointment_items ai
join public.appointments a on a.id = ai.appointment_id
left join public.services s on s.id = ai.service_id
left join public.staff_members sm on sm.id = ai.staff_member_id
left join public.staff_members asm on asm.id = ai.actual_staff_member_id;

comment on view private.appointment_item_performance is
  'Faz 5A.1A — moved from public.appointment_item_performance (Faz 5A.1) because a public, granted, security_invoker view cannot be the authorization boundary once reports.staff has no base-table SELECT access. No RLS/security_invoker protection of its own: reachable only from inside a SECURITY DEFINER function, which MUST explicitly check has_permission(p_tenant_id, ''reports.staff'') and filter tenant_id = p_tenant_id itself before reading this view (Faz 5A.3''s job — not built yet). Still no price/revenue (Phase 5A excludes financial performance) and no customer PII beyond the opaque customer_id.';

-- Redundant with the schema-level lockdown above (a view never auto-grants
-- to PUBLIC either), kept explicit to match this codebase's own
-- established style of never relying on an implicit default alone for a
-- protected object, and so the intent is unmistakable to any future
-- reader/auditor.
revoke select on private.appointment_item_performance from public, anon, authenticated;
