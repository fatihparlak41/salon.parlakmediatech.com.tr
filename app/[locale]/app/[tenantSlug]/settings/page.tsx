import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getSelfServicePolicy } from "@/lib/modules/settings/queries";
import { SelfServicePolicyForm } from "@/components/settings/self-service-policy-form";

export default async function SettingsPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]/settings">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  // Nav already hides this link without settings.manage — a direct hit
  // still gets bounced, same pattern as staff/page.tsx's canView gate.
  // There is no separate "view-only settings" permission in the catalog.
  const canManage = await hasPermission(access.tenant.id, "settings.manage");
  if (!canManage) {
    redirect(`/app/${tenantSlug}`);
  }

  const policy = await getSelfServicePolicy(access.tenant.id);
  const t = await getTranslations("Settings");

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <SelfServicePolicyForm
        tenantId={access.tenant.id}
        tenantSlug={tenantSlug}
        initialPolicy={policy}
      />
    </div>
  );
}
