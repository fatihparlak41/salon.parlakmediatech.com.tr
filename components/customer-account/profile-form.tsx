"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateMyAccountProfileAction } from "@/lib/modules/customer-account/actions";
import type { AccountProfile } from "@/lib/modules/customer-account/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ProfileForm({ profile }: { profile: AccountProfile }) {
  const t = useTranslations("Account.profile");
  const [state, formAction, isPending] = useActionState(updateMyAccountProfileAction, null);
  const current = state?.success ? state.data : profile;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("emailLabel")}</Label>
        <Input id="email" type="email" value={current.email} disabled readOnly />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fullName">{t("fullNameLabel")}</Label>
        <Input id="fullName" name="fullName" type="text" autoComplete="name" defaultValue={current.fullName ?? ""} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="phone">{t("phoneLabel")}</Label>
        <Input id="phone" name="phone" type="tel" autoComplete="tel" defaultValue={current.phone ?? ""} />
      </div>
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      {state?.success ? (
        <p className="text-sm text-green-600 dark:text-green-500">{t("saved")}</p>
      ) : null}
      <Button type="submit" disabled={isPending} className="mt-2 w-fit">
        {isPending ? t("saving") : t("save")}
      </Button>
    </form>
  );
}
