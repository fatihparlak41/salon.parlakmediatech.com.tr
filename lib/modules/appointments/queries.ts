import "server-only";
import { createClient } from "@/lib/supabase/server";
import { APPOINTMENTS_PAGE_SIZE } from "./constants";
import { CUSTOMER_NAME_FALLBACK, getAppointmentCustomerNames } from "./customer-display";
import { getAppointmentPrivateDetails } from "./private-details";

export type AppointmentListRow = {
  id: string;
  status: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  customerName: string;
  branchName: string;
  serviceNames: string[];
  staffNames: string[];
};

export type AppointmentListScope = "upcoming" | "today" | "all";

// Faz 5A.1 added actual_staff_member_id (plus a composite tenant-safety
// FK) on appointment_items, both also pointing at staff_members — every
// staff_members(...) embed below now needs the explicit
// !appointment_items_staff_member_id_fkey hint, or PostgREST can no
// longer tell which of the now-three relationships to use and errors
// with "more than one relationship was found". These embeds are, and
// must remain, about the BOOKED staff only (staff_member_id) — actual
// performer has no display surface yet (Faz 5A.2).
//
// Faz SAAS.1E.1: the customer is NOT embedded here any more. The customers
// table is behind customers.view, which Personel deliberately lacks; the
// customer's display name comes from get_appointment_customer_display (one
// RPC per page of rows, appointments.view only, name and nothing else) —
// see customer-display.ts.
const LIST_SELECT = `
  id, status, scheduled_start_at, scheduled_end_at,
  branches(name),
  appointment_items(services(name), staff_members!appointment_items_staff_member_id_fkey(full_name))
`;

type RawAppointmentRow = {
  id: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  branches: { name: string } | null;
  appointment_items: { services: { name: string } | null; staff_members: { full_name: string } | null }[];
};

function mapListRow(r: RawAppointmentRow, customerNames: Map<string, string>): AppointmentListRow {
  return {
    id: r.id,
    status: r.status,
    scheduledStartAt: r.scheduled_start_at,
    scheduledEndAt: r.scheduled_end_at,
    customerName: customerNames.get(r.id) ?? CUSTOMER_NAME_FALLBACK,
    branchName: r.branches?.name ?? "—",
    serviceNames: Array.from(new Set(r.appointment_items.map((i) => i.services?.name).filter((n): n is string => !!n))),
    staffNames: Array.from(new Set(r.appointment_items.map((i) => i.staff_members?.full_name).filter((n): n is string => !!n))),
  };
}

export async function getAppointmentList(
  tenantId: string,
  scope: AppointmentListScope,
  statusFilter: string | null,
  offset: number,
  todayRangeUtc?: { start: string; end: string },
): Promise<AppointmentListRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from("appointments")
    .select(LIST_SELECT)
    .eq("tenant_id", tenantId)
    .range(offset, offset + APPOINTMENTS_PAGE_SIZE - 1);

  if (scope === "upcoming") {
    query = query.gte("scheduled_start_at", new Date().toISOString()).order("scheduled_start_at", { ascending: true });
  } else if (scope === "today" && todayRangeUtc) {
    query = query
      .gte("scheduled_start_at", todayRangeUtc.start)
      .lt("scheduled_start_at", todayRangeUtc.end)
      .order("scheduled_start_at", { ascending: true });
  } else {
    query = query.order("scheduled_start_at", { ascending: false });
  }

  if (statusFilter) {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query;
  if (error || !data) return [];
  const rows = data as unknown as RawAppointmentRow[];
  const customerNames = await getAppointmentCustomerNames(supabase, tenantId, rows.map((r) => r.id));
  return rows.map((r) => mapListRow(r, customerNames));
}

export async function getTenantTimezone(tenantId: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.from("tenants").select("timezone").eq("id", tenantId).maybeSingle();
  return data?.timezone ?? "Europe/Istanbul";
}

export type AppointmentDetail = {
  id: string;
  status: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  /** Null when there genuinely are no notes, AND when the caller lacks
   * appointments.update (Personel) — the two are indistinguishable on
   * purpose, through get_appointment_private_details (see private-details.ts). */
  notes: string | null;
  createdAt: string;
  /** The customer's id and DISPLAY NAME — read through
   * get_appointment_customer_display (appointments.view is enough; the
   * customers row itself, with its phone/e-mail/notes, stays behind
   * customers.view). Null only if that lookup yields nothing (failed
   * call); the detail view must still render, with the name degrading to
   * a placeholder, the same way calendar item blocks do (see
   * mapCalendarItemRow). */
  customer: { id: string; fullName: string } | null;
  branch: { id: string; name: string };
  items: {
    id: string;
    sequence: number;
    scheduledStartAt: string;
    scheduledEndAt: string;
    durationMinutes: number;
    /** Null for the same reason as notes above — price is appointments.update-only. */
    price: string | null;
    service: { id: string; name: string };
    staffMember: { id: string; fullName: string };
    /** Faz 5A.2 — null until the item is completed (or completed via the
     * legacy pre-5A.1 path, deliberately never backfilled). Display only:
     * never write this from a read. Render exactly like staffMember when
     * null or equal to it — only surface "Uygulayan" separately when it
     * genuinely differs (see appointment-detail-sheet.tsx). */
    actualStaffMember: { id: string; fullName: string } | null;
  }[];
};

export async function getAppointmentDetail(appointmentId: string): Promise<AppointmentDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointments")
    .select(
      // Faz 5A.2: a second, aliased embed of staff_members via the
      // actual_staff_member_id FK — same disambiguation requirement as
      // the booked-staff embed (see the Faz 5A.1 comment two lines
      // below), just a different relationship of the three now
      // available. actual_staff_members is nullable per row (LEFT-join
      // shaped by the FK itself being nullable) — a not-yet-completed or
      // legacy item correctly comes back null, never an error.
      //
      // Faz SAAS.1E.1: notes and appointment_items.price are NOT selected —
      // both are column-restricted to appointments.update holders only (not
      // Personel, who has appointments.view alone). They come from
      // get_appointment_private_details below, merged in.
      `id, tenant_id, customer_id, status, scheduled_start_at, scheduled_end_at, created_at,
       branches(id, name),
       appointment_items(id, sequence, scheduled_start_at, scheduled_end_at, duration_minutes,
         services(id, name), staff_members!appointment_items_staff_member_id_fkey(id, full_name),
         actual_staff_members:staff_members!appointment_items_actual_staff_member_id_fkey(id, full_name))`,
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (error || !data) return null;
  const d = data as unknown as {
    id: string;
    tenant_id: string;
    customer_id: string;
    status: string;
    scheduled_start_at: string;
    scheduled_end_at: string;
    created_at: string;
    branches: { id: string; name: string } | null;
    appointment_items: {
      id: string;
      sequence: number;
      scheduled_start_at: string;
      scheduled_end_at: string;
      duration_minutes: number;
      services: { id: string; name: string } | null;
      staff_members: { id: string; full_name: string } | null;
      actual_staff_members: { id: string; full_name: string } | null;
    }[];
  };

  if (!d.branches) return null;

  const [customerNames, privateDetails] = await Promise.all([
    getAppointmentCustomerNames(supabase, d.tenant_id, [d.id]),
    getAppointmentPrivateDetails(supabase, d.tenant_id, d.id),
  ]);
  const customerName = customerNames.get(d.id);

  return {
    id: d.id,
    status: d.status,
    scheduledStartAt: d.scheduled_start_at,
    scheduledEndAt: d.scheduled_end_at,
    notes: privateDetails.notes,
    createdAt: d.created_at,
    customer: customerName ? { id: d.customer_id, fullName: customerName } : null,
    branch: { id: d.branches.id, name: d.branches.name },
    items: d.appointment_items
      .filter((i) => i.services && i.staff_members)
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({
        id: i.id,
        sequence: i.sequence,
        scheduledStartAt: i.scheduled_start_at,
        scheduledEndAt: i.scheduled_end_at,
        durationMinutes: i.duration_minutes,
        price: privateDetails.prices.get(i.id) ?? null,
        service: { id: i.services!.id, name: i.services!.name },
        staffMember: { id: i.staff_members!.id, fullName: i.staff_members!.full_name },
        actualStaffMember: i.actual_staff_members ? { id: i.actual_staff_members.id, fullName: i.actual_staff_members.full_name } : null,
      })),
  };
}

export type ServiceForBranch = { id: string; name: string; durationMinutes: number; price: string };

/** Services actually offered at the given branch — a UX convenience
 * filter only. The create/reschedule RPC re-validates this itself
 * (service_branches) regardless of what the client sends. */
export async function getServicesForBranch(tenantId: string, branchId: string): Promise<ServiceForBranch[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("service_branches")
    .select("services!inner(id, name, duration_minutes, price, status, tenant_id, deleted_at)")
    .eq("branch_id", branchId);

  return (data ?? [])
    .map((r) => r.services)
    .filter((s): s is NonNullable<typeof s> => !!s && s.tenant_id === tenantId && s.status === "active" && !s.deleted_at)
    .map((s) => ({ id: s.id, name: s.name, durationMinutes: s.duration_minutes, price: String(s.price) }));
}

export type CalendarItemRow = {
  id: string;
  appointmentId: string;
  sequence: number;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status: string;
  serviceName: string;
  staffMemberId: string;
  staffMemberFullName: string;
  customerName: string;
};

// Faz SAAS.1E.1: the customer is no longer embedded (customers.view gate) —
// names come from get_appointment_customer_display, one RPC for the whole
// visible range (see customer-display.ts). Keep client-queries.ts's own
// CALENDAR_ITEM_SELECT identical.
const CALENDAR_ITEM_SELECT = `
  id, appointment_id, sequence, scheduled_start_at, scheduled_end_at, appointment_status,
  services(name),
  staff_members!appointment_items_staff_member_id_fkey(id, full_name),
  appointments!inner(branch_id)
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
  appointments: { branch_id: string } | null;
};

function mapCalendarItemRow(r: RawCalendarItemRow, customerNames: Map<string, string>): CalendarItemRow | null {
  if (!r.services || !r.staff_members || !r.appointments) return null;
  return {
    id: r.id,
    appointmentId: r.appointment_id,
    sequence: r.sequence,
    scheduledStartAt: r.scheduled_start_at,
    scheduledEndAt: r.scheduled_end_at,
    // appointment_items.appointment_status is a DB-trigger-synced copy of
    // the parent appointment's own status (see 20260819 appointment
    // engine — it exists so the no-overlap exclusion index can filter
    // cancelled/no_show without a cross-table lookup). Reading it here
    // avoids a redundant embed of appointments.status for the identical
    // value.
    status: r.appointment_status,
    serviceName: r.services.name,
    staffMemberId: r.staff_members.id,
    staffMemberFullName: r.staff_members.full_name,
    customerName: customerNames.get(r.appointment_id) ?? CUSTOMER_NAME_FALLBACK,
  };
}

/** Calendar range read — one query, overlap-correct (never a plain
 * BETWEEN: an item can start before the visible boundary and still
 * extend into it). Branch-scoped via an inner-join filter on the parent
 * appointment, since appointment_items itself carries no branch_id.
 * Returns everything a calendar block needs already joined — never one
 * query per visible item: services/staff_members are embedded in the one
 * range query, and the customers' display names arrive through ONE
 * get_appointment_customer_display call for the whole visible range
 * (Faz SAAS.1E.1 — appointments.view is enough, no customers.view). */
export async function getCalendarItems(
  tenantId: string,
  branchId: string,
  rangeStartUtc: string,
  rangeEndUtc: string,
): Promise<CalendarItemRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointment_items")
    .select(CALENDAR_ITEM_SELECT)
    .eq("tenant_id", tenantId)
    .eq("appointments.branch_id", branchId)
    // Cancelled items are hidden from the calendar by default: their
    // slot has already been released (Phase 2A cancellation behavior),
    // so displaying them prominently would misrepresent a staff member
    // as booked when they're actually free. They remain fully visible
    // (and filterable) in the existing /appointments list — nothing is
    // deleted, only omitted from this operational view. no_show stays
    // visible: unlike cancelled, it represents a slot the staff member
    // genuinely worked/was blocked for, which is real history for the day.
    .neq("appointment_status", "cancelled")
    .lt("scheduled_start_at", rangeEndUtc)
    .gt("scheduled_end_at", rangeStartUtc)
    .order("scheduled_start_at", { ascending: true });

  if (error || !data) return [];
  const rows = data as unknown as RawCalendarItemRow[];
  const customerNames = await getAppointmentCustomerNames(supabase, tenantId, rows.map((r) => r.appointment_id));
  return rows
    .map((r) => mapCalendarItemRow(r, customerNames))
    .filter((r): r is CalendarItemRow => r !== null);
}

export type CalendarStaffOption = { id: string; fullName: string };

/** Active staff assigned to the given branch — the calendar's day-view
 * columns / week-view staff filter. Independent of any service
 * eligibility (unlike getEligibleStaff below): the calendar shows every
 * staff member who works at this branch, regardless of what they
 * personally can perform. */
export async function getBranchStaff(tenantId: string, branchId: string): Promise<CalendarStaffOption[]> {
  const supabase = await createClient();
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

export type StaffForServiceAndBranch = { id: string; fullName: string };

/** Staff eligible for the given service AND assigned to the given branch
 * — same UX-convenience-only caveat as getServicesForBranch. */
export async function getEligibleStaff(
  tenantId: string,
  serviceId: string,
  branchId: string,
): Promise<StaffForServiceAndBranch[]> {
  const supabase = await createClient();
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
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null)
    .in("id", candidateIds);

  return (data ?? []).map((s) => ({ id: s.id, fullName: s.full_name }));
}
