"use client";

import { useTranslations } from "next-intl";
import { confirmEmailAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";

/**
 * Deliberately a plain form + Server Action, not useActionState —
 * confirmEmailAction always redirects (to `next` on success, back to
 * /confirm-email on failure, which then renders the expired state) and
 * never returns a result to display here.
 */
export function ConfirmEmailButton() {
  const t = useTranslations("Auth.confirmEmail");

  return (
    <form action={confirmEmailAction}>
      <Button type="submit" className="w-full">
        {t("confirmButton")}
      </Button>
    </form>
  );
}
