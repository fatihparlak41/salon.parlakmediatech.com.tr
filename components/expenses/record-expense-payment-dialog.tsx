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
import { SelectField } from "@/components/expenses/select-field";
import { useGuardedAction } from "@/components/expenses/use-guarded-action";
import { recordExpensePaymentAction } from "@/lib/modules/expenses/actions";
import {
  newAttemptInstant,
  newAttemptKey,
} from "@/lib/modules/expenses/attempt";
import { EXPENSE_ERROR_MESSAGES } from "@/lib/modules/expenses/error-codes";
import { fillTemplate, toEditableAmount } from "@/lib/modules/expenses/format";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import {
  MONEY_PARSE_MESSAGES,
  formatMoney,
  parseMoneyInput,
} from "@/lib/modules/expenses/money";
import {
  EXPENSE_PAYMENT_METHODS,
  type ExpensePaymentMethod,
  type ExpenseWriteResult,
} from "@/lib/modules/expenses/types";

/**
 * Faz FIN.1B.1 — "Ödeme Yap". Like the create dialog, ONE mount is ONE attempt: the idempotency key and the payment instant
 * are created once at mount, so a retried submit sends the identical payload, and the parent mounts this component only
 * while a payment is actually being entered. The amount defaults to the remaining balance; "250,50" and "250.50" are both
 * understood. The payment is stamped with the instant of this attempt (no editable payment date in v1).
 */
export function RecordExpensePaymentDialog({
  expenseId,
  tenantSlug,
  outstanding,
  currency,
  labels,
  onClose,
  onRecorded,
  onRefresh,
}: {
  expenseId: string;
  tenantSlug: string;
  outstanding: number;
  currency: string;
  labels: ExpenseLabels;
  onClose: () => void;
  onRecorded: (result: ExpenseWriteResult) => void;
  onRefresh: () => void;
}) {
  const [amount, setAmount] = useState(() => toEditableAmount(outstanding));
  const [method, setMethod] = useState<ExpensePaymentMethod>("cash");
  const [note, setNote] = useState("");
  const [idempotencyKey] = useState(newAttemptKey);
  const [paidAt] = useState(newAttemptInstant);
  const [formError, setFormError] = useState<string | null>(null);

  const { state, run, isPending } = useGuardedAction(
    recordExpensePaymentAction,
    onRecorded,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = parseMoneyInput(amount);
    if (!parsed.ok) return setFormError(MONEY_PARSE_MESSAGES[parsed.reason]);
    if (parsed.number > outstanding)
      return setFormError(EXPENSE_ERROR_MESSAGES.FN005);

    run({
      tenantSlug,
      expenseId,
      amount: parsed.number,
      method,
      paidAt,
      note: note.trim() || undefined,
      idempotencyKey,
    });
  }

  const serverError = state && !state.success ? state.error : null;
  const message = formError ?? serverError?.message ?? null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{labels.payment.title}</DialogTitle>
            <DialogDescription>
              {fillTemplate(labels.payment.remaining, {
                amount: formatMoney(outstanding, currency),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-payment-amount-input">
                {labels.payment.amount} ({currency})
              </Label>
              <Input
                id="expense-payment-amount-input"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={isPending}
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-payment-method-input">
                {labels.payment.method}
              </Label>
              <SelectField
                id="expense-payment-method-input"
                value={method}
                onChange={(e) =>
                  setMethod(e.target.value as ExpensePaymentMethod)
                }
                disabled={isPending}
              >
                {EXPENSE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {labels.methods[m]}
                  </option>
                ))}
              </SelectField>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-payment-note-input">
                {labels.payment.note}
              </Label>
              <Input
                id="expense-payment-note-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                disabled={isPending}
              />
            </div>

            {message ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-destructive text-sm" role="alert">
                  {message}
                </p>
                {serverError?.code === "CONFLICT" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRefresh}
                  >
                    {labels.payment.refresh}
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
              {labels.payment.cancel}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? labels.payment.submitting : labels.payment.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
