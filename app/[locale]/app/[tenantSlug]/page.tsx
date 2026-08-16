import { getTranslations } from "next-intl/server";
import { getTenantAccess } from "@/lib/auth/session";
import { signOutAction } from "@/lib/modules/auth/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default async function TenantAppPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  const t = await getTranslations("TenantApp.dashboard");
  const tAuth = await getTranslations("Auth");

  // Layout above already guards unauthenticated/not_found — this satisfies
  // the type narrowing without repeating the redirect/notFound logic.
  if (access.reason !== "ok") {
    return null;
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-start justify-center px-6 py-16">
      <Badge variant="secondary">{access.tenant.name}</Badge>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">
        {t("title")}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">
        {t("roleLabel")}: {access.roleName}
      </p>
      <p className="text-muted-foreground mt-4 text-sm">{t("description")}</p>
      <form action={signOutAction} className="mt-6">
        <Button type="submit" variant="outline">
          {tAuth("signOut")}
        </Button>
      </form>
    </div>
  );
}
