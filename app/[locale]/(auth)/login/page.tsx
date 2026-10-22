import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { resolveSafeNext } from "@/app/auth/confirm/route";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Faz SAAS.1D.2 — accepts an optional ?next= so a screen that sent an
 * unauthenticated visitor here (today: /accept-invite) gets them back
 * after signing in instead of always landing on "/". Validated with the
 * same resolveSafeNext guard app/[locale]/account/login/page.tsx already
 * uses, and re-validated again inside signInAction — a hidden form field
 * is client-submitted data even though this page already checked it once.
 * A bare "/" is dropped: it's the default anyway, and carrying it would
 * just add a pointless hidden field.
 */
export default async function LoginPage({ searchParams }: PageProps<"/[locale]/login">) {
  const t = await getTranslations("Auth.login");
  const { next: rawNext, reset: rawReset } = await searchParams;
  const nextValue = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  const safeNext = nextValue ? resolveSafeNext(nextValue, getSiteUrl()) : undefined;
  const next = safeNext && safeNext !== "/" ? safeNext : undefined;
  const signUpHref = next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up";
  // Faz LAUNCH.1A: a finished password reset lands here with ?reset=success
  // (a constant set by resetPasswordAction, never a caller-chosen address).
  // Anything other than that exact value shows nothing.
  const resetDone = (Array.isArray(rawReset) ? rawReset[0] : rawReset) === "success";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      {resetDone ? (
        <p
          role="status"
          className="rounded-lg border border-emerald-600/30 bg-emerald-600/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400"
        >
          {t("resetSuccess")}
        </p>
      ) : null}
      <LoginForm next={next} />
      <p className="text-center text-sm">
        <Link href="/forgot-password" className="text-foreground underline underline-offset-4">
          {t("forgotPasswordLink")}
        </Link>
      </p>
      <p className="text-muted-foreground text-center text-sm">
        {t("noAccount")}{" "}
        <Link
          href={signUpHref}
          className="text-foreground underline underline-offset-4"
        >
          {t("signUpLink")}
        </Link>
      </p>
    </div>
  );
}
