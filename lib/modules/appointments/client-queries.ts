/**
 * Browser-client versions of the branch-scoped lookups in queries.ts
 * (which is server-only and cannot be imported from client components).
 * Same query shape, same "UX convenience filter only" caveat — the
 * create/reschedule RPC re-validates all of this server-side regardless
 * of what the client sends. Shared here rather than duplicated per
 * component since appointment-items-editor.tsx and
 * create-appointment-sheet.tsx and appointment-detail-sheet.tsx all need
 * the identical shape.
 */
import { createClient } from "@/lib/supabase/client";
import type { ServiceForBranch, CalendarItemRow, CalendarStaffOption } from "./queries";

export async function fetchServicesForBranch(tenantId: string, branchId: string): Promise<ServiceForBranch[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("service_branches")
    .select("services!inner(id, name, duration_minutes, price, status, tenant_id, deleted_at)")
    .eq("branch_id", branchId);
  return (data ?? [])
    .map((r) => r.services)
    .filter((s): s is NonNullable<typeof s> => !!s && s.tenant_id === tenantId && s.status === "active" && !s.deleted_at)
    .map((s) => ({ id: s.id, name: s.name, durationMinutes: s.duration_minutes, price: String(s.price) }));
}

export type StaffOption = { id: string; fullName: string };

export async function fetchEligibleStaff(serviceId: string, branchId: string): Promise<StaffOption[]> {
  if (!serviceId || !branchId) return [];
  const supabase = createClient();
  const [eligibleRes, branchRes] = await Promise.all([
    supabase.from("staff_services").select("staff_member_id").eq("service_id", serviceId),
    supabase.from("staff_branches").select("staff_member_id").eq("branch_id", branchId),
  ]);
  const eligibleIds = new Set((eligibleRes.data ?? []).map((r) => r.staff_member_id));
  const branchIds = new Set((branchRes.data ?? []).map((r) => r.staff_member_id));
  const candidateIds = [...eligibleIds].filter((id) => branchIds.has(id));
  if (candidateIds.length === 0) return [];
  const { data } = await supabase
    .from("staff_members")
    .select("id, full_name")
    .eq("status", "active")
    .is("deleted_at", null)
    .in("id", candidateIds);
  return (data ?? []).map((s) => ({ id: s.id, fullName: s.full_name }));
}

// Faz 5A.1: staff_members!appointment_items_staff_member_id_fkey is
// required, not stylistic — appointment_items now has three
// relationships to staff_members (staff_member_id, plus
// actual_staff_member_id's plain and composite tenant-safety FKs), so an
// unqualified staff_members(...) embed is ambiguous to PostgREST. Mirror
// this exact hint in queries.ts's own CALENDAR_ITEM_SELECT if either
// ever changes — see that file's comment for the full explanation.
const CALENDAR_ITEM_SELECT = `
  id, appointment_id, sequence, scheduled_start_at, scheduled_end_at, appointment_status,
  services(name),
  staff_members!appointment_items_staff_member_id_fkey(id, full_name),
  appointments!inner(branch_id, customers(full_name))
`;

type RawCalendarItemRow = {
  id: string;
  appointment_id: string;
  sequence: number;
  scheduled_start_at: string;
  scheduled_end_at: string;
  appointment_status: string;
  services: { name: string } | null;
  staff_members: { id: string; full_name: string } | null;
  appointments: { branch_id: string; customers: { full_name: string } | null } | null;
};

function mapCalendarItemRow(r: RawCalendarItemRow): CalendarItemRow | null {
  if (!r.services || !r.staff_members || !r.appointments) return null;
  return {
    id: r.id,
    appointmentId: r.appointment_id,
    sequence: r.sequence,
    scheduledStartAt: r.scheduled_start_at,
    scheduledEndAt: r.scheduled_end_at,
    status: r.appointment_status,
    serviceName: r.services.name,
    staffMemberId: r.staff_members.id,
    staffMemberFullName: r.staff_members.full_name,
    customerName: r.appointments.customers?.full_name ?? "—",
  };
}

/** Client mirror of queries.ts's getCalendarItems — the calendar's own
 * range re-fetch after navigating day/week or after a create/reschedule/
 * cancel/status mutation, none of which reload the page. Same
 * overlap-correct range predicate, same single joined round trip. */
export async function fetchCalendarItems(
  tenantId: string,
  branchId: string,
  rangeStartUtc: string,
  rangeEndUtc: string,
): Promise<CalendarItemRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("appointment_items")
    .select(CALENDAR_ITEM_SELECT)
    .eq("tenant_id", tenantId)
    .eq("appointments.branch_id", branchId)
    // Cancelled items hidden by default — see the identical comment on
    // queries.ts's getCalendarItems for the full rationale.
    .neq("appointment_status", "cancelled")
    .lt("scheduled_start_at", rangeEndUtc)
    .gt("scheduled_end_at", rangeStartUtc)
    .order("scheduled_start_at", { ascending: true });

  if (error || !data) return [];
  return (data as unknown as RawCalendarItemRow[])
    .map(mapCalendarItemRow)
    .filter((r): r is CalendarItemRow => r !== null);
}

/** Client mirror of queries.ts's getBranchStaff — used when the operator
 * switches branch client-side without a page reload. */
export async function fetchBranchStaff(tenantId: string, branchId: string): Promise<CalendarStaffOption[]> {
  const supabase = createClient();
  const { data: links } = await supabase.from("staff_branches").select("staff_member_id").eq("branch_id", branchId);
  const staffIds = (links ?? []).map((l) => l.staff_member_id);
  if (staffIds.length === 0) return [];

  const { data } = await supabase
    .from("staff_members")
    .select("id, full_name")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null)
    .in("id", staffIds)
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });

  return (data ?? []).map((s) => ({ id: s.id, fullName: s.full_name }));
}

/**
 * Faz 5A.2 — the exact, documented "solo salon" condition: a plain,
 * unambiguous tenant-wide count of active, non-deleted staff_members.
 * Deliberately NOT scoped to a branch or service (a per-appointment
 * eligibility count could vary item-to-item within the same appointment,
 * which would make "is this solo" an inconsistent answer across its own
 * items) and deliberately NOT a heuristic over schedules/roles/logins —
 * a solo salon like Emel Beauty Bar has exactly one row here, full stop.
 * Used once per sheet-open (see appointment-detail-sheet.tsx) to decide
 * whether "Tamamlandı" completes immediately or opens the multi-staff
 * performer-correction panel.
 */
export async function fetchActiveStaffCount(tenantId: string): Promise<number> {
  const supabase = createClient();
  const { count } = await supabase
    .from("staff_members")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null);
  return count ?? 0;
}
