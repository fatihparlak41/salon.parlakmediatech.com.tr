import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getServiceList, getExistingCategories, getStaffOptions } from "@/lib/modules/services/queries";
import { getBranchOptions } from "@/lib/modules/staff/queries";
import { ServicesPageClient } from "@/components/services/services-page-client";

export default async function ServicesPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]/services">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const [canView, canManage, canManageStaffEligibility] = await Promise.all([
    hasPermission(access.tenant.id, "services.view"),
    hasPermission(access.tenant.id, "services.manage"),
    // staff_services (who can perform this service) is RLS-gated on
    // staff.manage, not services.manage (20260819052413) — a separate
    // permission from everything else on this page, so it needs its own
    // check rather than reusing `canManage`.
    hasPermission(access.tenant.id, "staff.manage"),
  ]);

  if (!canView) {
    redirect(`/app/${tenantSlug}`);
  }

  const [services, branches, categories, staff] = await Promise.all([
    getServiceList(access.tenant.id),
    getBranchOptions(access.tenant.id),
    getExistingCategories(access.tenant.id),
    getStaffOptions(access.tenant.id),
  ]);

  const t = await getTranslations("Services");

  return (
    <ServicesPageClient
      tenantId={access.tenant.id}
      tenantSlug={tenantSlug}
      canManage={canManage}
      canManageStaffEligibility={canManageStaffEligibility}
      initialServices={services}
      branches={branches}
      existingCategories={categories}
      staffOptions={staff}
      labels={{
        title: t("title"),
        description: t("description"),
        addService: t("addService"),
        searchPlaceholder: t("searchPlaceholder"),
        emptyTitle: t("emptyTitle"),
        emptyDescription: t("emptyDescription"),
        emptyCta: t("emptyCta"),
        noResults: t("noResults"),
        countLabel: t("countLabel"),
        activeCountLabel: t("activeCountLabel"),
        noBranchWarning: t("noBranchWarning"),
      }}
    />
  );
}
