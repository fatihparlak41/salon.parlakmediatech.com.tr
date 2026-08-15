import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  const t = useTranslations("Foundation");
  const slug = t("sampleSlug");

  const routes = [
    {
      label: t("linkAppLabel"),
      path: t("linkAppPath"),
      href: `/app/${slug}`,
    },
    {
      label: t("linkBookLabel"),
      path: t("linkBookPath"),
      href: `/book/${slug}`,
    },
    {
      label: t("linkSuperAdminLabel"),
      path: t("linkSuperAdminPath"),
      href: "/super-admin",
    },
  ];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-16">
      <Badge variant="secondary" className="w-fit">
        {t("badge")}
      </Badge>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight text-balance">
        {t("title")}
      </h1>
      <p className="text-muted-foreground mt-2 text-lg text-balance">
        {t("tagline")}
      </p>
      <p className="text-muted-foreground mt-4 text-sm">{t("description")}</p>

      <Separator className="my-8" />

      <h2 className="text-muted-foreground mb-4 text-sm font-medium">
        {t("routesHeading")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {routes.map((route) => (
          <Card key={route.href} className="gap-3 py-4">
            <CardHeader className="gap-1 px-4">
              <CardTitle className="text-sm">{route.label}</CardTitle>
              <CardDescription className="font-mono text-xs">
                {route.path}
              </CardDescription>
            </CardHeader>
            <CardFooter className="px-4">
              <Button
                render={<Link href={route.href} />}
                nativeButton={false}
                variant="outline"
                size="sm"
                className="w-full"
              >
                Aç
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
