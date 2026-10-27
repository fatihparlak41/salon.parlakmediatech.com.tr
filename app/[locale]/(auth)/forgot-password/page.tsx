import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

// A password-recovery request screen has no business in a search index.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Faz SAAS.1A — step 1 of password recovery. A dedicated surface: it is never mixed with sign-up or
 * login. It reads NO search parameter on purpose (no `next`): nothing a link can carry changes where the
 * person ends up, and the form's answer never depends on whether the address has an account.
 */
export default async function ForgotPasswordPage() {
  const t = await getTranslations("Auth.forgotPassword");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <ForgotPasswordForm />
    </div>
  );
}
