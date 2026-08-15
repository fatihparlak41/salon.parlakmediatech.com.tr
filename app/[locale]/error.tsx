"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("ErrorBoundary");

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="border-border bg-card w-full max-w-sm rounded-lg border p-8 text-center shadow-sm">
        <h1 className="text-card-foreground text-lg font-semibold">
          {t("title")}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">{t("description")}</p>
        {error.digest ? (
          <p className="text-muted-foreground/70 mt-3 font-mono text-xs">
            {t("digest")}: {error.digest}
          </p>
        ) : null}
        <Button onClick={reset} className="mt-6">
          {t("retry")}
        </Button>
      </div>
    </div>
  );
}
