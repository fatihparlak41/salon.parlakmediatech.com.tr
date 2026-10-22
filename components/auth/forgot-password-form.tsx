"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { requestPasswordRecoveryAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Faz LAUNCH.1A — step 1 of staff password recovery. The success text comes
 * from the server action and is the SAME for every well-formed address, so
 * this screen can never confirm or deny that an account exists. */
export function ForgotPasswordForm() {
  const t = useTranslations("Auth.forgotPassword");
  const [state, formAction, isPending] = useActionState(requestPasswordRecoveryAction, null);

  if (state?.success) {
    return (
      <p className="text-sm" role="status">
        {state.data.message}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("emailLabel")}</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </div>
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending} className="mt-2">
        {isPending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
