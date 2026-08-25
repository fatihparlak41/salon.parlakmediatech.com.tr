"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { requestAccountMagicLinkAction } from "@/lib/modules/customer-account/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Deliberately the same response regardless of what happened server-side
 * — see requestAccountMagicLinkAction's own comment. This form never
 * branches on "account exists" vs "new account", by construction: the
 * action never tells it which one happened.
 */
export function MagicLinkForm({ next }: { next?: string }) {
  const t = useTranslations("Account.login");
  const [state, formAction, isPending] = useActionState(requestAccountMagicLinkAction, null);

  if (state?.success) {
    return (
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-lg font-semibold">{t("successTitle")}</h2>
        <p className="text-muted-foreground text-sm">{t("successDescription")}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("emailLabel")}</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
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
