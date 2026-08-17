import { getTranslations } from "next-intl/server";
import { getPendingConfirmation } from "@/lib/auth/pending-confirmation";
import { ConfirmEmailButton } from "@/components/auth/confirm-email-button";
import { ResendConfirmationForm } from "@/components/auth/resend-confirmation-form";

export default async function ConfirmEmailPage() {
  const t = await getTranslations("Auth.confirmEmail");
  const pending = await getPendingConfirmation();

  if (!pending) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("expiredTitle")}
        </h1>
        <ResendConfirmationForm />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("pendingTitle")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("pendingDescription")}
        </p>
      </div>
      <ConfirmEmailButton />
    </div>
  );
}
