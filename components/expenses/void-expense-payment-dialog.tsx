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
import { voidExpensePaymentAction } from "@/lib/modules/expenses/actions";
import { fillTemplate } from "@/lib/modules/expenses/format";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import { formatMoney } from "@/lib/modules/expenses/money";
import type {
  ExpensePaymentView,
  ExpenseWriteResult,
} from "@/lib/modules/expenses/types";

/**
 * Faz FIN.1B.1 — "Ödemeyi iptal et". A payment is never deleted: it becomes "iptal edildi" with this reason and stays on the
 * expense as evidence. The reason is required (the button stays disabled while it is blank). The parent mounts this dialog
 * only while a void is being entered and unmounts it on success, so no stale form lingers on the payment row afterwards
 * (FIN.1A's inline void form stayed open on the voided row).
 */
export function VoidExpensePaymentDialog({
  payment,
  currency,
  tenantSlug,
  labels,
  onClose,
  onVoided,
  onRefresh,
}: {
  payment: ExpensePaymentView;
  currency: string;
  tenantSlug: string;
  labels: ExpenseLabels;
  onClose: () => void;
  onVoided: (result: ExpenseWriteResult) => void;
  onRefresh: () => void;
}) {
  const [reason, setReason] = useState("");
  const { state, run, isPending } = useGuardedAction(
    voidExpensePaymentAction,
    onVoided,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return;
    run({ tenantSlug, paymentId: payment.id, reason: trimmed });
  }

  const serverError = state && !state.success ? state.error : null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{labels.void.title}</DialogTitle>
            <DialogDescription>
              {fillTemplate(labels.void.description, {
                amount: formatMoney(payment.amount, currency),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-void-reason">{labels.void.reason}</Label>
              <Input
                id="expense-void-reason"
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
                    {labels.void.refresh}
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
              {labels.void.cancel}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={isPending || !reason.trim()}
            >
              {isPending ? labels.void.submitting : labels.void.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
