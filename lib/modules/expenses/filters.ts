import {
  EXPENSE_STATUSES,
  type ExpenseCursor,
  type ExpenseStatus,
} from "./types";

/**
 * Faz FIN.1B.1 — the expense page's whole filter state lives in the URL (refreshable, shareable, back-button friendly).
 *
 *   month=2026-09 | month=all   the tenant-local month (default: the month of the reference date) or every month
 *   branch=all | general | <uuid>
 *   category=<key>   status=open|partially_paid|paid|cancelled
 *   cancelled=1      include cancelled rows in the default list
 *   overdue=1        only open/partially paid rows past their due date; overdue is inherently all-time, so it ignores the month
 *   q=<text>         case-insensitive search over description and vendor (max 100 characters)
 *
 * Parsing is lenient on purpose: garbage in the URL falls back to the default and never throws.
 */

export type ExpensesFilters = {
  /** "YYYY-MM", or null for the default month (the reference date's month, decided by the database). */
  month: string | null;
  allMonths: boolean;
  /** "all", "general" (Genel, no branch) or a branch uuid. */
  branch: string;
  category: string | null;
  status: ExpenseStatus | null;
  includeCancelled: boolean;
  overdueOnly: boolean;
  search: string;
};

export const DEFAULT_EXPENSES_FILTERS: ExpensesFilters = {
  month: null,
  allMonths: false,
  branch: "all",
  category: null,
  status: null,
  includeCancelled: false,
  overdueOnly: false,
  search: "",
};

const MONTH_RE = /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const SEARCH_MAX = 100;

type RawParams = Record<string, string | string[] | undefined>;

function first(raw: RawParams, key: string): string | undefined {
  const value = raw[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parseExpensesFilters(raw: RawParams): ExpensesFilters {
  const monthParam = first(raw, "month");
  const allMonths = monthParam === "all";
  const month = monthParam && MONTH_RE.test(monthParam) ? monthParam : null;

  const branchParam = first(raw, "branch");
  const branch =
    branchParam === "general"
      ? "general"
      : branchParam && UUID_RE.test(branchParam)
        ? branchParam.toLowerCase()
        : "all";

  const categoryParam = first(raw, "category");
  const category =
    categoryParam && CATEGORY_RE.test(categoryParam) ? categoryParam : null;

  const statusParam = first(raw, "status");
  const status = (EXPENSE_STATUSES as readonly string[]).includes(
    statusParam ?? "",
  )
    ? (statusParam as ExpenseStatus)
    : null;

  return {
    month,
    allMonths,
    branch,
    category,
    status,
    includeCancelled: first(raw, "cancelled") === "1",
    overdueOnly: first(raw, "overdue") === "1",
    search: (first(raw, "q") ?? "").trim().slice(0, SEARCH_MAX),
  };
}

/** Applies updates to the current query string: null removes a parameter, a value sets it. Returns "pathname?query" (no "?" when empty). */
export function buildExpensesFilterUrl(
  pathname: string,
  currentSearch: string,
  updates: Record<string, string | null>,
): string {
  const params = new URLSearchParams(
    currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch,
  );
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** "YYYY-MM" shifted by whole months. */
export function shiftMonth(month: string, delta: number): string {
  const match = MONTH_RE.exec(month);
  if (!match) return month;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const monthNumber = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}`;
}

/** The inclusive first and last calendar day of "YYYY-MM" (pure date arithmetic, no timezone involved). */
export function monthBounds(month: string): { from: string; to: string } {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error(`invalid month: ${month}`);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mm = String(monthNumber).padStart(2, "0");
  return {
    from: `${match[1]}-${mm}-01`,
    to: `${match[1]}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** The first day of the month that "YYYY-MM-DD" falls in, as the "YYYY-MM" the filters use. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Everything the list query depends on, derived from the URL filters and the effective month. */
export type ExpenseListParams = {
  fromDate: string | null;
  toDate: string | null;
  branchId: string | null;
  generalOnly: boolean;
  categoryKey: string | null;
  status: ExpenseStatus | null;
  includeCancelled: boolean;
  overdueOnly: boolean;
  search: string | null;
};

/**
 * @param effectiveMonth "YYYY-MM": the month the overview used (the URL's, or the database's default for the reference date)
 */
export function listParamsFor(
  filters: ExpensesFilters,
  effectiveMonth: string,
): ExpenseListParams {
  const scoped = !filters.allMonths && !filters.overdueOnly;
  const bounds = scoped ? monthBounds(effectiveMonth) : null;
  return {
    fromDate: bounds?.from ?? null,
    toDate: bounds?.to ?? null,
    branchId:
      filters.branch !== "all" && filters.branch !== "general"
        ? filters.branch
        : null,
    generalOnly: filters.branch === "general",
    categoryKey: filters.category,
    status: filters.status,
    includeCancelled: filters.includeCancelled,
    overdueOnly: filters.overdueOnly,
    search: filters.search || null,
  };
}

/** The typed argument object of public.list_expenses for these params (null becomes undefined: the RPC defaults apply). */
export function listRpcArgs(
  tenantId: string,
  params: ExpenseListParams,
  cursor?: ExpenseCursor | null,
  referenceDate?: string | null,
) {
  return {
    p_tenant_id: tenantId,
    p_from_date: params.fromDate ?? undefined,
    p_to_date: params.toDate ?? undefined,
    p_branch_id: params.branchId ?? undefined,
    p_general_only: params.generalOnly,
    p_category_key: params.categoryKey ?? undefined,
    p_status: params.status ?? undefined,
    p_include_cancelled: params.includeCancelled,
    p_overdue_only: params.overdueOnly,
    p_search: params.search ?? undefined,
    p_limit: 50,
    p_cursor_date: cursor?.expenseDate ?? undefined,
    p_cursor_id: cursor?.id ?? undefined,
    p_reference_date: referenceDate ?? undefined,
  };
}
