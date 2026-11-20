/**
 * Faz FIN.1C.1 — the personnel page's whole filter state is one URL parameter: month=YYYY-MM (the tenant-local month; the
 * default is decided by the database from its own reference date). Nothing else ever goes into the URL: no amount, no name, no
 * note (test F15, P14).
 *
 * Parsing is lenient on purpose: garbage in the URL falls back to the default and never throws.
 */

export type StaffFinanceFilters = {
  /** "YYYY-MM", or null for the default month. */
  month: string | null;
};

export const DEFAULT_STAFF_FINANCE_FILTERS: StaffFinanceFilters = { month: null };

const MONTH_RE = /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/;

type RawParams = Record<string, string | string[] | undefined>;

export function parseStaffFinanceFilters(raw: RawParams): StaffFinanceFilters {
  const value = raw.month;
  const monthParam = Array.isArray(value) ? value[0] : value;
  return { month: monthParam && MONTH_RE.test(monthParam) ? monthParam : null };
}

/** "2026-10" → "2026-10-01": the argument the overview RPC takes (the first day of the month). */
export function monthToDate(month: string | null): string | null {
  return month && MONTH_RE.test(month) ? `${month}-01` : null;
}

/** "2026-10-01" (or "2026-10-17") → "2026-10". */
export function dateToMonth(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** The month before or after (delta = -1 / +1), clamped to the supported years; pure calendar arithmetic. */
export function shiftMonth(month: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})/.exec(month);
  if (!match) return month;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const mm = (index % 12) + 1;
  const clamped = Math.min(Math.max(year, 2000), 2100);
  return `${String(clamped).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
}

/** The query string for a month, or "" for the default month: `?month=YYYY-MM` is the only form it ever takes. */
export function monthQuery(month: string | null): string {
  return month && MONTH_RE.test(month) ? `?month=${month}` : "";
}
