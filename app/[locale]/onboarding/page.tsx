import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/session";
import { CreateTenantForm } from "@/components/onboarding/create-tenant-form";

export default async function OnboardingPage() {
  await requireUser();
  const t = await getTranslations("Onboarding");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{t("description")}</p>
      <div className="mt-6">
        <CreateTenantForm />
      </div>
    </div>
  );
}
