"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { createTenantAction } from "@/lib/modules/tenants/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/ı/g, "i")
      .normalize("NFD")
      // Strips combining diacritics left behind by NFD (Unicode block
      // U+0300-U+036F) — turns "kuaför" into "kuafor" post-normalize.
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

export function CreateTenantForm() {
  const t = useTranslations("Onboarding");
  const [state, formAction, isPending] = useActionState(
    createTenantAction,
    null,
  );
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">{t("nameLabel")}</Label>
        <Input
          id="name"
          name="name"
          required
          onChange={(e) => {
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slug">{t("slugLabel")}</Label>
        <Input
          id="slug"
          name="slug"
          required
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
        />
        <p className="text-muted-foreground text-xs">
          {t("slugHint", { slug: slug || "…" })}
        </p>
      </div>
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending || !slug} className="mt-2">
        {isPending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
