import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import {
  getSelfServicePolicy,
  getOnlineBookingEnabled,
  getCustomerNotificationSettings,
  getCustomerNotificationHealth,
} from "@/lib/modules/settings/queries";
import { getOwnerManagedBranches } from "@/lib/modules/branches/queries";
import { SelfServicePolicyForm } from "@/components/settings/self-service-policy-form";
import { OnlineBookingToggle } from "@/components/settings/online-booking-toggle";
import { BranchContactForm } from "@/components/settings/branch-contact-form";
import { CustomerNotificationSettings } from "@/components/settings/customer-notification-settings";

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

  const [policy, onlineBookingEnabled, branches, notificationSettings, notificationHealth] = await Promise.all([
    getSelfServicePolicy(access.tenant.id),
    getOnlineBookingEnabled(access.tenant.id),
    getOwnerManagedBranches(access.tenant.id),
    getCustomerNotificationSettings(access.tenant.id),
    getCustomerNotificationHealth(access.tenant.id),
  ]);
  const t = await getTranslations("Settings");
  const canViewFinance = await hasPermission(access.tenant.id, "finance.view");

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      {/* RC.1C: one place that says where the other things live (salon details, commission, personal notifications). */}
      <nav aria-label="Diğer ayarlar" className="flex flex-col divide-y rounded-lg border text-sm">
        <Link href={`/app/${tenantSlug}/setup`} className="flex flex-col gap-0.5 p-3 hover:bg-muted/50">
          <span className="font-medium">Salon bilgileri ve kurulum rehberi</span>
          <span className="text-muted-foreground text-xs">Salon adı, telefon, saat dilimi, hizmetler, personel ve çalışma saatleri.</span>
        </Link>
        {canViewFinance ? (
          <Link href={`/app/${tenantSlug}/finance/commission`} className="flex flex-col gap-0.5 p-3 hover:bg-muted/50">
            <span className="font-medium">Komisyon (personel primleri)</span>
            <span className="text-muted-foreground text-xs">Tamamlanan hizmetlerden doğan komisyonu görün, kural tanımlayın.</span>
          </Link>
        ) : null}
        <Link href={`/app/${tenantSlug}/account#notifications`} className="flex flex-col gap-0.5 p-3 hover:bg-muted/50">
          <span className="font-medium">Hesabım ve kişisel bildirimler</span>
          <span className="text-muted-foreground text-xs">Adınız, şifreniz ve bu cihazdaki bildirimler.</span>
        </Link>
      </nav>
      <OnlineBookingToggle
        tenantId={access.tenant.id}
        tenantSlug={tenantSlug}
        initialEnabled={onlineBookingEnabled}
      />
      <SelfServicePolicyForm
        tenantId={access.tenant.id}
        tenantSlug={tenantSlug}
        initialPolicy={policy}
      />
      <CustomerNotificationSettings
        tenantId={access.tenant.id}
        tenantSlug={tenantSlug}
        initialSettings={notificationSettings}
        health={notificationHealth}
      />
      {branches.length > 0 && <BranchContactForm tenantSlug={tenantSlug} branches={branches} />}
    </div>
  );
}
