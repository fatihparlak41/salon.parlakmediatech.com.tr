import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import {
  getCurrentUser,
  getUserMemberships,
  isPlatformAdmin,
} from "@/lib/auth/session";
import { getMyAccountProfile } from "@/lib/modules/customer-account/queries";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";

export default async function HomePage() {
  const user = await getCurrentUser();

  if (!user) {
    return <SignedOutHome />;
  }

  // The greeting name is the person's CURRENT profile name (profiles.full_name,
  // the same source the salon dashboard greets from and the one they can edit
  // on their Hesabım page) — not user_metadata.full_name, which is only the
  // value typed once at sign-up and never changes when the profile is edited.
  const [memberships, platformAdmin, profile] = await Promise.all([
    getUserMemberships(),
    isPlatformAdmin(),
    getMyAccountProfile(),
  ]);

  return (
    <SignedInHome
      fullName={profile?.fullName?.trim() || undefined}
      memberships={memberships}
      platformAdmin={platformAdmin}
    />
  );
}

async function SignedOutHome() {
  const t = await getTranslations("Home.signedOut");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-start justify-center px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted-foreground mt-2 text-lg">{t("tagline")}</p>
      <div className="mt-6 flex gap-3">
        <Button render={<Link href="/login" />} nativeButton={false}>
          {t("loginCta")}
        </Button>
        <Button
          render={<Link href="/sign-up" />}
          nativeButton={false}
          variant="outline"
        >
          {t("signUpCta")}
        </Button>
      </div>
    </div>
  );
}

async function SignedInHome({
  fullName,
  memberships,
  platformAdmin,
}: {
  fullName?: string;
  memberships: Awaited<ReturnType<typeof getUserMemberships>>;
  platformAdmin: boolean;
}) {
  const t = await getTranslations("Home.signedIn");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        {fullName ? t("greeting", { name: fullName }) : t("greetingAnonymous")}
      </h1>

      <h2 className="text-muted-foreground mt-8 mb-3 text-sm font-medium">
        {t("yourSalons")}
      </h2>

      {memberships.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground text-sm">{t("noSalons")}</p>
          <Button render={<Link href="/onboarding" />} nativeButton={false}>
            {t("createSalon")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {memberships.map((m) => (
            <Card key={m.tenantId} className="gap-3 py-4">
              <CardHeader className="gap-1 px-4">
                <CardTitle className="text-sm">{m.tenantName}</CardTitle>
                <CardDescription className="text-xs">
                  {m.roleName}
                </CardDescription>
              </CardHeader>
              <CardFooter className="px-4">
                <Button
                  render={<Link href={`/app/${m.tenantSlug}`} />}
                  nativeButton={false}
                  variant="outline"
                  size="sm"
                  className="w-full"
                >
                  {t("openSalon")}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {platformAdmin ? (
        <>
          <h2 className="text-muted-foreground mt-8 mb-3 text-sm font-medium">
            {t("platformAdmin")}
          </h2>
          <Button
            render={<Link href="/super-admin" />}
            nativeButton={false}
            variant="outline"
          >
            {t("openSuperAdmin")}
          </Button>
        </>
      ) : null}
    </div>
  );
}
