import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { getPendingConfirmation } from "@/lib/auth/pending-confirmation";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

/**
 * Faz LAUNCH.1A — staff / owner password recovery, step 2.
 *
 * Renders the new-password form ONLY when a password-recovery token is parked
 * (GET /auth/confirm put it in an HttpOnly cookie and redirected here without
 * verifying it). Anything else — no cookie, an expired one, or a parked
 * signup / magic-link / invite token, which is not a recovery link and is left
 * untouched — gets the same neutral "link expired or already used" screen.
 * The page never shows the token, an e-mail address, a tenant or any account
 * detail, and it cannot tell whether the parked token is still valid (that is
 * only decided when the form is submitted).
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
        <Link href="/forgot-password" className="text-foreground text-sm underline underline-offset-4">
          {t("requestNewLink")}
        </Link>
        <Link href="/login" className="text-muted-foreground text-sm underline underline-offset-4">
          {t("backToLogin")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <ResetPasswordForm />
    </div>
  );
}
