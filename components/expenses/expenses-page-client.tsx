"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CancelExpenseDialog } from "@/components/expenses/cancel-expense-dialog";
import { CreateExpenseDialog } from "@/components/expenses/create-expense-dialog";
import { EditExpenseDialog } from "@/components/expenses/edit-expense-dialog";
import { ExpenseDetailSheet } from "@/components/expenses/expense-detail-sheet";
import {
  ExpenseFilters,
  type ExpenseBranchOption,
} from "@/components/expenses/expense-filters";
import { ExpenseList } from "@/components/expenses/expense-list";
import { ExpenseOverviewCards } from "@/components/expenses/expense-overview-cards";
import { RecordExpensePaymentDialog } from "@/components/expenses/record-expense-payment-dialog";
import { VoidExpensePaymentDialog } from "@/components/expenses/void-expense-payment-dialog";
import { usePathname, useRouter } from "@/lib/i18n/navigation";
import { fetchExpenseDetail } from "@/lib/modules/expenses/client-queries";
import {
  buildExpensesFilterUrl,
  type ExpenseListParams,
  type ExpensesFilters,
} from "@/lib/modules/expenses/filters";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import type {
  ExpenseCategory,
  ExpenseDetail,
  ExpenseListPage,
  ExpenseOverview,
  ExpensePaymentView,
} from "@/lib/modules/expenses/types";

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; detail: ExpenseDetail; nonce: number }
  | { kind: "pay"; detail: ExpenseDetail }
  | { kind: "void"; detail: ExpenseDetail; payment: ExpensePaymentView }
  | { kind: "cancel"; detail: ExpenseDetail }
  | null;

/**
 * Faz FIN.1B.1 — the expense page's only stateful owner. The server page hands it everything for the first paint (cards,
 * first list page, categories, branches); after that:
 *   - filters are URL state (ExpenseFilters navigates, the server page re-renders),
 *   - the detail sheet fetches its own expense and re-fetches when `revision` is bumped,
 *   - every mutation dialog is mounted ONLY while its attempt is open ({dialog.kind === ... && <Dialog />}), so a close
 *     (cancel or success) unmounts it and the next open is a fresh attempt with a fresh idempotency key,
 *   - a successful mutation ends the same way everywhere: the Server Action has already revalidated the page, the dialog
 *     unmounts, and the open detail is refetched.
 */
export function ExpensesPageClient({
  tenantId,
  tenantSlug,
  canManage,
  categories,
  branches,
  overview,
  firstPage,
  filters,
  listParams,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  canManage: boolean;
  categories: ExpenseCategory[];
  branches: ExpenseBranchOption[];
  overview: ExpenseOverview;
  firstPage: ExpenseListPage;
  filters: ExpensesFilters;
  listParams: ExpenseListParams;
  labels: ExpenseLabels;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);

  const referenceDate = overview.referenceDate;
  const effectiveMonth = overview.month.slice(0, 7);

  function afterMutation() {
    setDialog(null);
    setRevision((n) => n + 1);
  }

  /** "Yenile" from a conflict in a dialog on an expense: refetch the detail, then remount the dialog on the new version. */
  async function refreshEditDialog(
    current: Extract<NonNullable<DialogState>, { kind: "edit" }>,
  ) {
    const fresh = await fetchExpenseDetail(current.detail.id, referenceDate);
    if (fresh.ok) {
      setDialog({ kind: "edit", detail: fresh.data, nonce: current.nonce + 1 });
    } else {
      setDialog(null);
    }
    setRevision((n) => n + 1);
    router.refresh();
  }

  function refreshAndClose() {
    setDialog(null);
    setRevision((n) => n + 1);
    router.refresh();
  }

  const isFiltered =
    filters.branch !== "all" ||
    filters.category !== null ||
    filters.status !== null ||
    filters.includeCancelled ||
    filters.overdueOnly ||
    filters.search !== "";

  // The list resets (appended pages dropped) whenever the filters or the server-provided data change.
  const listKey = [
    JSON.stringify(listParams),
    firstPage.items.map((i) => `${i.id}:${i.version}:${i.status}`).join(","),
    firstPage.nextCursor?.id ?? "",
  ].join("|");

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {labels.title}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {labels.description}
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            onClick={() => setDialog({ kind: "create" })}
            className="shrink-0"
          >
            <Plus />
            {labels.newExpense}
          </Button>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col gap-6">
        <ExpenseOverviewCards
          overview={overview}
          labels={labels}
          onShowOverdue={() =>
            router.push(
              buildExpensesFilterUrl(pathname, window.location.search, {
                overdue: "1",
              }),
            )
          }
        />

        <ExpenseFilters
          filters={filters}
          effectiveMonth={effectiveMonth}
          branches={branches}
          categories={categories}
          labels={labels}
        />

        <ExpenseList
          key={listKey}
          tenantId={tenantId}
          firstPage={firstPage}
          listParams={listParams}
          referenceDate={referenceDate}
          isFiltered={isFiltered}
          canManage={canManage}
          labels={labels}
          onSelect={setSelectedId}
          onCreate={() => setDialog({ kind: "create" })}
        />
      </div>

      <ExpenseDetailSheet
        expenseId={selectedId}
        revision={revision}
        referenceDate={referenceDate}
        canManage={canManage}
        labels={labels}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onPay={(detail) => setDialog({ kind: "pay", detail })}
        onEdit={(detail) => setDialog({ kind: "edit", detail, nonce: 0 })}
        onCancel={(detail) => setDialog({ kind: "cancel", detail })}
        onVoidPayment={(detail, payment) =>
          setDialog({ kind: "void", detail, payment })
        }
      />

      {canManage && dialog?.kind === "create" ? (
        <CreateExpenseDialog
          tenantSlug={tenantSlug}
          categories={categories}
          branches={branches}
          defaultDate={referenceDate}
          labels={labels}
          onClose={() => setDialog(null)}
          onCreated={() => setDialog(null)}
          onRefresh={refreshAndClose}
        />
      ) : null}

      {canManage && dialog?.kind === "edit" ? (
        <EditExpenseDialog
          key={`${dialog.detail.id}:${dialog.detail.version}:${dialog.nonce}`}
          detail={dialog.detail}
          tenantSlug={tenantSlug}
          categories={categories}
          branches={branches}
          labels={labels}
          onClose={() => setDialog(null)}
          onUpdated={afterMutation}
          onRefresh={() => void refreshEditDialog(dialog)}
        />
      ) : null}

      {canManage && dialog?.kind === "pay" ? (
        <RecordExpensePaymentDialog
          expenseId={dialog.detail.id}
          tenantSlug={tenantSlug}
          outstanding={dialog.detail.outstanding}
          currency={dialog.detail.currency}
          labels={labels}
          onClose={() => setDialog(null)}
          onRecorded={afterMutation}
          onRefresh={refreshAndClose}
        />
      ) : null}

      {canManage && dialog?.kind === "void" ? (
        <VoidExpensePaymentDialog
          payment={dialog.payment}
          currency={dialog.detail.currency}
          tenantSlug={tenantSlug}
          labels={labels}
          onClose={() => setDialog(null)}
          onVoided={afterMutation}
          onRefresh={refreshAndClose}
        />
      ) : null}

      {canManage && dialog?.kind === "cancel" ? (
        <CancelExpenseDialog
          expenseId={dialog.detail.id}
          tenantSlug={tenantSlug}
          labels={labels}
          onClose={() => setDialog(null)}
          onCancelled={afterMutation}
          onRefresh={refreshAndClose}
        />
      ) : null}
    </div>
  );
}
