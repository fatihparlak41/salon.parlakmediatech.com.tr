"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { resendConfirmationAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ResendConfirmationForm() {
  const t = useTranslations("Auth.confirmEmail");
  const [state, formAction, isPending] = useActionState(
    resendConfirmationAction,
    null,
  );

  if (state?.success) {
    return (
      <p className="text-muted-foreground text-sm">{t("resendSuccess")}</p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("resendEmailLabel")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending}>
        {isPending ? t("resendSubmitting") : t("resendButton")}
      </Button>
    </form>
  );
}
