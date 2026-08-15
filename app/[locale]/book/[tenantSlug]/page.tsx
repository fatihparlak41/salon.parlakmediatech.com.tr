import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Public booking entry point — no auth. Faz 2 fills this with the real
 * service/staff/time-slot flow, reading only through narrow RPCs (see the
 * architecture report, section H) rather than direct table access.
 */
export default async function BookingPage({
  params,
}: PageProps<"/[locale]/book/[tenantSlug]">) {
  const { tenantSlug } = await params;
  const t = await getTranslations("Placeholder");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-start justify-center px-6 py-16">
      <Badge variant="secondary">
        {t("tenantLabel")}: {tenantSlug}
      </Badge>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">
        {t("book.title")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("book.description")}
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
