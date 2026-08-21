import { getTranslations } from "next-intl/server";
import { getTenantAccess } from "@/lib/auth/session";

export default async function TenantAppPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  const t = await getTranslations("TenantApp.dashboard");

  // Layout above already guards unauthenticated/not_found — this satisfies
  // the type narrowing without repeating the redirect/notFound logic.
  if (access.reason !== "ok") {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        {t("roleLabel")}: {access.roleName}
      </p>
      <p className="text-muted-foreground mt-4 text-sm">{t("description")}</p>
    </div>
  );
}
