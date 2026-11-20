/**
 * Faz FIN.1C.1 — shapes of the personnel-ledger read models and write results, and the key sets the SQL returns.
 *
 * The RPCs return curated jsonb (see 20261007120100): camelCase keys, numbers as JSON numbers, no user ids, no idempotency
 * data, no tenant id and no staff member id inside a period, line or payment model. The *_KEYS constants below are the
 * contract tests' anchor (staff-finance-types.test.ts compares them with what the live RPCs return) so a column quietly
 * added to a read model fails a test instead of leaking to the browser.
 */

export const STAFF_LIFECYCLES = ["open", "finalized", "cancelled"] as const;
export type StaffLifecycle = (typeof STAFF_LIFECYCLES)[number];

/** The generated payment state of a period (never stored by hand). `overdue` is a derived badge, not a state. */
export const STAFF_PAYMENT_STATES = [
  "nothing_due",
  "unpaid",
  "partially_paid",
  "paid",
  "overpaid",
] as const;
export type StaffPaymentState = (typeof STAFF_PAYMENT_STATES)[number];

export const STAFF_PAYMENT_PURPOSES = ["salary", "advance", "bonus", "other"] as const;
export type StaffPaymentPurpose = (typeof STAFF_PAYMENT_PURPOSES)[number];

export const STAFF_PAYMENT_METHODS = ["cash", "card", "bank_transfer", "other"] as const;
export type StaffPaymentMethod = (typeof STAFF_PAYMENT_METHODS)[number];

export const STAFF_LINE_GROUPS = ["earning", "employee_deduction", "employer_cost"] as const;
export type StaffLineGroup = (typeof STAFF_LINE_GROUPS)[number];

/** The 16 seeded kinds in display order (the classification itself is read from the database). */
export const STAFF_LINE_KIND_LIST = [
  "salary",
  "bonus",
  "commission",
  "overtime",
  "extra_payment",
  "other_earning",
  "adjustment_credit",
  "employee_social_insurance",
  "employee_provident_fund",
  "paye",
  "other_deduction",
  "adjustment_debit",
  "employer_social_insurance",
  "employer_provident_fund",
  "private_insurance",
  "other_employer_cost",
] as const;
export type StaffLineKind = (typeof STAFF_LINE_KIND_LIST)[number];

/** The two explicit correction kinds: the only statement kinds that can be added to a finalized period, always with a description. */
export const STAFF_ADJUSTMENT_KINDS = ["adjustment_credit", "adjustment_debit"] as const;
export const isAdjustmentKind = (kind: string): boolean => (STAFF_ADJUSTMENT_KINDS as readonly string[]).includes(kind);

export type StaffInstitution = "social_insurance" | "provident_fund";

export type StaffLineKindInfo = {
  code: string;
  lineGroup: StaffLineGroup;
  institution: StaffInstitution | null;
  isAdjustment: boolean;
  displayOrder: number;
};

export type StaffRef = { staffMemberId: string; fullName: string; status: "active" | "inactive" | string };

export type SplitFigure = { employee: number; employer: number };
export type CountedTotal = { total: number; count: number };

export type StaffOverviewPeriod = {
  periodId: string;
  staffName: string;
  currency: string;
  lifecycle: StaffLifecycle;
  paymentState: StaffPaymentState;
  grossEntitlement: number;
  employeeDeductions: number;
  paye: number;
  netPayable: number;
  paid: number;
  advances: number;
  /** Signed: negative means paid in excess (open periods only). */
  employeeOutstanding: number;
  paidInExcess: number;
  socialInsurance: SplitFigure;
  providentFund: SplitFigure;
  employerCost: number;
  personnelCost: number;
  dueDate: string | null;
  isOverdue: boolean;
  daysOverdue: number | null;
  version: number;
};

export type StaffOverviewCurrency = {
  currency: string;
  grossEntitlement: number;
  employeeDeductions: number;
  paye: number;
  netPayable: number;
  paid: number;
  advances: number;
  employeeOutstanding: number;
  paidInExcess: number;
  employerCost: number;
  personnelCost: number;
  socialInsurance: SplitFigure;
  providentFund: SplitFigure;
  periodCount: number;
  cashPaidInMonth: number;
  employeeOutstandingAllTime: CountedTotal;
  paidInExcessAllTime: CountedTotal;
  overdueAllTime: CountedTotal;
};

export type StaffOverview = {
  /** First day of the selected month, YYYY-MM-DD. */
  month: string;
  /** The tenant-local "today" the database used (the page never computes its own). */
  referenceDate: string;
  primaryCurrency: string;
  byCurrency: StaffOverviewCurrency[];
  periods: StaffOverviewPeriod[];
  staffWithoutPeriod: StaffRef[];
};

export type StaffPeriodFlags = {
  canFinalize: boolean;
  finalizeBlockedReason: "not_open" | "no_earning" | "payments_exceed_net" | null;
  canReopen: boolean;
  reopenBlockedReason: "not_finalized" | "payment_after_finalization" | null;
  canCancel: boolean;
  cancelBlockedReason: "payments_posted" | null;
  canAddStatementLine: boolean;
  canAddAdjustment: boolean;
  canAddEmployerCost: boolean;
  canPay: boolean;
  /** null while the period is open (no cap); the outstanding amount once finalized. */
  maxPayable: number | null;
};

export type StaffLine = {
  id: string;
  kind: string;
  lineGroup: StaffLineGroup;
  institution: StaffInstitution | null;
  amount: number;
  description: string | null;
  status: "active" | "voided";
  postFinalization: boolean;
  voidReason: string | null;
  calculationSource: string;
  canEdit: boolean;
  canVoid: boolean;
};

export type StaffPayment = {
  id: string;
  purpose: StaffPaymentPurpose;
  method: StaffPaymentMethod;
  amount: number;
  paidAt: string;
  note: string | null;
  status: "posted" | "voided";
  postFinalization: boolean;
  voidReason: string | null;
};

export type StaffFinalizedStatement = {
  finalizedAt: string;
  grossEntitlement: number;
  employeeDeductions: number;
  netPayable: number;
};

export type StaffSinceFinalization = {
  grossEntitlement: number;
  employeeDeductions: number;
  netPayable: number;
};

export type StaffPeriodDetail = {
  id: string;
  staffName: string;
  periodMonth: string;
  currency: string;
  lifecycle: StaffLifecycle;
  paymentState: StaffPaymentState;
  dueDate: string | null;
  grossEntitlement: number;
  employeeDeductions: number;
  paye: number;
  netPayable: number;
  paid: number;
  advances: number;
  employeeOutstanding: number;
  paidInExcess: number;
  employerCost: number;
  personnelCost: number;
  socialInsurance: SplitFigure;
  providentFund: SplitFigure;
  finalizedStatement: StaffFinalizedStatement | null;
  sinceFinalization: StaffSinceFinalization | null;
  isOverdue: boolean;
  daysOverdue: number | null;
  flags: StaffPeriodFlags;
  version: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  lines: StaffLine[];
  payments: StaffPayment[];
};

/** What every write RPC returns: ids, lifecycle, payment state and the new version. Nothing else. */
export type StaffWriteResult = {
  periodId: string;
  lineId?: string | null;
  paymentId?: string | null;
  lifecycle: StaffLifecycle;
  paymentState: StaffPaymentState;
  version: number;
  noop: boolean;
};

/** A server read: the data, or the stable error code (null when the failure had none) so the page can render an explicit error state. */
export type StaffReadResult<T> = { ok: true; data: T } | { ok: false; code: string | null };

// The key sets the live RPCs return (compared with the database by the contract tests).
export const STAFF_OVERVIEW_KEYS = ["month", "referenceDate", "primaryCurrency", "byCurrency", "periods", "staffWithoutPeriod"] as const;
export const STAFF_OVERVIEW_PERIOD_KEYS = [
  "periodId",
  "staffName",
  "currency",
  "lifecycle",
  "paymentState",
  "grossEntitlement",
  "employeeDeductions",
  "paye",
  "netPayable",
  "paid",
  "advances",
  "employeeOutstanding",
  "paidInExcess",
  "socialInsurance",
  "providentFund",
  "employerCost",
  "personnelCost",
  "dueDate",
  "isOverdue",
  "daysOverdue",
  "version",
] as const;
export const STAFF_OVERVIEW_CURRENCY_KEYS = [
  "currency",
  "grossEntitlement",
  "employeeDeductions",
  "paye",
  "netPayable",
  "paid",
  "advances",
  "employeeOutstanding",
  "paidInExcess",
  "employerCost",
  "personnelCost",
  "socialInsurance",
  "providentFund",
  "periodCount",
  "cashPaidInMonth",
  "employeeOutstandingAllTime",
  "paidInExcessAllTime",
  "overdueAllTime",
] as const;
export const STAFF_PERIOD_DETAIL_KEYS = [
  "id",
  "staffName",
  "periodMonth",
  "currency",
  "lifecycle",
  "paymentState",
  "dueDate",
  "grossEntitlement",
  "employeeDeductions",
  "paye",
  "netPayable",
  "paid",
  "advances",
  "employeeOutstanding",
  "paidInExcess",
  "employerCost",
  "personnelCost",
  "socialInsurance",
  "providentFund",
  "finalizedStatement",
  "sinceFinalization",
  "isOverdue",
  "daysOverdue",
  "flags",
  "version",
  "cancelledAt",
  "cancelReason",
  "createdAt",
  "updatedAt",
  "lines",
  "payments",
] as const;
export const STAFF_PERIOD_FLAG_KEYS = [
  "canFinalize",
  "finalizeBlockedReason",
  "canReopen",
  "reopenBlockedReason",
  "canCancel",
  "cancelBlockedReason",
  "canAddStatementLine",
  "canAddAdjustment",
  "canAddEmployerCost",
  "canPay",
  "maxPayable",
] as const;
export const STAFF_LINE_KEYS = [
  "id",
  "kind",
  "lineGroup",
  "institution",
  "amount",
  "description",
  "status",
  "postFinalization",
  "voidReason",
  "calculationSource",
  "canEdit",
  "canVoid",
] as const;
export const STAFF_PAYMENT_KEYS = ["id", "purpose", "method", "amount", "paidAt", "note", "status", "postFinalization", "voidReason"] as const;
export const STAFF_KIND_KEYS = ["code", "lineGroup", "institution", "isAdjustment", "displayOrder"] as const;
export const STAFF_REF_KEYS = ["staffMemberId", "fullName", "status"] as const;
