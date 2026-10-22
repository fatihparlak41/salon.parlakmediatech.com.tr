"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { resetPasswordAction } from "@/lib/modules/auth/actions";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Faz LAUNCH.1A — step 2 of staff password recovery. Rendered only when a
 * recovery token is parked (see the page). It carries no token, no e-mail and
 * no `next`: the server action reads the token from an HttpOnly cookie and
 * always finishes on the staff login. */
export function ResetPasswordForm() {
  const t = useTranslations("Auth.resetPassword");
  const [state, formAction, isPending] = useActionState(resetPasswordAction, null);
  const linkProblem = state && !state.success && state.error.code === "UNAUTHENTICATED";

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t("passwordLabel")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          autoFocus
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
        <div className="flex flex-col gap-2">
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
          {linkProblem ? (
            <Link href="/forgot-password" className="text-foreground text-sm underline underline-offset-4">
              {t("requestNewLink")}
            </Link>
          ) : null}
        </div>
      ) : null}
      <Button type="submit" disabled={isPending} className="mt-2">
        {isPending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
