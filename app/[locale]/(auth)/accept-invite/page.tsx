import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { hasPendingTeamInvitation } from "@/lib/auth/pending-team-invitation";
import { Button } from "@/components/ui/button";
import { AcceptInvitePanel } from "@/components/auth/accept-invite-panel";

// An invitation continuation screen has no business in a search index.
export const metadata: Metadata = { robots: { index: false, follow: false } };

const ACCEPT_INVITE_RETURN = encodeURIComponent("/accept-invite");

/**
 * Faz SAAS.1D.2 — the token-FREE accept page. By the time a request
 * reaches here, proxy.ts has already moved any `?token=` into an HttpOnly
 * cookie and redirected, so the address bar, this render, and every prop
 * below are token-free by construction.
 *
 * Purely a render decision over two booleans — is an invitation parked,
 * is someone signed in. It never reads the raw token (only
 * hasPendingTeamInvitation(), which returns a boolean), never queries
 * invitation details (an anonymous visitor learns nothing about the
 * invitation, not even the invited address), and never calls
 * accept_team_invitation: a GET here can't burn a single-use token, and
 * acceptance happens only on the explicit button press inside
 * AcceptInvitePanel.
 */
export default async function AcceptInvitePage() {
  const t = await getTranslations("AcceptInvite");
  const [hasPending, user] = await Promise.all([hasPendingTeamInvitation(), getCurrentUser()]);

  if (!hasPending) {
    return (
      <div className="flex flex-col gap-6 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{t("noPending.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("noPending.description")}</p>
        </div>
        <Button render={<Link href="/" />} nativeButton={false} variant="outline" className="w-full">
          {t("noPending.homeCta")}
        </Button>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col gap-6 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{t("continuation.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("continuation.description")}</p>
        </div>
        <div className="flex flex-col gap-3">
          <Button
            render={<Link href={`/login?next=${ACCEPT_INVITE_RETURN}`} />}
            nativeButton={false}
            className="w-full"
          >
            {t("continuation.loginCta")}
          </Button>
          <Button
            render={<Link href={`/sign-up?next=${ACCEPT_INVITE_RETURN}`} />}
            nativeButton={false}
            variant="outline"
            className="w-full"
          >
            {t("continuation.signUpCta")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <AcceptInvitePanel
      labels={{
        title: t("accept.title"),
        description: t("accept.description"),
        acceptCta: t("accept.acceptCta"),
        accepting: t("accept.accepting"),
        notNowCta: t("accept.notNowCta"),
        loginCta: t("continuation.loginCta"),
        switchAccountCta: t("failure.switchAccountCta"),
        homeCta: t("failure.homeCta"),
      }}
    />
  );
}
