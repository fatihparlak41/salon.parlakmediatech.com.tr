import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getMyLinkSalonContext } from "@/lib/modules/customer-account/queries";
import { AccountShell } from "@/components/customer-account/account-shell";
import { LinkSalonCodeGenerator } from "@/components/customer-account/link-salon-code-generator";

/**
 * Faz 2G.3.2 — the customer-side entry point for salon-assisted account
 * linking, reached from a "Mevcut salon kaydımı hesabıma bağla" link on
 * the tenant's own public booking page. Deliberately OUTSIDE the
 * (guarded) route group: that group's shared layout redirects an
 * unauthenticated visitor straight to /account/login with no memory of
 * where they were headed, and this is specifically the one place that
 * needs to preserve the destination (per the explicit "safely return to
 * that internal route" requirement) — so this page does its own
 * inline auth check and wraps itself in AccountShell manually to stay
 * visually consistent with the rest of the guarded area.
 *
 * No customer_id exists anywhere on this side — the customer never
 * selects or sees a CRM row, only the salon's public display name and
 * their own generated code.
 */
export default async function LinkSalonPage({
  params,
}: PageProps<"/[locale]/account/link-salon/[tenantSlug]">) {
  const { tenantSlug } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/account/login?next=${encodeURIComponent(`/account/link-salon/${tenantSlug}`)}`);
  }

  const t = await getTranslations("Account.linkSalon");
  const tNav = await getTranslations("Account.nav");
  const tAuth = await getTranslations("Auth");
  const context = await getMyLinkSalonContext(tenantSlug);

  return (
    <AccountShell
      navLabels={{ home: tNav("home"), appointments: tNav("appointments"), profile: tNav("profile") }}
      signOutLabel={tAuth("signOut")}
    >
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8">
        {context ? (
          <>
            <div className="flex flex-col gap-1 text-center">
              <h1 className="text-xl font-semibold tracking-tight">{t("title", { salonName: context.tenantName })}</h1>
              <p className="text-muted-foreground text-sm">{t("description")}</p>
            </div>
            <LinkSalonCodeGenerator
              tenantSlug={tenantSlug}
              labels={{
                generate: t("generate"),
                generating: t("generating"),
                regenerate: t("regenerate"),
                codeLabel: t("codeLabel"),
                copy: t("copy"),
                copied: t("copied"),
                expiresNote: t("expiresNote"),
              }}
            />
          </>
        ) : (
          <p className="text-muted-foreground text-center text-sm">{t("notFound")}</p>
        )}
      </div>
    </AccountShell>
  );
}
