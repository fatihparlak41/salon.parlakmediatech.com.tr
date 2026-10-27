"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { resendConfirmationAction, signInAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Faz SAAS.1A — the login form. Three additions over the plain form:
 *  - "Şifremi unuttum" leads to the dedicated recovery surface (/forgot-password), never mixed with sign-up;
 *  - `passwordWasReset` shows the one-line confirmation after a successful reset (a fixed, non-secret
 *    flag the page derives from ?reset=success — it is never used as a redirect target);
 *  - an account whose (correct) credentials are refused ONLY because its e-mail address is unconfirmed gets
 *    a useful state with a resend button instead of the generic "wrong e-mail or password". The e-mail field
 *    is controlled so the address survives the refusal and the resend needs no retyping.
 */
export function LoginForm({ next, passwordWasReset = false }: { next?: string; passwordWasReset?: boolean }) {
  const t = useTranslations("Auth.login");
  const [email, setEmail] = useState("");
  const [state, formAction, isPending] = useActionState(signInAction, null);

  const notConfirmed = state && !state.success && state.error.code === "EMAIL_NOT_CONFIRMED";

  return (
    <div className="flex flex-col gap-4">
      {passwordWasReset ? (
        <p className="bg-muted text-foreground rounded-lg px-3 py-2 text-sm" role="status">
          {t("resetSuccess")}
        </p>
      ) : null}
      <form action={formAction} className="flex flex-col gap-4">
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">{t("emailLabel")}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">{t("passwordLabel")}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Link
            href="/forgot-password"
            className="text-muted-foreground self-end text-xs underline underline-offset-4"
          >
            {t("forgotLink")}
          </Link>
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
      {notConfirmed ? <ResendConfirmation email={email} /> : null}
    </div>
  );
}

/** Offered only for the unconfirmed-account state. A separate form (never nested inside the login form);
 * the server answers with its usual neutral success, so this tells nobody whether an address exists. */
function ResendConfirmation({ email }: { email: string }) {
  const t = useTranslations("Auth.login");
  const [state, formAction, isPending] = useActionState(resendConfirmationAction, null);

  if (state?.success) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {t("resendConfirmationDone")}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="email" value={email} />
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={isPending}>
        {isPending ? t("resendConfirmationSending") : t("resendConfirmation")}
      </Button>
    </form>
  );
}
