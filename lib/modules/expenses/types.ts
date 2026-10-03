/**
 * Faz FIN.1B.1 — shapes of the expense read models and write results, and the key sets the SQL returns.
 *
 * The RPCs return curated jsonb (see 20261003090000): camelCase keys, numbers as JSON numbers, no user ids, no idempotency
 * data, no tenant id. The *_KEYS constants below are the contract tests' anchor (expense-contracts.test.ts compares them with
 * what the live RPCs return) so a column quietly added to a read model fails a test instead of leaking to the browser.
 */

export const EXPENSE_STATUSES = [
  "open",
  "partially_paid",
  "paid",
  "cancelled",
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_PAYMENT_METHODS = [
  "cash",
  "card",
  "bank_transfer",
  "other",
] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

/** The seeded category keys in display order (the catalog itself is read from the database). */
export const EXPENSE_CATEGORY_KEY_LIST = [
  "rent",
  "electricity",
  "water",
  "internet",
  "phone",
  "accountant",
  "software",
  "pos_fees",
  "supplies",
  "beauty_products",
  "cleaning",
  "advertising",
  "food",
  "transport",
  "repairs",
  "other",
] as const;

export type ExpenseCategoryKind = "fixed" | "variable";

export type ExpenseCategory = {
  key: string;
  kind: ExpenseCategoryKind;
  displayOrder: number;
};

export type ExpenseListItem = {
  id: string;
  branchId: string | null;
  branchName: string | null;
  categoryKey: string;
  categoryKind: ExpenseCategoryKind;
  description: string;
  vendorName: string | null;
  expenseDate: string;
  dueDate: string | null;
  amount: number;
  currency: string;
  paid: number;
  outstanding: number;
  status: ExpenseStatus;
  isOverdue: boolean;
  daysOverdue: number | null;
  version: number;
};

export type ExpenseCursor = { expenseDate: string; id: string };

export type ExpenseListPage = {
  items: ExpenseListItem[];
  nextCursor: ExpenseCursor | null;
};

export type ExpensePaymentView = {
  id: string;
  amount: number;
  method: ExpensePaymentMethod;
  paidAt: string;
  note: string | null;
  status: "posted" | "voided";
  voidReason: string | null;
};

export type ExpenseDetail = ExpenseListItem & {
  note: string | null;
  /** The posted total: an edit may never lower the amount below it. */
  amountFloor: number;
  /** After the first posted payment (or a cancel) the date, branch and category are locked. */
  structureLocked: boolean;
  canCancel: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  payments: ExpensePaymentView[];
};

export type ExpenseOverviewAmount = { total: number; count: number };

export type ExpenseOverviewCurrency = {
  currency: string;
  incurred: number;
  paid: number;
  outstanding: ExpenseOverviewAmount;
  overdue: ExpenseOverviewAmount;
  upcoming: ExpenseOverviewAmount & { withinDays: number };
};

export type ExpenseOverview = {
  /** First day of the selected tenant-local month, YYYY-MM-DD. */
  month: string;
  /** The tenant-local date the overdue/upcoming split was computed for, YYYY-MM-DD. */
  referenceDate: string;
  primaryCurrency: string;
  byCurrency: ExpenseOverviewCurrency[];
};

export type ExpenseWriteResult = {
  expenseId: string;
  paymentId?: string | null;
  status: ExpenseStatus;
  version: number;
  noop: boolean;
};

/** A read through the server Supabase client: the data or a stable error code (never a thrown exception). */
export type ExpenseReadResult<T> =
  { ok: true; data: T } | { ok: false; code: string | null };

// ---------------------------------------------------------------------------------------------------------------
// Key sets (sorted) the SQL read models and write results return
// ---------------------------------------------------------------------------------------------------------------
export const EXPENSE_CATEGORY_ITEM_KEYS = [
  "displayOrder",
  "key",
  "kind",
] as const;

export const EXPENSE_LIST_ITEM_KEYS = [
  "amount",
  "branchId",
  "branchName",
  "categoryKey",
  "categoryKind",
  "currency",
  "daysOverdue",
  "description",
  "dueDate",
  "expenseDate",
  "id",
  "isOverdue",
  "outstanding",
  "paid",
  "status",
  "vendorName",
  "version",
] as const;

export const EXPENSE_LIST_PAGE_KEYS = ["items", "nextCursor"] as const;
export const EXPENSE_CURSOR_KEYS = ["expenseDate", "id"] as const;

export const EXPENSE_DETAIL_KEYS = [
  "amount",
  "amountFloor",
  "branchId",
  "branchName",
  "canCancel",
  "cancelReason",
  "cancelledAt",
  "categoryKey",
  "categoryKind",
  "createdAt",
  "currency",
  "daysOverdue",
  "description",
  "dueDate",
  "expenseDate",
  "id",
  "isOverdue",
  "note",
  "outstanding",
  "paid",
  "payments",
  "status",
  "structureLocked",
  "updatedAt",
  "vendorName",
  "version",
] as const;

export const EXPENSE_PAYMENT_KEYS = [
  "amount",
  "id",
  "method",
  "note",
  "paidAt",
  "status",
  "voidReason",
] as const;

export const EXPENSE_OVERVIEW_KEYS = [
  "byCurrency",
  "month",
  "primaryCurrency",
  "referenceDate",
] as const;
export const EXPENSE_OVERVIEW_CURRENCY_KEYS = [
  "currency",
  "incurred",
  "outstanding",
  "overdue",
  "paid",
  "upcoming",
] as const;

export const EXPENSE_WRITE_RESULT_KEYS = {
  create: ["expenseId", "noop", "paymentId", "status", "version"],
  update: ["expenseId", "noop", "status", "version"],
  cancel: ["expenseId", "noop", "status", "version"],
  recordPayment: ["expenseId", "noop", "paymentId", "status", "version"],
  voidPayment: ["expenseId", "noop", "paymentId", "status", "version"],
} as const;
