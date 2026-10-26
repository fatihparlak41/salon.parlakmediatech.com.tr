import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getAppointmentList, getTenantTimezone } from "@/lib/modules/appointments/queries";
import { getBranchOptions } from "@/lib/modules/staff/queries";
import { AppointmentsPageClient } from "@/components/appointments/appointments-page-client";
import { parseRebookParams } from "@/lib/modules/treatment-history/model";
import { createClient } from "@/lib/supabase/server";

export default async function AppointmentsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/app/[tenantSlug]/appointments">) {
  const { tenantSlug } = await params;
  // Faz BEAUTY.1B - quick rebook from a treatment: service/branch/staff preselected, never the customer, date or time.
  const rebook = parseRebookParams((await searchParams) as Record<string, string | string[] | undefined>);
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const [canView, canCreate, canUpdate, canCancel, canViewFinance, canManageFinance] = await Promise.all([
    hasPermission(access.tenant.id, "appointments.view"),
    hasPermission(access.tenant.id, "appointments.create"),
    hasPermission(access.tenant.id, "appointments.update"),
    hasPermission(access.tenant.id, "appointments.cancel"),
    hasPermission(access.tenant.id, "finance.view"),
    hasPermission(access.tenant.id, "finance.manage"),
  ]);

  if (!canView) {
    redirect(`/app/${tenantSlug}`);
  }

  // RC.1C: a quick rebook from a customer's own history arrives with that customer's id; she is looked up under the viewer's own
  // access (RLS), so a person the viewer cannot see simply is not preselected.
  let rebookCustomer: { id: string; fullName: string; phone: string | null; email: string | null } | null = null;
  if (canCreate && rebook?.customerId) {
    const supabase = await createClient();
    const { data } = await supabase.from("customers").select("id, full_name, phone, email").eq("id", rebook.customerId).eq("tenant_id", access.tenant.id).is("deleted_at", null).maybeSingle();
    if (data) rebookCustomer = { id: data.id, fullName: data.full_name, phone: data.phone, email: data.email };
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
      canViewFinance={canViewFinance}
      canManageFinance={canManageFinance}
      rebook={canCreate && rebook ? { ...rebook, customer: rebookCustomer ?? undefined } : null}
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
