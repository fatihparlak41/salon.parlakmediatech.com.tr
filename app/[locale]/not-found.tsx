import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  const t = useTranslations("NotFound");

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="border-border bg-card w-full max-w-sm rounded-lg border p-8 text-center shadow-sm">
        <h1 className="text-card-foreground text-lg font-semibold">
          {t("title")}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">{t("description")}</p>
        <Button
          render={<Link href="/" />}
          nativeButton={false}
          className="mt-6"
        >
          {t("backHome")}
        </Button>
      </div>
    </div>
  );
}
