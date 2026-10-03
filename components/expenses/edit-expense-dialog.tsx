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
import type { ExpenseBranchOption } from "@/components/expenses/expense-filters";
import { useGuardedAction } from "@/components/expenses/use-guarded-action";
import { updateExpenseAction } from "@/lib/modules/expenses/actions";
import {
  categoryLabel,
  fillTemplate,
  toEditableAmount,
} from "@/lib/modules/expenses/format";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import {
  MONEY_PARSE_MESSAGES,
  formatMoney,
  parseMoneyInput,
} from "@/lib/modules/expenses/money";
import type {
  ExpenseCategory,
  ExpenseDetail,
  ExpenseWriteResult,
} from "@/lib/modules/expenses/types";

/**
 * Faz FIN.1B.1 — "Gideri düzenle". A full-state edit: every field is submitted together with the `version` the form was loaded
 * with (captured once, at mount). If somebody changed the expense since (a payment, another edit), the database answers with a
 * conflict, the dialog shows the message and a "Yenile" button, and the parent refetches the detail and remounts this dialog
 * with the new version. After the first posted payment the date, branch and category are locked (disabled, with the reason)
 * and the amount cannot go below the posted total, which the amount hint shows. The database enforces both regardless of
 * what this form allows.
 */
export function EditExpenseDialog({
  detail,
  tenantSlug,
  categories,
  branches,
  labels,
  onClose,
  onUpdated,
  onRefresh,
}: {
  detail: ExpenseDetail;
  tenantSlug: string;
  categories: ExpenseCategory[];
  branches: ExpenseBranchOption[];
  labels: ExpenseLabels;
  onClose: () => void;
  onUpdated: (result: ExpenseWriteResult) => void;
  /** After a conflict ("Yenile"): refetch the detail and remount this dialog with the new version. */
  onRefresh: () => void;
}) {
  const [expectedVersion] = useState(detail.version);
  const [categoryKey, setCategoryKey] = useState(detail.categoryKey);
  const [description, setDescription] = useState(detail.description);
  const [expenseDate, setExpenseDate] = useState(detail.expenseDate);
  const [amount, setAmount] = useState(toEditableAmount(detail.amount));
  const [dueDate, setDueDate] = useState(detail.dueDate ?? "");
  const [branchId, setBranchId] = useState(detail.branchId ?? "general");
  const [vendor, setVendor] = useState(detail.vendorName ?? "");
  const [note, setNote] = useState(detail.note ?? "");
  const [formError, setFormError] = useState<string | null>(null);

  const { state, run, isPending } = useGuardedAction(
    updateExpenseAction,
    onUpdated,
  );

  const locked = detail.structureLocked;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!description.trim())
      return setFormError(labels.create.validation.descriptionRequired);
    if (!expenseDate)
      return setFormError(labels.create.validation.dateRequired);
    const parsedAmount = parseMoneyInput(amount);
    if (!parsedAmount.ok)
      return setFormError(MONEY_PARSE_MESSAGES[parsedAmount.reason]);
    if (dueDate && dueDate < expenseDate)
      return setFormError(labels.create.validation.dueBeforeExpense);

    run({
      tenantSlug,
      expenseId: detail.id,
      expectedVersion,
      categoryKey,
      description: description.trim(),
      expenseDate,
      amount: parsedAmount.number,
      dueDate: dueDate || undefined,
      branchId: branchId === "general" ? null : branchId,
      vendorName: vendor.trim() || undefined,
      note: note.trim() || undefined,
    });
  }

  const known = new Set(categories.map((c) => c.key));
  const fixed = categories.filter((c) => c.kind === "fixed");
  const variable = categories.filter((c) => c.kind === "variable");
  const branchKnown =
    detail.branchId === null || branches.some((b) => b.id === detail.branchId);
  const serverError = state && !state.success ? state.error : null;
  const message = formError ?? serverError?.message ?? null;
  const lockedHint = locked ? (
    <p className="text-muted-foreground text-xs">{labels.edit.lockedHint}</p>
  ) : null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{labels.edit.title}</DialogTitle>
            <DialogDescription>{labels.edit.description}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-expense-category">
                {labels.create.fields.category}
              </Label>
              <SelectField
                id="edit-expense-category"
                value={categoryKey}
                onChange={(e) => setCategoryKey(e.target.value)}
                disabled={locked || isPending}
              >
                {!known.has(detail.categoryKey) ? (
                  <option value={detail.categoryKey}>
                    {categoryLabel(labels, detail.categoryKey)}
                  </option>
                ) : null}
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
              {lockedHint}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-expense-description">
                {labels.create.fields.description}
              </Label>
              <Input
                id="edit-expense-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
                disabled={isPending}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-expense-amount">
                  {labels.create.fields.amount}
                </Label>
                <Input
                  id="edit-expense-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-describedby={
                    detail.amountFloor > 0
                      ? "edit-expense-amount-hint"
                      : undefined
                  }
                  disabled={isPending}
                />
                {detail.amountFloor > 0 ? (
                  <p
                    id="edit-expense-amount-hint"
                    className="text-muted-foreground text-xs"
                  >
                    {fillTemplate(labels.edit.amountFloorHint, {
                      amount: formatMoney(detail.amountFloor, detail.currency),
                    })}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-expense-date">
                  {labels.create.fields.expenseDate}
                </Label>
                <Input
                  id="edit-expense-date"
                  type="date"
                  value={expenseDate}
                  onChange={(e) => setExpenseDate(e.target.value)}
                  disabled={locked || isPending}
                />
                {lockedHint}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-expense-due-date">
                  {labels.create.fields.dueDate}
                </Label>
                <Input
                  id="edit-expense-due-date"
                  type="date"
                  value={dueDate}
                  min={expenseDate || undefined}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-expense-branch">
                  {labels.create.fields.branch}
                </Label>
                <SelectField
                  id="edit-expense-branch"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  disabled={locked || isPending}
                >
                  <option value="general">{labels.branchGeneral}</option>
                  {!branchKnown && detail.branchId ? (
                    <option value={detail.branchId}>
                      {detail.branchName ?? detail.branchId}
                    </option>
                  ) : null}
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </SelectField>
                {lockedHint}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-expense-vendor">
                {labels.create.fields.vendor}
              </Label>
              <Input
                id="edit-expense-vendor"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                maxLength={200}
                disabled={isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-expense-note">
                {labels.create.fields.note}
              </Label>
              <Input
                id="edit-expense-note"
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
                    {labels.edit.refresh}
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
              {labels.edit.cancel}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? labels.edit.submitting : labels.edit.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
