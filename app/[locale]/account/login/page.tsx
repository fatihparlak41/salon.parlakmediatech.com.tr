import { useTranslations } from "next-intl";
import { MagicLinkForm } from "@/components/customer-account/magic-link-form";

/**
 * Deliberately its own route, never /login (staff password sign-in) —
 * see lib/auth/session.ts's requireAccountUser() header for why these
 * two authorization domains stay separate even though both sit on the
 * same Supabase Auth user pool.
 */
export default function AccountLoginPage() {
  const t = useTranslations("Account.login");

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground text-sm">{t("description")}</p>
        </div>
        <MagicLinkForm />
      </div>
    </div>
  );
}
