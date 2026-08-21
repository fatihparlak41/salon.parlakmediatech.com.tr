import "server-only";
import { createClient } from "@/lib/supabase/server";
import { APPOINTMENTS_PAGE_SIZE } from "./constants";

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

const LIST_SELECT = `
  id, status, scheduled_start_at, scheduled_end_at,
  customers(full_name),
  branches(name),
  appointment_items(services(name), staff_members(full_name))
`;

type RawAppointmentRow = {
  id: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  customers: { full_name: string } | null;
  branches: { name: string } | null;
  appointment_items: { services: { name: string } | null; staff_members: { full_name: string } | null }[];
};

function mapListRow(r: RawAppointmentRow): AppointmentListRow {
  return {
    id: r.id,
    status: r.status,
    scheduledStartAt: r.scheduled_start_at,
    scheduledEndAt: r.scheduled_end_at,
    customerName: r.customers?.full_name ?? "—",
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
  return (data as unknown as RawAppointmentRow[]).map(mapListRow);
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
  notes: string | null;
  createdAt: string;
  customer: { id: string; fullName: string };
  branch: { id: string; name: string };
  items: {
    id: string;
    sequence: number;
    scheduledStartAt: string;
    scheduledEndAt: string;
    durationMinutes: number;
    price: string;
    service: { id: string; name: string };
    staffMember: { id: string; fullName: string };
  }[];
};

export async function getAppointmentDetail(appointmentId: string): Promise<AppointmentDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointments")
    .select(
      `id, status, scheduled_start_at, scheduled_end_at, notes, created_at,
       customers(id, full_name), branches(id, name),
       appointment_items(id, sequence, scheduled_start_at, scheduled_end_at, duration_minutes, price,
         services(id, name), staff_members(id, full_name))`,
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (error || !data) return null;
  const d = data as unknown as {
    id: string;
    status: string;
    scheduled_start_at: string;
    scheduled_end_at: string;
    notes: string | null;
    created_at: string;
    customers: { id: string; full_name: string } | null;
    branches: { id: string; name: string } | null;
    appointment_items: {
      id: string;
      sequence: number;
      scheduled_start_at: string;
      scheduled_end_at: string;
      duration_minutes: number;
      price: string;
      services: { id: string; name: string } | null;
      staff_members: { id: string; full_name: string } | null;
    }[];
  };

  if (!d.customers || !d.branches) return null;

  return {
    id: d.id,
    status: d.status,
    scheduledStartAt: d.scheduled_start_at,
    scheduledEndAt: d.scheduled_end_at,
    notes: d.notes,
    createdAt: d.created_at,
    customer: { id: d.customers.id, fullName: d.customers.full_name },
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
        price: String(i.price),
        service: { id: i.services!.id, name: i.services!.name },
        staffMember: { id: i.staff_members!.id, fullName: i.staff_members!.full_name },
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
