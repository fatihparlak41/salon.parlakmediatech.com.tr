import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getPublicBookingContext } from "@/lib/modules/public-booking/queries";
import { BookingWizard } from "@/components/public-booking/booking-wizard";
import { getCurrentUser } from "@/lib/auth/session";

/**
 * Public booking entry point — no auth, no tenant membership, no
 * TenantAppShell nav. Entirely separate from /app/[tenantSlug]. The
 * "unavailable" state below is deliberately generic and identical
 * whether the slug doesn't exist, the tenant is suspended, or
 * online_booking simply isn't enabled — see
 * private.resolve_bookable_tenant's own comment for why those three
 * cases must never be distinguishable from the outside.
 */
export default async function BookingPage({
  params,
}: PageProps<"/[locale]/book/[tenantSlug]">) {
  const { tenantSlug } = await params;
  const t = await getTranslations("PublicBooking");
  const context = await getPublicBookingContext(tenantSlug);
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  // Faz 2G.3.1 — display hint only, see booking-wizard.tsx's own comment
  // on the isAuthenticated prop for why this is safe to derive here and
  // pass through without being a trust boundary itself.
  const user = await getCurrentUser();

  // Fail closed, not open: Turnstile is the mandatory mutation control
  // (Phase 2F.2), not an optional enhancement — if the site key isn't
  // configured, the wizard must never render a checkout flow with no
  // working security check in front of it. Same generic screen as
  // "not bookable" (see the module comment above for why that's
  // intentionally indistinguishable from every other unavailable case).
  if (!context.bookable || !turnstileSiteKey) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-start justify-center px-6 py-16">
        <Badge variant="secondary">{tenantSlug}</Badge>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{t("unavailableTitle")}</h1>
        <p className="text-muted-foreground mt-2 text-sm">{t("unavailableBody")}</p>
        <Button render={<Link href="/" />} nativeButton={false} variant="outline" className="mt-6">
          {t("backHome")}
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen">
      {/* Faz 2G.3.2 — always-visible entry point into salon-assisted
          account linking, independent of wizard step/state. Points at
          the customer's OWN authenticated /account area; an
          unauthenticated visitor is sent through the normal login flow
          and returned here afterward (see that route's own header). */}
      <div className="mx-auto w-full max-w-md px-4 pt-4 sm:max-w-lg">
        <Button
          render={<Link href={`/account/link-salon/${tenantSlug}`} />}
          nativeButton={false}
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
        >
          {t("linkExistingRecord")}
        </Button>
      </div>
      <BookingWizard
        tenantSlug={tenantSlug}
        tenantName={context.salon.name}
        tenantTimezone={context.salon.timezone}
        branches={context.branches}
        turnstileSiteKey={turnstileSiteKey}
        isAuthenticated={!!user}
        labels={{
          unavailableTitle: t("unavailableTitle"),
          unavailableBody: t("unavailableBody"),
          backHome: t("backHome"),
          stepBranch: t("stepBranch"),
          stepService: t("stepService"),
          stepStaff: t("stepStaff"),
          stepDateTime: t("stepDateTime"),
          stepContact: t("stepContact"),
          chooseBranchTitle: t("chooseBranchTitle"),
          chooseServiceTitle: t("chooseServiceTitle"),
          chooseStaffTitle: t("chooseStaffTitle"),
          anyStaff: t("anyStaff"),
          chooseDateTitle: t("chooseDateTitle"),
          chooseTimeTitle: t("chooseTimeTitle"),
          noSlotsForDate: t("noSlotsForDate"),
          loadingSlots: t("loadingSlots"),
          minutesShort: t("minutesShort"),
          back: t("back"),
          next: t("next"),
          contactTitle: t("contactTitle"),
          fullNameLabel: t("fullNameLabel"),
          phoneLabel: t("phoneLabel"),
          emailLabel: t("emailLabel"),
          claimOptInLabel: t("claimOptInLabel"),
          claimPendingNote: t("claimPendingNote"),
          summaryTitle: t("summaryTitle"),
          summaryBranch: t("summaryBranch"),
          summaryService: t("summaryService"),
          summaryStaff: t("summaryStaff"),
          summaryDateTime: t("summaryDateTime"),
          summaryPrice: t("summaryPrice"),
          submit: t("submit"),
          submitting: t("submitting"),
          confirmedTitle: t("confirmedTitle"),
          confirmedBody: t("confirmedBody"),
          confirmationReference: t("confirmationReference"),
          newBooking: t("newBooking"),
          requiredField: t("requiredField"),
          todayLabel: t("todayLabel"),
        }}
      />
    </div>
  );
}
