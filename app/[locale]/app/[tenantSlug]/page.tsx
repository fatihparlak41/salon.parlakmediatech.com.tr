import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default async function TenantAppPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]">) {
  const { tenantSlug } = await params;
  const t = await getTranslations("Placeholder");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-start justify-center px-6 py-16">
      <Badge variant="secondary">
        {t("tenantLabel")}: {tenantSlug}
      </Badge>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">
        {t("tenantApp.title")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("tenantApp.description")}
      </p>
      <Button
        render={<Link href="/" />}
        nativeButton={false}
        variant="outline"
        className="mt-6"
      >
        {t("backHome")}
      </Button>
    </div>
  );
}
