"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { resetPasswordAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Faz SAAS.1A — the new-password form behind a password-recovery link. It carries NO token and NO
 * redirect field: the token comes from the HttpOnly cookie the e-mail link parked, so nothing a visitor
 * edits in this form can choose which token is verified or where they land afterwards.
 *
 * A refused submit (mismatch, too short) happens BEFORE the token is touched, so it never burns the
 * link. A link that turns out to be dead (expired, already used) is reported with the server's own
 * neutral message plus a way to ask for a new one — never a raw provider error.
 */
export function ResetPasswordForm() {
  const t = useTranslations("Auth.resetPassword");
  const [state, formAction, isPending] = useActionState(resetPasswordAction, null);

  const linkIsDead = state && !state.success && state.error.code === "UNAUTHENTICATED";

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{t("description")}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t("passwordLabel")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          aria-describedby="password-hint"
        />
        <p id="password-hint" className="text-muted-foreground text-xs">
          {t("passwordHint")}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirmPassword">{t("confirmLabel")}</Label>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} />
      </div>
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      {linkIsDead ? (
        <Link href="/forgot-password" className="text-foreground text-sm underline underline-offset-4">
          {t("requestNew")}
        </Link>
      ) : null}
      <Button type="submit" disabled={isPending} className="mt-2">
        {isPending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
