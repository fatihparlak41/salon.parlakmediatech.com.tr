import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getSiteUrl } from "@/lib/site-url";
import { formatTenantLocalDateTime } from "@/lib/modules/appointments/timezone";
import { publicBookingUrl } from "@/lib/modules/onboarding/model";
import { getOnboardingStatus, getOnboardingWorkspace } from "@/lib/modules/onboarding/queries";
import { SetupWizard } from "@/components/onboarding/setup-wizard";

/**
 * Faz LAUNCH.1C — guided setup. Opt-in: nothing links an already configured salon here, and the page never writes on
 * load. Every fact shown (which step is done, whether the salon is ready) comes from the one database read model.
 */
export default async function SetupPage({ params }: PageProps<"/[locale]/app/[tenantSlug]/setup">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;
  const tenantId = access.tenant.id;

  const [canSettings, canServices, canStaff, canSchedules] = await Promise.all([
    hasPermission(tenantId, "settings.manage"),
    hasPermission(tenantId, "services.manage"),
    hasPermission(tenantId, "staff.manage"),
    hasPermission(tenantId, "schedules.manage"),
  ]);
  if (!canSettings && !canServices && !canStaff) {
    redirect(`/app/${tenantSlug}`);
  }

  const t = await getTranslations("Setup");
  const [status, workspace] = await Promise.all([getOnboardingStatus(tenantId), getOnboardingWorkspace(tenantId)]);

  if (!status) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <p className="text-muted-foreground text-sm" role="alert">
          {t("unknown")}
        </p>
      </div>
    );
  }

  return (
    <SetupWizard
      tenantId={tenantId}
      tenantSlug={tenantSlug}
      bookingUrl={publicBookingUrl(getSiteUrl(), status.tenantSlug)}
      dashboardHref={`/app/${tenantSlug}`}
      initialStatus={status}
      workspace={workspace}
      firstSlotLabel={status.firstAvailableSlotAt ? formatTenantLocalDateTime(status.firstAvailableSlotAt, status.profile.timezone) : null}
      can={{
        profile: canSettings,
        services: canServices,
        staff: canStaff,
        hours: canStaff && canSchedules,
        booking: canSettings,
      }}
    />
  );
}
