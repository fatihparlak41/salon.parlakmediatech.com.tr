import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { resolveSafeNext } from "@/app/auth/confirm/route";
import { getSiteUrl } from "@/lib/site-url";

/** Faz SAAS.1D.2 — same validated optional ?next= as the login page (see
 * its header): lets a signup that began from an invitation continue to
 * /accept-invite once the confirmation link has been used. */
export default async function SignUpPage({ searchParams }: PageProps<"/[locale]/sign-up">) {
  const t = await getTranslations("Auth.signUp");
  const { next: rawNext } = await searchParams;
  const nextValue = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  const safeNext = nextValue ? resolveSafeNext(nextValue, getSiteUrl()) : undefined;
  const next = safeNext && safeNext !== "/" ? safeNext : undefined;
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <SignUpForm next={next} />
      <p className="text-muted-foreground text-center text-sm">
        {t("hasAccount")}{" "}
        <Link
          href={loginHref}
          className="text-foreground underline underline-offset-4"
        >
          {t("loginLink")}
        </Link>
      </p>
    </div>
  );
}
