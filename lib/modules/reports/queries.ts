import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  getTenantTodayRangeUtc,
  getTenantWeekRangeUtc,
  getTenantMonthRangeUtc,
  getTenantLastNDaysRangeUtc,
  getTenantDayRangeUtc,
} from "@/lib/modules/appointments/timezone";
import type { StaffPerformanceSummaryInput, StaffUtilizationInput, ReportsStaffFilters } from "./schemas";

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

/**
 * Faz 5A.3C — resolves a URL-derived ReportsStaffFilters + the tenant's
 * own timezone into the actual [startAt, endAt) UTC instants both RPCs
 * take. Pure date arithmetic, reusing the existing tenant-timezone
 * helpers exactly as-is — this function does NOT clip to now() itself;
 * that stays exclusively inside get_staff_utilization (see its migration
 * header comment), so getStaffPerformanceSummary and getStaffUtilization
 * are always called with the identical, unclipped [startAt, endAt) window
 * regardless of which one internally narrows it.
 */
export function resolveReportsDateRangeUtc(
  filters: ReportsStaffFilters,
  tenantTz: string,
): { startAt: string; endAt: string } {
  switch (filters.range) {
    case "custom": {
      // parseReportsStaffFilters already guarantees both are set and
      // start < end whenever range === "custom" survives parsing.
      const { startUtc } = getTenantDayRangeUtc(tenantTz, filters.customStart!);
      const { endUtc } = getTenantDayRangeUtc(tenantTz, filters.customEnd!); // inclusive end date
      return { startAt: startUtc, endAt: endUtc };
    }
    case "today": {
      const { startUtc, endUtc } = getTenantTodayRangeUtc(tenantTz);
      return { startAt: startUtc, endAt: endUtc };
    }
    case "week": {
      const { today } = getTenantTodayRangeUtc(tenantTz);
      const { startUtc, endUtc } = getTenantWeekRangeUtc(tenantTz, today);
      return { startAt: startUtc, endAt: endUtc };
    }
    case "last30": {
      const { startUtc, endUtc } = getTenantLastNDaysRangeUtc(tenantTz, 30);
      return { startAt: startUtc, endAt: endUtc };
    }
    case "month":
    default: {
      const { today } = getTenantTodayRangeUtc(tenantTz);
      const { startUtc, endUtc } = getTenantMonthRangeUtc(tenantTz, today);
      return { startAt: startUtc, endAt: endUtc };
    }
  }
}

/**
 * Faz 5A.3C — the one UI-facing view model this page needs: summary and
 * utilization staff rows merged by staffId. A genuine simplification, not
 * a duplicated contract — the two RPCs deliberately have DIFFERENT
 * population rules (summary: anyone with any appointment-item activity in
 * range; utilization: active roster ∪ historical completers — see each
 * migration's own header comment), so a staff member can legitimately
 * appear in only one side. Missing fields default to the same "no data"
 * values each RPC itself would show for that side (zero counts,
 * capacityMinutes=0/utilization=null). totals are taken directly from
 * each RPC's own independently-computed totals object — never re-derived
 * by summing the merged staff[] here, for the exact non-additivity
 * reasons documented in personnel-performance-reports.test.ts.
 */
export type StaffReportRow = {
  staffId: string;
  staffName: string;
  completedServiceItems: number;
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  completedMinutes: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  serviceMix: StaffPerformanceServiceMixRow[];
  concurrentCapacity: number;
  scheduledMinutes: number;
  capacityMinutes: number;
  utilizedMinutes: number;
  utilization: number | null;
};

export type StaffReportTotals = {
  completedServiceItems: number;
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  completedMinutes: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  utilization: number | null;
};

export type StaffReportData = {
  totals: StaffReportTotals;
  staff: StaffReportRow[];
};

function emptyPerformanceFields() {
  return {
    completedServiceItems: 0,
    uniqueCustomers: 0,
    newCustomers: 0,
    returningCustomers: 0,
    completedMinutes: 0,
    cancelledAppointments: 0,
    noShowAppointments: 0,
  };
}

function emptyUtilizationFields() {
  return {
    concurrentCapacity: 1,
    scheduledMinutes: 0,
    capacityMinutes: 0,
    utilizedMinutes: 0,
    utilization: null as number | null,
  };
}

export function mergeStaffReportData(
  summary: StaffPerformanceSummary,
  utilization: StaffUtilizationSummary,
): StaffReportData {
  const byId = new Map<string, StaffReportRow>();

  for (const s of summary.staff) {
    byId.set(s.staffId, {
      staffId: s.staffId,
      staffName: s.staffName,
      completedServiceItems: s.completedServiceItems,
      uniqueCustomers: s.uniqueCustomers,
      newCustomers: s.newCustomers,
      returningCustomers: s.returningCustomers,
      completedMinutes: s.completedMinutes,
      cancelledAppointments: s.cancelledAppointments,
      noShowAppointments: s.noShowAppointments,
      serviceMix: [],
      ...emptyUtilizationFields(),
    });
  }

  for (const u of utilization.staff) {
    const existing = byId.get(u.staffId);
    if (existing) {
      existing.concurrentCapacity = u.concurrentCapacity;
      existing.scheduledMinutes = u.scheduledMinutes;
      existing.capacityMinutes = u.capacityMinutes;
      existing.utilizedMinutes = u.utilizedMinutes;
      existing.utilization = u.utilization;
    } else {
      byId.set(u.staffId, {
        staffId: u.staffId,
        staffName: u.staffName,
        ...emptyPerformanceFields(),
        serviceMix: [],
        concurrentCapacity: u.concurrentCapacity,
        scheduledMinutes: u.scheduledMinutes,
        capacityMinutes: u.capacityMinutes,
        utilizedMinutes: u.utilizedMinutes,
        utilization: u.utilization,
      });
    }
  }

  for (const mix of summary.serviceMix) {
    const row = byId.get(mix.staffId);
    if (row) row.serviceMix.push(mix);
  }

  const staff = Array.from(byId.values()).sort((a, b) => a.staffName.localeCompare(b.staffName, "tr"));

  return {
    totals: {
      completedServiceItems: summary.totals.completedServiceItems,
      uniqueCustomers: summary.totals.uniqueCustomers,
      newCustomers: summary.totals.newCustomers,
      returningCustomers: summary.totals.returningCustomers,
      completedMinutes: summary.totals.completedMinutes,
      cancelledAppointments: summary.totals.cancelledAppointments,
      noShowAppointments: summary.totals.noShowAppointments,
      utilization: utilization.totals.utilization,
    },
    staff,
  };
}
