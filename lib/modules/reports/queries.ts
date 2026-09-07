import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { StaffPerformanceSummaryInput } from "./schemas";

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
