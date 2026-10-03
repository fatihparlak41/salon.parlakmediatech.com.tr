"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGuardedAction } from "@/components/expenses/use-guarded-action";
import { cancelExpenseAction } from "@/lib/modules/expenses/actions";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import type { ExpenseWriteResult } from "@/lib/modules/expenses/types";

/**
 * Faz FIN.1B.1 — "Gideri iptal et". Only reachable for an expense with no posted payment (the detail sheet disables the
 * button with the reason otherwise, and the database refuses regardless). The reason is required; a cancelled expense is
 * final and stays in the list, struck through, when "iptal edilenleri göster" is on. Mounted only while the cancellation is
 * being entered and unmounted on success.
 */
export function CancelExpenseDialog({
  expenseId,
  tenantSlug,
  labels,
  onClose,
  onCancelled,
  onRefresh,
}: {
  expenseId: string;
  tenantSlug: string;
  labels: ExpenseLabels;
  onClose: () => void;
  onCancelled: (result: ExpenseWriteResult) => void;
  onRefresh: () => void;
}) {
  const [reason, setReason] = useState("");
  const { state, run, isPending } = useGuardedAction(
    cancelExpenseAction,
    onCancelled,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return;
    run({ tenantSlug, expenseId, reason: trimmed });
  }

  const serverError = state && !state.success ? state.error : null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{labels.cancel.title}</DialogTitle>
            <DialogDescription>{labels.cancel.description}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-cancel-reason">
                {labels.cancel.reason}
              </Label>
              <Input
                id="expense-cancel-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                disabled={isPending}
                autoFocus
              />
            </div>

            {serverError ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-destructive text-sm" role="alert">
                  {serverError.message}
                </p>
                {serverError.code === "CONFLICT" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRefresh}
                  >
                    {labels.cancel.refresh}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={isPending}
            >
              {labels.cancel.cancel}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={isPending || !reason.trim()}
            >
              {isPending ? labels.cancel.submitting : labels.cancel.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
