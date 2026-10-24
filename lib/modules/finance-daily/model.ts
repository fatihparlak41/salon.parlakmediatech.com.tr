/**
 * Faz FIN.2A — the daily Owner overview, view side.
 *
 * Every number is computed by ONE database function (`public.get_daily_owner_overview`). This file only validates the
 * shape of its answer; it adds, subtracts and groups nothing. A malformed answer is "unknown" (null), never zeros.
 */

export type DailyOverview = {
  date: string;
  timezone: string;
  currency: string;
  currencyMixed: boolean;
  appointments: { total: number; scheduled: number; confirmed: number; inProgress: number; completed: number; cancelled: number; noShow: number };
  services: { completedAmount: number; completedWithCheckout: number; completedWithoutCheckout: number; withoutCheckoutAmount: number; discountTotal: number };
  payments: { totalCollected: number; count: number; cash: number; card: number; bankTransfer: number; other: number; voidedCount: number; voidedAmount: number };
  outstanding: { amount: number; count: number; todayAmount: number };
  expenses: {
    accruedTotal: number;
    accruedCount: number;
    paidOutTotal: number;
    paidOutCount: number;
    paidOutCash: number;
    paidOutCard: number;
    paidOutBankTransfer: number;
    paidOutOther: number;
  };
  cash: { cashCollected: number; cashPaidOut: number; difference: number };
  staff: { displayName: string; completedAppointments: number; completedItems: number; serviceAmount: number }[];
  staffServiceAmountTotal: number;
};

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
}

/** Reads `keys` from `source` as non-negative numbers, or null when any is missing/invalid. */
function group<K extends string>(source: unknown, keys: readonly K[]): Record<K, number> | null {
  const r = rec(source);
  if (!r) return null;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const n = nonNegative(r[key]);
    if (n === null) return null;
    out[key] = n;
  }
  return out;
}

export function parseDailyOverview(raw: unknown): DailyOverview | null {
  const r = rec(raw);
  if (!r) return null;
  if (typeof r.date !== "string" || typeof r.timezone !== "string" || typeof r.currency !== "string" || typeof r.currencyMixed !== "boolean") return null;

  const appointments = group(r.appointments, ["total", "scheduled", "confirmed", "inProgress", "completed", "cancelled", "noShow"] as const);
  const services = group(r.services, ["completedAmount", "completedWithCheckout", "completedWithoutCheckout", "withoutCheckoutAmount", "discountTotal"] as const);
  const payments = group(r.payments, ["totalCollected", "count", "cash", "card", "bankTransfer", "other", "voidedCount", "voidedAmount"] as const);
  const outstanding = group(r.outstanding, ["amount", "count", "todayAmount"] as const);
  const expenses = group(r.expenses, [
    "accruedTotal",
    "accruedCount",
    "paidOutTotal",
    "paidOutCount",
    "paidOutCash",
    "paidOutCard",
    "paidOutBankTransfer",
    "paidOutOther",
  ] as const);
  if (!appointments || !services || !payments || !outstanding || !expenses) return null;

  const cashRaw = rec(r.cash);
  const cashCollected = nonNegative(cashRaw?.cashCollected);
  const cashPaidOut = nonNegative(cashRaw?.cashPaidOut);
  const difference = num(cashRaw?.difference);
  if (!cashRaw || cashRaw.supported !== true || cashCollected === null || cashPaidOut === null || difference === null) return null;

  // The overview must agree with itself; a self-contradictory answer is refused, not displayed.
  const round = (n: number) => Math.round(n * 100) / 100;
  if (round(cashCollected - cashPaidOut) !== round(difference)) return null;
  if (round(payments.cash + payments.card + payments.bankTransfer + payments.other) !== round(payments.totalCollected)) return null;
  if (round(expenses.paidOutCash + expenses.paidOutCard + expenses.paidOutBankTransfer + expenses.paidOutOther) !== round(expenses.paidOutTotal)) return null;
  if (round(cashCollected) !== round(payments.cash) || round(cashPaidOut) !== round(expenses.paidOutCash)) return null;

  if (!Array.isArray(r.staff)) return null;
  const staff: DailyOverview["staff"] = [];
  for (const entry of r.staff) {
    const e = rec(entry);
    const completedAppointments = nonNegative(e?.completedAppointments);
    const completedItems = nonNegative(e?.completedItems);
    const serviceAmount = nonNegative(e?.serviceAmount);
    if (!e || typeof e.displayName !== "string" || completedAppointments === null || completedItems === null || serviceAmount === null) return null;
    staff.push({ displayName: e.displayName, completedAppointments, completedItems, serviceAmount });
  }
  const staffServiceAmountTotal = nonNegative(r.staffServiceAmountTotal);
  if (staffServiceAmountTotal === null) return null;

  return {
    date: r.date,
    timezone: r.timezone,
    currency: r.currency,
    currencyMixed: r.currencyMixed,
    appointments,
    services,
    payments,
    outstanding,
    expenses,
    cash: { cashCollected, cashPaidOut, difference },
    staff,
    staffServiceAmountTotal,
  };
}

/** "2026-10-10" → "10.10.2026" without ever passing through a Date (no timezone can shift a calendar day). */
export function formatOverviewDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDate;
}
