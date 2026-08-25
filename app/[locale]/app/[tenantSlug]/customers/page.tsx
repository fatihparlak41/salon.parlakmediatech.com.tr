import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getInitialCustomers, getCustomerCounts } from "@/lib/modules/customers/queries";
import { CustomersPageClient } from "@/components/customers/customers-page-client";

export default async function CustomersPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]/customers">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const [canView, canManage, canLinkAccount] = await Promise.all([
    hasPermission(access.tenant.id, "customers.view"),
    // customers.create and customers.update are two separate permission
    // keys (no unified customers.manage) — but every role template that
    // holds either also holds both together (confirmed during 2C.1
    // inventory), so treating them as one "can manage" UI flag doesn't
    // create a mismatch like the Phase 2B staff-eligibility one did.
    // Archive/reactivate is a plain status UPDATE, gated by
    // customers.update, same as editing.
    hasPermission(access.tenant.id, "customers.update"),
    // Faz 2G.3.2 — deliberately its own permission, not folded into
    // canManage: linking grants account-history visibility and
    // potential cancel/reschedule authority, a materially different
    // capability from editing a phone field. Owner/Manager by default,
    // not Receptionist even though Receptionist holds customers.update.
    hasPermission(access.tenant.id, "customers.link_account"),
  ]);

  if (!canView) {
    redirect(`/app/${tenantSlug}`);
  }

  const [initialCustomers, counts] = await Promise.all([
    getInitialCustomers(access.tenant.id, "active"),
    getCustomerCounts(access.tenant.id),
  ]);

  const t = await getTranslations("Customers");

  return (
    <CustomersPageClient
      tenantId={access.tenant.id}
      tenantSlug={tenantSlug}
      canManage={canManage}
      canLinkAccount={canLinkAccount}
      initialCustomers={initialCustomers}
      initialCounts={counts}
      labels={{
        title: t("title"),
        description: t("description"),
        addCustomer: t("addCustomer"),
        searchPlaceholder: t("searchPlaceholder"),
        emptyTitle: t("emptyTitle"),
        emptyDescription: t("emptyDescription"),
        emptyCta: t("emptyCta"),
        noResults: t("noResults"),
        activeCountLabel: t("activeCountLabel"),
        archivedCountLabel: t("archivedCountLabel"),
        loadMore: t("loadMore"),
        filterActive: t("filterActive"),
        filterArchived: t("filterArchived"),
      }}
    />
  );
}
