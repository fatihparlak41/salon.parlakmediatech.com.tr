import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { StaffPerformanceSummaryInput, StaffUtilizationInput } from "./schemas";

/**
 * Faz 5A.3A — the smallest query layer needed to call
 * get_staff_performance_summary. No Server Action wrapper: this is a
 * pure read with no form/mutation behind it yet (there is no UI at all
 * in this batch) — same "plain async function, not an action" shape as
 * lib/modules/appointments/queries.ts's own read functions.
 *
 * Returns a {data, error} result rather than null-on-error (unlike
 * getAppointmentDetail) because a future caller genuinely needs to
 * distinguish RP002 (no permission) from RP003/RP004 (bad input) from a
 * plain network failure — collapsing all three to null would lose
 * exactly the distinction lib/modules/reports/error-codes.ts exists to
 * preserve.
 */

export type StaffPerformanceTotals = {
  completedServiceItems: number;
  completedAppointments: number;
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  completedMinutes: number;
  cancelledAppointments: number;
  noShowAppointments: number;
};

export type StaffPerformanceStaffRow = {
  staffId: string;
  staffName: string;
  completedServiceItems: number;
  completedAppointments: number;
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  completedMinutes: number;
  cancelledAppointments: number;
  noShowAppointments: number;
};

export type StaffPerformanceServiceMixRow = {
  staffId: string;
  staffName: string;
  serviceId: string;
  serviceName: string | null;
  serviceCategory: string | null;
  completedCount: number;
};

/** totals is independent of staff — see the migration's own header
 * comment. A multi-staff appointment or a customer served by two
 * different staff in-range legitimately makes sum(staff[].x) != totals.x
 * for the appointment/customer-count fields; that is correct, not a bug. */
export type StaffPerformanceSummary = {
  totals: StaffPerformanceTotals;
  staff: StaffPerformanceStaffRow[];
  serviceMix: StaffPerformanceServiceMixRow[];
};

export type ReportsRpcError = { code?: string; message: string };

export async function getStaffPerformanceSummary(
  input: StaffPerformanceSummaryInput,
): Promise<{ data: StaffPerformanceSummary; error: null } | { data: null; error: ReportsRpcError }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_staff_performance_summary", {
    p_tenant_id: input.tenantId,
    p_start_at: input.startAt,
    p_end_at: input.endAt,
    p_branch_id: input.branchId ?? null,
    p_staff_ids: input.staffIds ?? null,
    p_service_ids: input.serviceIds ?? null,
  });

  if (error || !data) {
    return { data: null, error: error ?? { message: "no data returned" } };
  }

  return { data: data as unknown as StaffPerformanceSummary, error: null };
}

/**
 * Faz 5A.3B — get_staff_utilization. A deliberately separate metric from
 * getStaffPerformanceSummary above, not an extension of it: population is
 * roster-plus-history rather than activity-driven (see the migration's
 * own header comment), and the numerator (utilizedMinutes) is an
 * elapsed-overlap calculation, never the full duration_minutes
 * completedMinutes uses — two different questions ("how much did this
 * person do" vs "how much of their available time was used") that only
 * look similar because they both read appointment_item_performance.
 */

/** utilization is a raw ratio (utilizedMinutes / capacityMinutes), not a
 * x100 percentage — null when capacityMinutes is 0, never capped above
 * 1.0. Matches Intl.NumberFormat's own {style:"percent"} input
 * convention, so a future UI can format it directly. */
export type StaffUtilizationTotals = {
  scheduledMinutes: number;
  capacityMinutes: number;
  utilizedMinutes: number;
  utilization: number | null;
};

export type StaffUtilizationStaffRow = {
  staffId: string;
  staffName: string;
  concurrentCapacity: number;
  scheduledMinutes: number;
  capacityMinutes: number;
  utilizedMinutes: number;
  utilization: number | null;
};

/** Unlike StaffPerformanceSummary's totals, these ARE the sum of staff[]
 * (scheduled/capacity/utilized minutes never fan out across performers
 * the way a shared customer or appointment can — a minute of one staff
 * member's own schedule is never simultaneously credited to another).
 * totals.utilization is still independently recomputed
 * (utilizedMinutes/capacityMinutes), never averaged from staff[]
 * percentages. */
export type StaffUtilizationSummary = {
  totals: StaffUtilizationTotals;
  staff: StaffUtilizationStaffRow[];
};

export async function getStaffUtilization(
  input: StaffUtilizationInput,
): Promise<{ data: StaffUtilizationSummary; error: null } | { data: null; error: ReportsRpcError }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_staff_utilization", {
    p_tenant_id: input.tenantId,
    p_start_at: input.startAt,
    p_end_at: input.endAt,
    p_branch_id: input.branchId ?? null,
    p_staff_ids: input.staffIds ?? null,
  });

  if (error || !data) {
    return { data: null, error: error ?? { message: "no data returned" } };
  }

  return { data: data as unknown as StaffUtilizationSummary, error: null };
}
