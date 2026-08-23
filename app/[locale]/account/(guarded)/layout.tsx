import { getTranslations } from "next-intl/server";
import { requireAccountUser } from "@/lib/auth/session";
import { AccountShell } from "@/components/customer-account/account-shell";

/**
 * Route-group layout (guarded) — the URL has no "(guarded)" segment, so
 * this wraps exactly /account, /account/appointments, /account/profile,
 * while /account/login (a sibling outside this group) stays reachable
 * while signed out. requireAccountUser() asks only "is there a session"
 * — no membership, no customer_account_links row required; a brand-new
 * account with zero linked bookings is valid and reaches a clean empty
 * state below, never a redirect (see that guard's own comment).
 */
export default async function AccountGuardedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAccountUser();
  const t = await getTranslations("Account.nav");
  const tAuth = await getTranslations("Auth");

  return (
    <AccountShell
      navLabels={{ home: t("home"), appointments: t("appointments"), profile: t("profile") }}
      signOutLabel={tAuth("signOut")}
    >
      {children}
    </AccountShell>
  );
}
