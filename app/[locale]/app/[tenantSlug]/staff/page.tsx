import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import {
  getStaffList,
  getBranchOptions,
  getServiceOptions,
  getAvailableMemberships,
} from "@/lib/modules/staff/queries";
import { StaffPageClient } from "@/components/staff/staff-page-client";

export default async function StaffPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]/staff">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const [canView, canManage] = await Promise.all([
    hasPermission(access.tenant.id, "staff.view"),
    hasPermission(access.tenant.id, "staff.manage"),
  ]);

  // Nav already hides this link without staff.view — a direct hit still
  // gets bounced. RLS (zero rows back, not an error) is the real boundary;
  // this just avoids showing an empty screen to someone who shouldn't be
  // here at all.
  if (!canView) {
    redirect(`/app/${tenantSlug}`);
  }

  const [staff, branches, services, memberships] = await Promise.all([
    getStaffList(access.tenant.id),
    getBranchOptions(access.tenant.id),
    getServiceOptions(access.tenant.id),
    canManage ? getAvailableMemberships(access.tenant.id) : Promise.resolve([]),
  ]);

  const t = await getTranslations("Staff");

  return (
    <StaffPageClient
      tenantId={access.tenant.id}
      tenantSlug={tenantSlug}
      canManage={canManage}
      initialStaff={staff}
      branches={branches}
      services={services}
      memberships={memberships}
      labels={{
        title: t("title"),
        description: t("description"),
        addStaff: t("addStaff"),
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
