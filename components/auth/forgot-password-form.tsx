"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { requestPasswordRecoveryAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** How long the "send again" button stays disabled after a request. The auth provider enforces its own
 * per-address and per-hour e-mail limits; this only stops a person from hammering the button, and it is
 * deliberately NEUTRAL: it never says that a limit was hit or whether an address exists. */
export const RESET_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Faz SAAS.1A — "Şifre yenileme bağlantısı gönder". The server answers every well-formed address with the
 * same neutral message (see requestPasswordRecoveryAction); this form never learns, and never shows,
 * whether an account exists. The e-mail field is controlled so it survives a refused (malformed) submit,
 * and so the success panel can offer a cooldown-limited "send again" without asking for it again.
 */
export function ForgotPasswordForm() {
  const t = useTranslations("Auth.forgotPassword");
  const [email, setEmail] = useState("");
  const [state, formAction, isPending] = useActionState(requestPasswordRecoveryAction, null);
  const [lastSubmitAt, setLastSubmitAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The tick only runs while a cooldown can still be counting down.
  useEffect(() => {
    if (lastSubmitAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lastSubmitAt]);

  const secondsLeft =
    lastSubmitAt === null ? 0 : Math.max(0, RESET_RESEND_COOLDOWN_SECONDS - Math.floor((now - lastSubmitAt) / 1000));

  function markSubmitted() {
    const current = Date.now();
    setNow(current);
    setLastSubmitAt(current);
  }

  if (state?.success) {
    const waiting = secondsLeft > 0;
    return (
      <div className="flex flex-col gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{t("successTitle")}</h2>
          <p className="text-sm" role="status">
            {t("successDescription")}
          </p>
          <p className="text-muted-foreground text-xs">{t("successHint")}</p>
        </div>
        <form action={formAction} onSubmit={markSubmitted} className="flex flex-col gap-2">
          <input type="hidden" name="email" value={email} />
          <Button type="submit" variant="outline" disabled={isPending || waiting}>
            {waiting ? t("resendWait", { seconds: secondsLeft }) : t("resendCta")}
          </Button>
        </form>
        <Link href="/login" className="text-foreground text-sm underline underline-offset-4">
          {t("backToLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} onSubmit={markSubmitted} className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{t("description")}</p>
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
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending} className="mt-2">
        {isPending ? t("submitting") : t("submit")}
      </Button>
      <Link href="/login" className="text-muted-foreground text-center text-sm underline underline-offset-4">
        {t("backToLogin")}
      </Link>
    </form>
  );
}
