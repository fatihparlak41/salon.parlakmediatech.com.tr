import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getCalendarItems, getBranchStaff, getTenantTimezone } from "@/lib/modules/appointments/queries";
import { getBranchOptions } from "@/lib/modules/staff/queries";
import { getTenantTodayRangeUtc } from "@/lib/modules/appointments/timezone";
import { CalendarPageClient } from "@/components/calendar/calendar-page-client";

export default async function CalendarPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]/calendar">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const [canView, canCreate, canUpdate, canCancel] = await Promise.all([
    hasPermission(access.tenant.id, "appointments.view"),
    hasPermission(access.tenant.id, "appointments.create"),
    hasPermission(access.tenant.id, "appointments.update"),
    hasPermission(access.tenant.id, "appointments.cancel"),
  ]);

  if (!canView) {
    redirect(`/app/${tenantSlug}`);
  }

  const [tenantTimezone, branches] = await Promise.all([
    getTenantTimezone(access.tenant.id),
    getBranchOptions(access.tenant.id),
  ]);

  // getBranchOptions already orders primary-branch-first, then
  // alphabetically — the natural default when a tenant has more than
  // one. The branch selector stays visible/switchable whenever
  // branches.length > 1 (see CalendarPageClient), satisfying "require/
  // show a clear branch selection" without starting on an empty calendar.
  const initialBranchId = branches[0]?.id ?? "";
  const { today, startUtc, endUtc } = getTenantTodayRangeUtc(tenantTimezone);

  const [initialItems, initialStaff] = initialBranchId
    ? await Promise.all([
        getCalendarItems(access.tenant.id, initialBranchId, startUtc, endUtc),
        getBranchStaff(access.tenant.id, initialBranchId),
      ])
    : [[], []];

  const t = await getTranslations("Calendar");

  return (
    <CalendarPageClient
      tenantId={access.tenant.id}
      tenantSlug={tenantSlug}
      tenantTimezone={tenantTimezone}
      branches={branches}
      initialBranchId={initialBranchId}
      initialDate={today}
      initialStaff={initialStaff}
      initialItems={initialItems}
      canCreate={canCreate}
      canUpdate={canUpdate}
      canCancel={canCancel}
      labels={{
        title: t("title"),
        description: t("description"),
        addAppointment: t("addAppointment"),
        today: t("today"),
        dayView: t("dayView"),
        weekView: t("weekView"),
        noBranchStaff: t("noBranchStaff"),
        noItems: t("noItems"),
        selectBranch: t("selectBranch"),
        selectStaffForWeek: t("selectStaffForWeek"),
        noBranches: t("noBranches"),
      }}
    />
  );
}
