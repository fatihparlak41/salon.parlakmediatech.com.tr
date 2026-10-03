"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/lib/i18n/navigation";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";

/** Shown instead of the page when a server read failed: an explicit state with a retry, never a blank screen. */
export function ExpensesErrorState({ labels }: { labels: ExpenseLabels }) {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
      <div className="border-border mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
        <div className="bg-muted flex size-12 items-center justify-center rounded-full">
          <TriangleAlert className="text-muted-foreground size-6" />
        </div>
        <h2 className="text-base font-medium">{labels.error.title}</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          {labels.error.description}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.refresh()}
        >
          {labels.error.retry}
        </Button>
      </div>
    </div>
  );
}
