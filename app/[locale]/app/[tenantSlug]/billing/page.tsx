import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getMyBillingSummary } from "@/lib/modules/billing/queries";
import { TenantPlanView } from "@/components/billing/billing-views";
import { loadBillingLabels } from "@/components/billing/labels";
import { tenantPlanLabels } from "@/components/billing/page-labels";

/**
 * "Plan ve kullanım" - the salon's own, READ-ONLY view of its plan, trial and usage. Owner / Yönetici only (settings.manage or staff.manage);
 * the database function public.get_my_billing_summary re-checks the same thing, so a direct hit by anyone else gets nothing. This page never
 * writes and nothing in the product is switched off because of what it shows (billing enforcement is OFF).
 */
export default async function BillingPage({ params }: PageProps<"/[locale]/app/[tenantSlug]/billing">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const [canSettings, canStaff] = await Promise.all([hasPermission(access.tenant.id, "settings.manage"), hasPermission(access.tenant.id, "staff.manage")]);
  if (!canSettings && !canStaff) redirect(`/app/${tenantSlug}`);

  const supabase = await createClient();
  const summary = await getMyBillingSummary(supabase, access.tenant.id);
  const t = await getTranslations("Billing");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("description")}</p>
      </div>
      {summary ? (
        <TenantPlanView
          planName={summary.planName}
          state={summary.accessState}
          usage={summary.usage}
          limits={summary.limits}
          labels={await loadBillingLabels("Billing")}
          t={await tenantPlanLabels(summary.accessState)}
        />
      ) : (
        <p className="text-muted-foreground text-sm">{t("unavailable")}</p>
      )}
    </div>
  );
}
