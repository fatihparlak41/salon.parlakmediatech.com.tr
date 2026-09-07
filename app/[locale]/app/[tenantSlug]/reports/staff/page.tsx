import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getTenantTimezone } from "@/lib/modules/appointments/queries";
import { getBranchOptions, getServiceOptions, getStaffList } from "@/lib/modules/staff/queries";
import {
  getStaffPerformanceSummary,
  getStaffUtilization,
  resolveReportsDateRangeUtc,
  mergeStaffReportData,
} from "@/lib/modules/reports/queries";
import { parseReportsStaffFilters } from "@/lib/modules/reports/schemas";
import { ReportsStaffPageClient } from "@/components/reports/reports-staff-page-client";

/**
 * Faz 5A.3C. Server Component: resolves access + filters (from the URL —
 * see lib/modules/reports/schemas.ts's parseReportsStaffFilters), fetches
 * filter-option lists via the existing safe staff-module lookup queries,
 * calls ONLY the two approved reporting RPCs (get_staff_performance_summary,
 * get_staff_utilization — never raw appointments/appointment_items/
 * customers/staff_schedules/staff_schedule_exceptions), and merges their
 * results into one view model. All interactivity (filter controls,
 * table/card rendering) lives in the Client Component this hands off to;
 * this file does no client-side data fetching of its own.
 */
export default async function ReportsStaffPage({
  params,
  searchParams,
}: PageProps<"/[locale]/app/[tenantSlug]/reports/staff">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const canView = await hasPermission(access.tenant.id, "reports.staff");
  // Nav already hides this link without reports.staff (see the tenant
  // layout) — a direct hit still gets bounced, same pattern as every
  // other tenant-app page. Never render report content and hide it
  // client-side.
  if (!canView) {
    redirect(`/app/${tenantSlug}`);
  }

  const rawSearchParams = (await searchParams) as Record<string, string | string[] | undefined>;
  const filters = parseReportsStaffFilters(rawSearchParams);

  const [tenantTz, branches, services, staffList] = await Promise.all([
    getTenantTimezone(access.tenant.id),
    getBranchOptions(access.tenant.id),
    getServiceOptions(access.tenant.id),
    getStaffList(access.tenant.id),
  ]);

  const { startAt, endAt } = resolveReportsDateRangeUtc(filters, tenantTz);

  const [summaryResult, utilizationResult] = await Promise.all([
    getStaffPerformanceSummary({
      tenantId: access.tenant.id,
      startAt,
      endAt,
      branchId: filters.branchId ?? undefined,
      staffIds: filters.staffIds.length ? filters.staffIds : undefined,
      serviceIds: filters.serviceIds.length ? filters.serviceIds : undefined,
    }),
    getStaffUtilization({
      tenantId: access.tenant.id,
      startAt,
      endAt,
      branchId: filters.branchId ?? undefined,
      staffIds: filters.staffIds.length ? filters.staffIds : undefined,
      // Deliberately no serviceIds: get_staff_utilization has no service
      // filter parameter at all (see the 5A.3B migration's own header
      // comment) — a service-filtered numerator over a staff-wide
      // capacity denominator would be misleading. The client surfaces
      // this via filters.serviceFilterHelper rather than hiding it.
    }),
  ]);

  const t = await getTranslations("Reports.staff");

  const hasError = !!summaryResult.error || !!utilizationResult.error || !summaryResult.data || !utilizationResult.data;
  const reportData =
    !hasError && summaryResult.data && utilizationResult.data
      ? mergeStaffReportData(summaryResult.data, utilizationResult.data)
      : null;

  return (
    <ReportsStaffPageClient
      filters={filters}
      branches={branches}
      services={services}
      staffOptions={staffList.map((s) => ({ id: s.id, fullName: s.fullName, status: s.status }))}
      reportData={reportData}
      hasError={hasError}
      labels={{
        title: t("title"),
        description: t("description"),
        filters: {
          dateLabel: t("filters.dateLabel"),
          branchLabel: t("filters.branchLabel"),
          staffLabel: t("filters.staffLabel"),
          serviceLabel: t("filters.serviceLabel"),
          rangeToday: t("filters.rangeToday"),
          rangeWeek: t("filters.rangeWeek"),
          rangeMonth: t("filters.rangeMonth"),
          rangeLast30: t("filters.rangeLast30"),
          rangeCustom: t("filters.rangeCustom"),
          customStartLabel: t("filters.customStartLabel"),
          customEndLabel: t("filters.customEndLabel"),
          allBranches: t("filters.allBranches"),
          allStaffPlaceholder: t("filters.allStaffPlaceholder"),
          allServicesPlaceholder: t("filters.allServicesPlaceholder"),
          staffSelectedCountTemplate: t("filters.staffSelectedCount", { count: "{count}" }),
          serviceSelectedCountTemplate: t("filters.serviceSelectedCount", { count: "{count}" }),
          serviceFilterHelper: t("filters.serviceFilterHelper"),
        },
        summary: {
          completedServiceItems: t("summary.completedServiceItems"),
          uniqueCustomers: t("summary.uniqueCustomers"),
          newCustomers: t("summary.newCustomers"),
          returningCustomersSuffix: t("summary.returningCustomersSuffix"),
          utilization: t("summary.utilization"),
        },
        table: {
          staffColumn: t("table.staffColumn"),
          completedServiceItemsColumn: t("table.completedServiceItemsColumn"),
          customersColumn: t("table.customersColumn"),
          customersBreakdownTemplate: t("table.customersBreakdown", { newCount: "{newCount}", returningCount: "{returningCount}" }),
          completedMinutesColumn: t("table.completedMinutesColumn"),
          utilizationColumn: t("table.utilizationColumn"),
          cancelledColumn: t("table.cancelledColumn"),
          noShowColumn: t("table.noShowColumn"),
          serviceMixColumn: t("table.serviceMixColumn"),
          serviceMixMoreTemplate: t("table.serviceMixMore", { count: "{count}" }),
        },
        utilization: {
          unavailable: t("utilization.unavailable"),
          noScheduleHelper: t("utilization.noScheduleHelper"),
          tooltip: t("utilization.tooltip"),
        },
        emptyFiltered: {
          title: t("emptyFiltered.title"),
          description: t("emptyFiltered.description"),
        },
        error: {
          title: t("error.title"),
          description: t("error.description"),
        },
        minutesFormatTemplate: t("minutesFormat", { hours: "{hours}", minutes: "{minutes}" }),
      }}
    />
  );
}
