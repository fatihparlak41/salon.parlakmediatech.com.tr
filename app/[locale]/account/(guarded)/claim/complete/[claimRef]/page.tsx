import { getTranslations } from "next-intl/server";
import { getBookingClaimSecretCookie, isValidClaimRef } from "@/lib/auth/booking-claim-cookie";
import { ClaimCompleteButton } from "@/components/customer-account/claim-complete-button";

/**
 * Faz 2G.3.1A — the safe Magic Link destination for a future-booking
 * claim (emailRedirectTo in lib/modules/public-booking/actions.ts, via
 * the existing scanner-safe /auth/confirm -> /confirm-email ->
 * confirmEmailAction flow, unmodified — see app/auth/confirm/route.ts's
 * resolveSafeNext for why a same-origin path like this one, dynamic
 * segment included, is safe to carry through `next`). Sits inside the
 * (guarded) route group, so requireAccountUser() already enforces
 * authentication before this ever renders.
 *
 * claimRef here is what makes multiple simultaneously-pending claims
 * work at all (Faz 2G.3.1 originally used one static destination and
 * one global cookie — see the 2G.3.1A migration's own header for the
 * bug that caused). It is NOT authentication material and NOT trusted
 * as authority by itself: it only tells this page (and the completion
 * action) which of the caller's OWN per-claim cookies to look at. A
 * malformed segment is treated identically to "no pending claim" — no
 * distinct error, no information about whether some OTHER ref might be
 * valid.
 *
 * Checking for the claim cookie here is a presentation choice only, not
 * a security one — see ClaimCompleteButton's own header for why the
 * SUCCESS branch must never be gated by this recomputed-on-every-render
 * value.
 */
export default async function ClaimCompletePage({
  params,
}: PageProps<"/[locale]/account/claim/complete/[claimRef]">) {
  const { claimRef } = await params;
  const t = await getTranslations("Account.claim");
  const hasPendingClaim = isValidClaimRef(claimRef) && !!(await getBookingClaimSecretCookie(claimRef));

  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <ClaimCompleteButton
        claimRef={claimRef}
        hasPendingClaimInitially={hasPendingClaim}
        labels={{
          description: t("description"),
          action: t("action"),
          claiming: t("claiming"),
          success: t("success"),
          goToAppointments: t("goToAppointments"),
          noPendingClaim: t("noPendingClaim"),
        }}
      />
    </div>
  );
}
