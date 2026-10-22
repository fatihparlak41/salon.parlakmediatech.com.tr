import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getMyTenantProvisioningStatus } from "@/lib/modules/tenants/provisioning";
import { CreateTenantForm } from "@/components/onboarding/create-tenant-form";
import { Button } from "@/components/ui/button";

export default async function OnboardingPage() {
  await requireUser();
  const t = await getTranslations("Onboarding");

  // Faz LAUNCH.1A — salon creation is owner-approval only for now. The form is
  // shown only to a caller who could actually succeed; everyone else gets an
  // explanation instead of an error after typing. This is presentation: the
  // database refuses an unapproved create_tenant call no matter what this
  // page renders (see lib/modules/tenants/provisioning.ts).
  const supabase = await createClient();
  const mayCreateSalon = await getMyTenantProvisioningStatus(supabase);

  if (!mayCreateSalon) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6 py-16">
        <h1 className="text-xl font-semibold tracking-tight">{t("pendingApprovalTitle")}</h1>
        <p className="text-muted-foreground mt-2 text-sm">{t("pendingApprovalDescription")}</p>
        <Button render={<Link href="/" />} nativeButton={false} variant="outline" className="mt-6 self-start">
          {t("pendingApprovalHome")}
        </Button>
      </div>
    );
  }

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
