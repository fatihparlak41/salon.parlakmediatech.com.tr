import { getTranslations } from "next-intl/server";

/**
 * Faz 2G.3.1A — a bare /account/claim/complete (no claim_ref segment)
 * has nothing to check and nothing to act on: every real Magic Link now
 * points at /account/claim/complete/<claimRef> (see
 * lib/modules/public-booking/actions.ts). This route only exists as a
 * clean fallback for a stale bookmark or direct navigation, rather than
 * a 404 — it unconditionally shows the same "nothing to claim" message
 * the dynamic page shows when its own ref/cookie don't check out.
 */
export default async function ClaimCompleteFallbackPage() {
  const t = await getTranslations("Account.claim");

  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="text-muted-foreground max-w-sm text-sm">{t("noPendingClaim")}</p>
    </div>
  );
}
