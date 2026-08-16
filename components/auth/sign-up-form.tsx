"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signUpAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignUpForm() {
  const t = useTranslations("Auth.signUp");
  const [state, formAction, isPending] = useActionState(signUpAction, null);

  if (state?.success) {
    return (
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-lg font-semibold">{t("successTitle")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("successDescription", { email: state.data.email })}
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fullName">{t("fullNameLabel")}</Label>
        <Input
          id="fullName"
          name="fullName"
          type="text"
          autoComplete="name"
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("emailLabel")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t("passwordLabel")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
        <p className="text-muted-foreground text-xs">{t("passwordHint")}</p>
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
