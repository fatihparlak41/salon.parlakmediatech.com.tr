import { getTranslations } from "next-intl/server";
import { MagicLinkForm } from "@/components/customer-account/magic-link-form";
import { resolveSafeNext } from "@/app/auth/confirm/route";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Deliberately its own route, never /login (staff password sign-in) —
 * see lib/auth/session.ts's requireAccountUser() header for why these
 * two authorization domains stay separate even though both sit on the
 * same Supabase Auth user pool.
 *
 * Faz 2G.3.2 — accepts an optional ?next= so a route that redirected an
 * unauthenticated visitor here (e.g. /account/link-salon/[slug]) gets
 * them back after the magic-link ceremony instead of always landing on
 * the generic /account home. Validated with the same resolveSafeNext
 * guard used everywhere else this project accepts a redirect target.
 */
export default async function AccountLoginPage({
  searchParams,
}: PageProps<"/[locale]/account/login">) {
  const t = await getTranslations("Account.login");
  const { next: rawNext } = await searchParams;
  const nextValue = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  const next = nextValue ? resolveSafeNext(nextValue, getSiteUrl()) : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground text-sm">{t("description")}</p>
        </div>
        <MagicLinkForm next={next} />
      </div>
    </div>
  );
}
