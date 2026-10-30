import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { requirePlatformAdmin } from "@/lib/auth/session";

export default async function SuperAdminLayout({ children }: LayoutProps<"/[locale]/super-admin">) {
  // Independent of tenant_memberships entirely — see architecture report section E. A tenant owner is never a platform admin by virtue
  // of owning a tenant, no matter how permissive their role is. This is the UX layer; every function the pages call re-checks the same
  // thing inside the database (private.admin_require), so a request that skipped this layout would still get nothing.
  await requirePlatformAdmin();
  const t = await getTranslations("SuperAdmin");

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="border-border mb-6 flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex items-center gap-6">
          <span className="text-base font-semibold tracking-tight">{t("title")}</span>
          <nav className="flex items-center gap-4 text-sm" aria-label="admin">
            <Link href="/super-admin" className="text-muted-foreground hover:text-foreground">
              {t("nav.dashboard")}
            </Link>
            <Link href="/super-admin/salons" className="text-muted-foreground hover:text-foreground">
              {t("nav.salons")}
            </Link>
          </nav>
        </div>
        <span className="text-muted-foreground text-xs">{t("readOnlyNote")}</span>
      </header>
      {children}
    </div>
  );
}
