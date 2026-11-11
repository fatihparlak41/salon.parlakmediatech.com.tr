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
import { createClient } from "@/lib/supabase/server";
import { getMyBillingSummary } from "@/lib/modules/billing/queries";
import { staffLimitHint } from "@/lib/modules/billing/model";
import { StaffLimitHint } from "@/components/billing/billing-views";

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

  const [staff, branches, services, memberships, billingSummary] = await Promise.all([
    getStaffList(access.tenant.id),
    getBranchOptions(access.tenant.id),
    getServiceOptions(access.tenant.id),
    canManage ? getAvailableMemberships(access.tenant.id) : Promise.resolve([]),
    // Faz SAAS.1C.1 - the soft active-staff limit is a HINT only: it never blocks adding staff. Only a staff manager is asked.
    canManage ? createClient().then((c) => getMyBillingSummary(c, access.tenant.id)) : Promise.resolve(null),
  ]);
  const limitHint = staffLimitHint(billingSummary?.limits);

  const t = await getTranslations("Staff");
  const tBilling = await getTranslations("Billing");

  return (
    <div className="flex flex-col gap-4">
      {limitHint ? (
        <StaffLimitHint
          text={limitHint.state === "over" ? tBilling("staffLimit.over", { used: limitHint.used, limit: limitHint.limit }) : tBilling("staffLimit.at", { limit: limitHint.limit })}
        />
      ) : null}
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
    </div>
  );
}
