import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

/**
 * Faz LAUNCH.1A — staff / owner password recovery, step 1. Deliberately takes
 * no `?next=`: the recovery flow always ends on the staff login. The customer
 * portal has no password (it uses an e-mailed link), so customers are pointed
 * to their own sign-in instead of this page.
 */
export default async function ForgotPasswordPage() {
  const t = await getTranslations("Auth.forgotPassword");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <ForgotPasswordForm />
      <div className="text-muted-foreground flex flex-col gap-2 text-center text-sm">
        <Link href="/login" className="text-foreground underline underline-offset-4">
          {t("backToLogin")}
        </Link>
        <p className="text-xs">
          {t("customerHint")}{" "}
          <Link href="/account/login" className="text-foreground underline underline-offset-4">
            {t("customerLink")}
          </Link>
        </p>
      </div>
    </div>
  );
}
