"use client";

import { useState } from "react";
import { Plus, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExpenseStatusBadge } from "@/components/expenses/expense-status-badge";
import { fetchExpensesPage } from "@/lib/modules/expenses/client-queries";
import type { ExpenseListParams } from "@/lib/modules/expenses/filters";
import { categoryLabel, fillTemplate } from "@/lib/modules/expenses/format";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import { formatDate, formatMoney } from "@/lib/modules/expenses/money";
import type {
  ExpenseCursor,
  ExpenseListItem,
  ExpenseListPage,
} from "@/lib/modules/expenses/types";

/**
 * Faz FIN.1B.1 — the expense list. One ledger-row layout for every width (description and amount on the first line, the
 * category, branch, date and remaining balance on the second, status and due date on the third), so a phone and a desktop
 * render the same structure and nothing is duplicated in the DOM. Keyset "Daha fazla" goes through the read RPC; appended pages
 * live in this component's own state, which the parent resets (by key) whenever the server-provided first page or the filters
 * change.
 */
export function ExpenseList({
  tenantId,
  firstPage,
  listParams,
  referenceDate,
  isFiltered,
  canManage,
  labels,
  onSelect,
  onCreate,
}: {
  tenantId: string;
  firstPage: ExpenseListPage;
  listParams: ExpenseListParams;
  referenceDate: string;
  isFiltered: boolean;
  canManage: boolean;
  labels: ExpenseLabels;
  onSelect: (expenseId: string) => void;
  onCreate: () => void;
}) {
  const [appended, setAppended] = useState<ExpenseListItem[]>([]);
  const [cursor, setCursor] = useState<ExpenseCursor | null>(
    firstPage.nextCursor,
  );
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const items = [...firstPage.items, ...appended];

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setLoadFailed(false);
    const result = await fetchExpensesPage(
      tenantId,
      listParams,
      cursor,
      referenceDate,
    );
    if (result.ok) {
      setAppended((prev) => [...prev, ...result.data.items]);
      setCursor(result.data.nextCursor);
    } else {
      setLoadFailed(true);
    }
    setLoading(false);
  }

  if (items.length === 0) {
    if (isFiltered) {
      return (
        <p className="text-muted-foreground py-10 text-center text-sm">
          {labels.list.noResults}
        </p>
      );
    }
    return (
      <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
        <div className="bg-muted flex size-12 items-center justify-center rounded-full">
          <Receipt className="text-muted-foreground size-6" />
        </div>
        <h2 className="text-base font-medium">{labels.list.emptyTitle}</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          {labels.list.emptyDescription}
        </p>
        {canManage ? (
          <Button type="button" onClick={onCreate} className="mt-2">
            <Plus />
            {labels.list.emptyCta}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="border-border divide-border divide-y overflow-hidden rounded-xl border">
        {items.map((item) => {
          const cancelled = item.status === "cancelled";
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={`hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full flex-col gap-1.5 px-3 py-3 text-left outline-none focus-visible:ring-3 ${cancelled ? "text-muted-foreground" : ""}`}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span
                      className={`block truncate text-sm font-medium ${cancelled ? "line-through" : ""}`}
                    >
                      {item.description}
                    </span>
                    {item.vendorName ? (
                      <span className="text-muted-foreground block truncate text-xs">
                        {fillTemplate(labels.list.vendor, {
                          name: item.vendorName,
                        })}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-right text-sm font-semibold tabular-nums">
                    {formatMoney(item.amount, item.currency)}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground min-w-0 truncate text-xs">
                    {categoryLabel(labels, item.categoryKey)} ·{" "}
                    {item.branchName ?? labels.branchGeneral} ·{" "}
                    {formatDate(item.expenseDate)}
                  </span>
                  {cancelled ? null : (
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {labels.detail.fields.remaining}:{" "}
                      {formatMoney(item.outstanding, item.currency)}
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <ExpenseStatusBadge
                    status={item.status}
                    isOverdue={item.isOverdue}
                    labels={labels}
                  />
                  {item.dueDate ? (
                    <span
                      className={`text-xs ${item.isOverdue ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {item.isOverdue && item.daysOverdue !== null
                        ? fillTemplate(labels.list.daysOverdue, {
                            days: item.daysOverdue,
                          })
                        : fillTemplate(labels.list.dueOn, {
                            date: formatDate(item.dueDate),
                          })}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {cursor ? (
        <div className="flex flex-col items-center gap-2">
          {loadFailed ? (
            <p className="text-destructive text-sm" role="alert">
              {labels.list.loadMoreError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={loadMore}
            disabled={loading}
          >
            {loading
              ? labels.list.loadingMore
              : loadFailed
                ? labels.list.retry
                : labels.list.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
