"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { usePathname, useRouter } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SelectField } from "@/components/expenses/select-field";
import {
  buildExpensesFilterUrl,
  shiftMonth,
  type ExpensesFilters,
} from "@/lib/modules/expenses/filters";
import { categoryLabel, monthTitle } from "@/lib/modules/expenses/format";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import {
  EXPENSE_STATUSES,
  type ExpenseCategory,
} from "@/lib/modules/expenses/types";

export type ExpenseBranchOption = { id: string; name: string };

/**
 * Faz FIN.1B.1 — the filter bar. The URL is the whole state: every change is a normal navigation that re-runs the server page
 * with the new search params (refreshable, shareable, back-button friendly). The router.push is wrapped in a transition so
 * React keeps showing the current data while the next page loads, and `isPending` drives the "Güncelleniyor…" cue.
 */
export function ExpenseFilters({
  filters,
  effectiveMonth,
  branches,
  categories,
  labels,
}: {
  filters: ExpensesFilters;
  /** "YYYY-MM" the overview and list are currently showing. */
  effectiveMonth: string;
  branches: ExpenseBranchOption[];
  categories: ExpenseCategory[];
  labels: ExpenseLabels;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const navigate = useCallback(
    (updates: Record<string, string | null>) => {
      const url = buildExpensesFilterUrl(
        pathname,
        window.location.search,
        updates,
      );
      startTransition(() => {
        router.push(url);
      });
    },
    [pathname, router],
  );

  // The search box keeps its own text while typing; a change that arrives from the URL (clear, back button) replaces it.
  const [searchText, setSearchText] = useState(filters.search);
  const [seenSearch, setSeenSearch] = useState(filters.search);
  if (filters.search !== seenSearch) {
    setSeenSearch(filters.search);
    if (filters.search !== searchText.trim()) setSearchText(filters.search);
  }

  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === filters.search) return;
    const handle = setTimeout(() => navigate({ q: trimmed || null }), 300);
    return () => clearTimeout(handle);
  }, [searchText, filters.search, navigate]);

  const monthLocked = filters.allMonths || filters.overdueOnly;
  const anyActive =
    filters.month !== null ||
    filters.allMonths ||
    filters.branch !== "all" ||
    filters.category !== null ||
    filters.status !== null ||
    filters.includeCancelled ||
    filters.overdueOnly ||
    filters.search !== "";

  const fixed = categories.filter((c) => c.kind === "fixed");
  const variable = categories.filter((c) => c.kind === "variable");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={labels.filters.previousMonth}
          disabled={monthLocked || isPending}
          onClick={() => navigate({ month: shiftMonth(effectiveMonth, -1) })}
        >
          <ChevronLeft />
        </Button>
        <span
          className="min-w-32 text-center text-sm font-medium"
          aria-live="polite"
        >
          {filters.allMonths
            ? labels.filters.allMonths
            : monthTitle(effectiveMonth)}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={labels.filters.nextMonth}
          disabled={monthLocked || isPending}
          onClick={() => navigate({ month: shiftMonth(effectiveMonth, 1) })}
        >
          <ChevronRight />
        </Button>
        <Button
          type="button"
          variant={filters.allMonths ? "default" : "outline"}
          size="sm"
          aria-pressed={filters.allMonths}
          disabled={filters.overdueOnly || isPending}
          onClick={() => navigate({ month: filters.allMonths ? null : "all" })}
        >
          {labels.filters.allMonths}
        </Button>
        {isPending ? (
          <span className="text-muted-foreground text-xs" role="status">
            {labels.filters.updating}
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expense-filter-branch" className="text-xs">
            {labels.filters.branch}
          </Label>
          <SelectField
            id="expense-filter-branch"
            value={filters.branch}
            disabled={isPending}
            onChange={(e) =>
              navigate({
                branch: e.target.value === "all" ? null : e.target.value,
              })
            }
          >
            <option value="all">{labels.filters.allBranches}</option>
            <option value="general">{labels.branchGeneral}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expense-filter-category" className="text-xs">
            {labels.filters.category}
          </Label>
          <SelectField
            id="expense-filter-category"
            value={filters.category ?? ""}
            disabled={isPending}
            onChange={(e) => navigate({ category: e.target.value || null })}
          >
            <option value="">{labels.filters.allCategories}</option>
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
          <Label htmlFor="expense-filter-status" className="text-xs">
            {labels.filters.status}
          </Label>
          <SelectField
            id="expense-filter-status"
            value={filters.status ?? ""}
            disabled={isPending}
            onChange={(e) => navigate({ status: e.target.value || null })}
          >
            <option value="">{labels.filters.allStatuses}</option>
            {EXPENSE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {labels.status[s]}
              </option>
            ))}
          </SelectField>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expense-filter-search" className="text-xs">
            {labels.filters.searchPlaceholder}
          </Label>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              id="expense-filter-search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={labels.filters.searchPlaceholder}
              maxLength={100}
              className="pl-8"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id="expense-filter-cancelled"
            checked={filters.includeCancelled}
            disabled={isPending}
            onCheckedChange={(checked) =>
              navigate({ cancelled: checked ? "1" : null })
            }
          />
          <Label
            htmlFor="expense-filter-cancelled"
            className="text-sm font-normal"
          >
            {labels.filters.showCancelled}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="expense-filter-overdue"
            checked={filters.overdueOnly}
            disabled={isPending}
            onCheckedChange={(checked) =>
              navigate({ overdue: checked ? "1" : null })
            }
          />
          <Label
            htmlFor="expense-filter-overdue"
            className="text-sm font-normal"
          >
            {labels.filters.overdueOnly}
          </Label>
        </div>
        {filters.overdueOnly ? (
          <span className="text-muted-foreground text-xs">
            {labels.filters.overdueOnlyHint}
          </span>
        ) : null}
        {anyActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() =>
              navigate({
                month: null,
                branch: null,
                category: null,
                status: null,
                cancelled: null,
                overdue: null,
                q: null,
              })
            }
          >
            {labels.filters.clear}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
