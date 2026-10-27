import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { getPendingConfirmation } from "@/lib/auth/pending-confirmation";
import { Button } from "@/components/ui/button";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

// A password-reset screen has no business in a search index.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Faz SAAS.1A — step 2 of password recovery, the token-FREE page. By the time a person lands here
 * the e-mail link (GET /auth/confirm) has parked the single-use token in an HttpOnly cookie and
 * redirected; this render never reads the token (only whether a RECOVERY token is parked), never calls
 * the auth service, and so cannot burn a link: a scanner or a reload changes nothing. The token is
 * verified only by the form's explicit submit (resetPasswordAction).
 *
 * Without a parked recovery token (the link was never opened in this browser, it expired, it was used,
 * or someone typed the address by hand) there is nothing to reset: the page says so plainly and offers
 * a new link. A parked token of another kind (signup, magic link) is not a recovery link either.
 */
export default async function ResetPasswordPage() {
  const t = await getTranslations("Auth.resetPassword");
  const pending = await getPendingConfirmation();

  if (!pending || pending.type !== "recovery") {
    return (
      <div className="flex flex-col gap-6 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{t("invalidTitle")}</h1>
          <p className="text-muted-foreground text-sm">{t("invalidDescription")}</p>
        </div>
        <div className="flex flex-col gap-3">
          <Button render={<Link href="/forgot-password" />} nativeButton={false} className="w-full">
            {t("requestNew")}
          </Button>
          <Link href="/login" className="text-muted-foreground text-sm underline underline-offset-4">
            {t("backToLogin")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <ResetPasswordForm />
    </div>
  );
}
