import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getAppointmentList, getTenantTimezone } from "@/lib/modules/appointments/queries";
import { getBranchOptions } from "@/lib/modules/staff/queries";
import { AppointmentsPageClient } from "@/components/appointments/appointments-page-client";

export default async function AppointmentsPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]/appointments">) {
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

  const [initialAppointments, tenantTimezone, branches] = await Promise.all([
    getAppointmentList(access.tenant.id, "upcoming", null, 0),
    getTenantTimezone(access.tenant.id),
    getBranchOptions(access.tenant.id),
  ]);

  const t = await getTranslations("Appointments");

  return (
    <AppointmentsPageClient
      tenantId={access.tenant.id}
      tenantSlug={tenantSlug}
      tenantTimezone={tenantTimezone}
      branches={branches}
      canCreate={canCreate}
      canUpdate={canUpdate}
      canCancel={canCancel}
      initialAppointments={initialAppointments}
      labels={{
        title: t("title"),
        description: t("description"),
        addAppointment: t("addAppointment"),
        emptyTitle: t("emptyTitle"),
        emptyDescription: t("emptyDescription"),
        emptyCta: t("emptyCta"),
        noResults: t("noResults"),
        loadMore: t("loadMore"),
        filterUpcoming: t("filterUpcoming"),
        filterToday: t("filterToday"),
        filterAll: t("filterAll"),
        statusFilterAll: t("statusFilterAll"),
      }}
    />
  );
}
