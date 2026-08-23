import { getTranslations } from "next-intl/server";
import { getMyAccountProfile } from "@/lib/modules/customer-account/queries";
import { ProfileForm } from "@/components/customer-account/profile-form";

export default async function AccountProfilePage() {
  const t = await getTranslations("Account.profile");
  const profile = await getMyAccountProfile();

  if (!profile) {
    return <p className="text-muted-foreground text-sm">{t("loadError")}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <ProfileForm profile={profile} />
    </div>
  );
}
