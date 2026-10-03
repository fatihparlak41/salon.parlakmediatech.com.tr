"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ExpenseStatusBadge } from "@/components/expenses/expense-status-badge";
import { fetchExpenseDetail } from "@/lib/modules/expenses/client-queries";
import { mapExpenseErrorCode } from "@/lib/modules/expenses/error-codes";
import {
  categoryLabel,
  fillTemplate,
  kindLabel,
  methodLabel,
} from "@/lib/modules/expenses/format";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import {
  formatDate,
  formatDateTime,
  formatMoney,
} from "@/lib/modules/expenses/money";
import type {
  ExpenseDetail,
  ExpensePaymentView,
  ExpenseReadResult,
} from "@/lib/modules/expenses/types";

/**
 * Faz FIN.1B.1 — the expense detail sheet. It fetches get_expense when it opens (a pure read) and again whenever `revision`
 * changes, which the page bumps after every mutation: the sheet always shows what the database says, never a locally patched
 * copy. It owns no dialogs; the buttons hand the loaded detail to the page, which mounts the dialog for that one attempt.
 * Every mutating button is absent without finance.manage. "Gideri iptal et" is disabled, with the reason beside it, once a
 * payment exists (the database refuses that cancel regardless).
 */
export function ExpenseDetailSheet({
  expenseId,
  revision,
  referenceDate,
  canManage,
  labels,
  onOpenChange,
  onPay,
  onEdit,
  onCancel,
  onVoidPayment,
}: {
  expenseId: string | null;
  revision: number;
  referenceDate: string;
  canManage: boolean;
  labels: ExpenseLabels;
  onOpenChange: (open: boolean) => void;
  onPay: (detail: ExpenseDetail) => void;
  onEdit: (detail: ExpenseDetail) => void;
  onCancel: (detail: ExpenseDetail) => void;
  onVoidPayment: (detail: ExpenseDetail, payment: ExpensePaymentView) => void;
}) {
  return (
    <Sheet open={expenseId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {/* Keyed on the expense: a different expense is a full remount, so no state from the previous one survives. */}
        {expenseId ? (
          <ExpenseDetailBody
            key={expenseId}
            expenseId={expenseId}
            revision={revision}
            referenceDate={referenceDate}
            canManage={canManage}
            labels={labels}
            onPay={onPay}
            onEdit={onEdit}
            onCancel={onCancel}
            onVoidPayment={onVoidPayment}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function ExpenseDetailBody({
  expenseId,
  revision,
  referenceDate,
  canManage,
  labels,
  onPay,
  onEdit,
  onCancel,
  onVoidPayment,
}: {
  expenseId: string;
  revision: number;
  referenceDate: string;
  canManage: boolean;
  labels: ExpenseLabels;
  onPay: (detail: ExpenseDetail) => void;
  onEdit: (detail: ExpenseDetail) => void;
  onCancel: (detail: ExpenseDetail) => void;
  onVoidPayment: (detail: ExpenseDetail, payment: ExpensePaymentView) => void;
}) {
  const [result, setResult] = useState<ExpenseReadResult<ExpenseDetail> | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    fetchExpenseDetail(expenseId, referenceDate).then((next) => {
      if (active) setResult(next);
    });
    return () => {
      active = false;
    };
  }, [expenseId, referenceDate, revision, attempt]);

  if (!result) {
    return (
      <div className="flex flex-col gap-4 p-4" aria-busy="true">
        <SheetHeader className="sr-only">
          <SheetTitle>{labels.title}</SheetTitle>
          <SheetDescription>{labels.detail.description}</SheetDescription>
        </SheetHeader>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <SheetHeader className="p-0">
          <SheetTitle>{labels.title}</SheetTitle>
          <SheetDescription>{labels.detail.description}</SheetDescription>
        </SheetHeader>
        <p className="text-destructive text-sm" role="alert">
          {result.code
            ? mapExpenseErrorCode(result.code)
            : labels.detail.loadError}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {labels.detail.retry}
        </Button>
      </div>
    );
  }

  const d = result.data;
  const cancelled = d.status === "cancelled";
  const money = (amount: number) => formatMoney(amount, d.currency);
  const canPay =
    canManage && (d.status === "open" || d.status === "partially_paid");

  return (
    <>
      <SheetHeader>
        <SheetTitle>{d.description}</SheetTitle>
        <SheetDescription>{labels.detail.description}</SheetDescription>
      </SheetHeader>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <ExpenseStatusBadge
            status={d.status}
            isOverdue={d.isOverdue}
            labels={labels}
          />
          {d.isOverdue && d.daysOverdue !== null ? (
            <span className="text-destructive text-xs">
              {fillTemplate(labels.list.daysOverdue, { days: d.daysOverdue })}
            </span>
          ) : null}
        </div>

        <dl className="flex flex-col gap-2 rounded-lg border p-3">
          <Field label={labels.detail.fields.amount}>
            <span className="font-semibold tabular-nums">
              {money(d.amount)}
            </span>
          </Field>
          <Field label={labels.detail.fields.paid}>
            <span className="tabular-nums">{money(d.paid)}</span>
          </Field>
          {cancelled ? null : (
            <Field label={labels.detail.fields.remaining}>
              <span className="font-semibold tabular-nums">
                {money(d.outstanding)}
              </span>
            </Field>
          )}
        </dl>

        <dl className="flex flex-col gap-2">
          <Field label={labels.detail.fields.category}>
            {categoryLabel(labels, d.categoryKey)} ·{" "}
            {kindLabel(labels, d.categoryKind)}
          </Field>
          <Field label={labels.detail.fields.branch}>
            {d.branchName ?? labels.branchGeneral}
          </Field>
          <Field label={labels.detail.fields.expenseDate}>
            {formatDate(d.expenseDate)}
          </Field>
          {d.dueDate ? (
            <Field label={labels.detail.fields.dueDate}>
              {formatDate(d.dueDate)}
            </Field>
          ) : null}
          {d.vendorName ? (
            <Field label={labels.detail.fields.vendor}>{d.vendorName}</Field>
          ) : null}
          {d.note ? (
            <Field label={labels.detail.fields.note}>{d.note}</Field>
          ) : null}
          {cancelled && d.cancelledAt ? (
            <Field label={labels.detail.fields.cancelledAt}>
              {formatDateTime(d.cancelledAt)}
            </Field>
          ) : null}
          {cancelled && d.cancelReason ? (
            <Field label={labels.detail.fields.cancelReason}>
              {d.cancelReason}
            </Field>
          ) : null}
        </dl>

        {canManage && !cancelled ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              {canPay ? (
                <Button type="button" size="sm" onClick={() => onPay(d)}>
                  {labels.detail.actions.pay}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onEdit(d)}
              >
                {labels.detail.actions.edit}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!d.canCancel}
                aria-describedby={
                  d.canCancel ? undefined : "expense-cancel-hint"
                }
                onClick={() => onCancel(d)}
              >
                {labels.detail.actions.cancel}
              </Button>
            </div>
            {d.canCancel ? null : (
              <p
                id="expense-cancel-hint"
                className="text-muted-foreground text-xs"
              >
                {labels.detail.cancelBlockedHint}
              </p>
            )}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {labels.detail.payments.title}
          </p>
          {d.payments.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {labels.detail.payments.empty}
            </p>
          ) : (
            d.payments.map((p) => (
              <div
                key={p.id}
                className="flex flex-col gap-1.5 rounded-lg border p-2.5 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={
                      p.status === "voided"
                        ? "text-muted-foreground line-through"
                        : "font-medium"
                    }
                  >
                    {money(p.amount)} · {methodLabel(labels, p.method)}
                  </span>
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {formatDateTime(p.paidAt)}
                  </span>
                </div>
                {p.note ? (
                  <p className="text-muted-foreground text-xs">{p.note}</p>
                ) : null}
                {p.status === "voided" ? (
                  <p className="text-muted-foreground text-xs">
                    {labels.status.cancelled}
                    {p.voidReason
                      ? ` · ${fillTemplate(labels.detail.payments.voidedReason, { reason: p.voidReason })}`
                      : ""}
                  </p>
                ) : null}
                {canManage && p.status === "posted" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-auto w-fit p-0 text-xs"
                    onClick={() => onVoidPayment(d, p)}
                  >
                    {labels.detail.actions.voidPayment}
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
