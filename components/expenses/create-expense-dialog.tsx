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
import { Switch } from "@/components/ui/switch";
import { SelectField } from "@/components/expenses/select-field";
import type { ExpenseBranchOption } from "@/components/expenses/expense-filters";
import { useGuardedAction } from "@/components/expenses/use-guarded-action";
import {
  createExpenseAction,
  type CreateExpenseInput,
} from "@/lib/modules/expenses/actions";
import {
  newAttemptInstant,
  newAttemptKey,
} from "@/lib/modules/expenses/attempt";
import { EXPENSE_ERROR_MESSAGES } from "@/lib/modules/expenses/error-codes";
import { categoryLabel } from "@/lib/modules/expenses/format";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import {
  MONEY_PARSE_MESSAGES,
  parseMoneyInput,
} from "@/lib/modules/expenses/money";
import {
  EXPENSE_PAYMENT_METHODS,
  type ExpenseCategory,
  type ExpensePaymentMethod,
  type ExpenseWriteResult,
} from "@/lib/modules/expenses/types";

/**
 * Faz FIN.1B.1 — "Yeni gider". ONE mounted dialog is ONE attempt: the idempotency key and the initial payment's instant are
 * useState initializers, created once at mount and never recomputed (not on render, not on submit, not when the
 * "Hemen ödendi" section is toggled). A failed submit keeps the dialog mounted, so the retry sends the identical key and the
 * identical payload and the database returns the original result instead of a conflict. The parent mounts this component
 * only while it is open ({open && <CreateExpenseDialog />}); closing and reopening is a fresh mount, a fresh key, a fresh
 * instant. The initial payment is created in the same database transaction as the expense (a payment failure rolls the
 * expense back), and there is no editable payment date in v1: the payment is stamped with the instant of this attempt.
 */
export function CreateExpenseDialog({
  tenantSlug,
  categories,
  branches,
  defaultDate,
  labels,
  onClose,
  onCreated,
  onRefresh,
}: {
  tenantSlug: string;
  categories: ExpenseCategory[];
  branches: ExpenseBranchOption[];
  /** The tenant-local "today", from the overview's reference date. */
  defaultDate: string;
  labels: ExpenseLabels;
  onClose: () => void;
  onCreated: (result: ExpenseWriteResult) => void;
  /** After a conflict ("Yenile"): refresh the page data and close. */
  onRefresh: () => void;
}) {
  const [categoryKey, setCategoryKey] = useState("");
  const [description, setDescription] = useState("");
  const [expenseDate, setExpenseDate] = useState(defaultDate);
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [branchId, setBranchId] = useState("general");
  const [vendor, setVendor] = useState("");
  const [note, setNote] = useState("");

  const [payNow, setPayNow] = useState(false);
  // null = "follow the expense amount": the initial payment defaults to paying the whole expense until the user edits it.
  const [paymentAmountEdit, setPaymentAmountEdit] = useState<string | null>(
    null,
  );
  const [paymentMethod, setPaymentMethod] =
    useState<ExpensePaymentMethod>("cash");
  const [paymentNote, setPaymentNote] = useState("");

  const [idempotencyKey] = useState(newAttemptKey);
  const [paidAt] = useState(newAttemptInstant);

  const [formError, setFormError] = useState<string | null>(null);

  const { state, run, isPending } = useGuardedAction(
    createExpenseAction,
    onCreated,
  );

  const paymentAmount = paymentAmountEdit ?? amount;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!categoryKey)
      return setFormError(labels.create.validation.categoryRequired);
    if (!description.trim())
      return setFormError(labels.create.validation.descriptionRequired);
    if (!expenseDate)
      return setFormError(labels.create.validation.dateRequired);
    const parsedAmount = parseMoneyInput(amount);
    if (!parsedAmount.ok)
      return setFormError(MONEY_PARSE_MESSAGES[parsedAmount.reason]);
    if (dueDate && dueDate < expenseDate)
      return setFormError(labels.create.validation.dueBeforeExpense);

    let initialPayment: CreateExpenseInput["initialPayment"];
    if (payNow) {
      const parsedPayment = parseMoneyInput(paymentAmount);
      if (!parsedPayment.ok)
        return setFormError(MONEY_PARSE_MESSAGES[parsedPayment.reason]);
      if (parsedPayment.number > parsedAmount.number)
        return setFormError(EXPENSE_ERROR_MESSAGES.FN005);
      initialPayment = {
        amount: parsedPayment.number,
        method: paymentMethod,
        paidAt,
        note: paymentNote.trim() || undefined,
      };
    }

    run({
      tenantSlug,
      categoryKey,
      description: description.trim(),
      expenseDate,
      amount: parsedAmount.number,
      dueDate: dueDate || undefined,
      branchId: branchId === "general" ? null : branchId,
      vendorName: vendor.trim() || undefined,
      note: note.trim() || undefined,
      idempotencyKey,
      initialPayment,
    });
  }

  const fixed = categories.filter((c) => c.kind === "fixed");
  const variable = categories.filter((c) => c.kind === "variable");
  const serverError = state && !state.success ? state.error : null;
  const message = formError ?? serverError?.message ?? null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{labels.create.title}</DialogTitle>
            <DialogDescription>{labels.create.description}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-category">
                {labels.create.fields.category}
              </Label>
              <SelectField
                id="expense-category"
                value={categoryKey}
                onChange={(e) => setCategoryKey(e.target.value)}
                disabled={isPending}
                autoFocus
              >
                <option value="">
                  {labels.create.fields.categoryPlaceholder}
                </option>
                <optgroup label={labels.kind.fixed}>
                  {fixed.map((c) => (
                    <option key={c.key} value={c.key}>
                      {categoryLabel(labels, c.key)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={labels.kind.variable}>
                  {variable.map((c) => (
                    <option key={c.key} value={c.key}>
                      {categoryLabel(labels, c.key)}
                    </option>
                  ))}
                </optgroup>
              </SelectField>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-description">
                {labels.create.fields.description}
              </Label>
              <Input
                id="expense-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={labels.create.fields.descriptionPlaceholder}
                maxLength={200}
                disabled={isPending}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expense-amount">
                  {labels.create.fields.amount}
                </Label>
                <Input
                  id="expense-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0,00"
                  disabled={isPending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expense-date">
                  {labels.create.fields.expenseDate}
                </Label>
                <Input
                  id="expense-date"
                  type="date"
                  value={expenseDate}
                  onChange={(e) => setExpenseDate(e.target.value)}
                  disabled={isPending}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expense-due-date">
                  {labels.create.fields.dueDate}
                </Label>
                <Input
                  id="expense-due-date"
                  type="date"
                  value={dueDate}
                  min={expenseDate || undefined}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expense-branch">
                  {labels.create.fields.branch}
                </Label>
                <SelectField
                  id="expense-branch"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  disabled={isPending}
                >
                  <option value="general">{labels.branchGeneral}</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </SelectField>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-vendor">
                {labels.create.fields.vendor}
              </Label>
              <Input
                id="expense-vendor"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                maxLength={200}
                disabled={isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-note">{labels.create.fields.note}</Label>
              <Input
                id="expense-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                disabled={isPending}
              />
            </div>

            <div className="border-border flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="expense-pay-now"
                  checked={payNow}
                  onCheckedChange={setPayNow}
                  disabled={isPending}
                />
                <Label
                  htmlFor="expense-pay-now"
                  className="text-sm font-medium"
                >
                  {labels.create.payNowToggle}
                </Label>
              </div>
              {payNow ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="expense-payment-amount" className="text-xs">
                      {labels.create.initialPayment.amount}
                    </Label>
                    <Input
                      id="expense-payment-amount"
                      inputMode="decimal"
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmountEdit(e.target.value)}
                      disabled={isPending}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="expense-payment-method" className="text-xs">
                      {labels.create.initialPayment.method}
                    </Label>
                    <SelectField
                      id="expense-payment-method"
                      value={paymentMethod}
                      onChange={(e) =>
                        setPaymentMethod(e.target.value as ExpensePaymentMethod)
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
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="expense-payment-note" className="text-xs">
                      {labels.create.initialPayment.note}
                    </Label>
                    <Input
                      id="expense-payment-note"
                      value={paymentNote}
                      onChange={(e) => setPaymentNote(e.target.value)}
                      maxLength={500}
                      disabled={isPending}
                    />
                  </div>
                </div>
              ) : null}
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
                    {labels.create.refresh}
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
              {labels.create.cancel}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? labels.create.submitting : labels.create.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
