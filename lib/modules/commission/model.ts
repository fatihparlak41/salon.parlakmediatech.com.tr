/**
 * Faz COMM.1A — the view side of the staff commission read model. Every amount is computed by the database
 * (public.get_staff_commission / get_staff_commission_detail / list_commission_rules); this file only validates the shape of the
 * answer and cross-checks that it is consistent. Nothing here adds, multiplies or rounds a commission.
 */

export type CommissionSummary = {
  from: string;
  to: string;
  timezone: string;
  currency: string;
  staff: { staffId: string; displayName: string; completedServices: number; completedAppointments: number; serviceAmount: number; commissionAmount: number }[];
  totals: { completedServices: number; serviceAmount: number; commissionAmount: number };
};

export type CommissionRuleView = { kind: "none" | "percentage" | "fixed"; percentage: number | null; fixedAmount: number | null };

export type CommissionDetail = {
  from: string;
  to: string;
  currency: string;
  displayName: string;
  total: { serviceAmount: number; commissionAmount: number; rows: number };
  hasMore: boolean;
  rows: { date: string; service: string; serviceValue: number; rule: CommissionRuleView; commission: number; saleDiscount: boolean }[];
};

export type CommissionRules = {
  today: string;
  rules: { staffId: string; staffName: string; serviceId: string; serviceName: string; kind: "percentage" | "fixed"; percentage: number | null; fixedAmount: number | null; effectiveFrom: string }[];
  staff: { id: string; name: string }[];
  services: { id: string; name: string }[];
};

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const cents = (n: number) => Math.round(n * 100);

export function parseCommissionSummary(raw: unknown): CommissionSummary | null {
  const r = rec(raw);
  const totals = rec(r?.totals);
  if (!r || !totals || !Array.isArray(r.staff)) return null;
  const from = str(r.from);
  const to = str(r.to);
  const timezone = str(r.timezone);
  const currency = str(r.currency);
  const tSvc = int(totals.completedServices);
  const tAmt = num(totals.serviceAmount);
  const tCom = num(totals.commissionAmount);
  if (!from || !to || !timezone || !currency || tSvc === null || tAmt === null || tCom === null) return null;
  const staff: CommissionSummary["staff"] = [];
  for (const e of r.staff) {
    const x = rec(e);
    const completedServices = int(x?.completedServices);
    const completedAppointments = int(x?.completedAppointments);
    const serviceAmount = num(x?.serviceAmount);
    const commissionAmount = num(x?.commissionAmount);
    if (!x || typeof x.staffId !== "string" || typeof x.displayName !== "string" || completedServices === null || completedAppointments === null || serviceAmount === null || commissionAmount === null) return null;
    staff.push({ staffId: x.staffId, displayName: x.displayName, completedServices, completedAppointments, serviceAmount, commissionAmount });
  }
  // the totals must be the sum of the people (in integer cents: no floating-point drift)
  if (
    staff.reduce((n, s) => n + s.completedServices, 0) !== tSvc ||
    staff.reduce((n, s) => n + cents(s.serviceAmount), 0) !== cents(tAmt) ||
    staff.reduce((n, s) => n + cents(s.commissionAmount), 0) !== cents(tCom)
  ) {
    return null;
  }
  return { from, to, timezone, currency, staff, totals: { completedServices: tSvc, serviceAmount: tAmt, commissionAmount: tCom } };
}

function parseRule(raw: unknown): CommissionRuleView | null {
  const r = rec(raw);
  if (!r || (r.kind !== "none" && r.kind !== "percentage" && r.kind !== "fixed")) return null;
  const percentage = r.percentage === null ? null : num(r.percentage);
  const fixedAmount = r.fixedAmount === null ? null : num(r.fixedAmount);
  if ((r.percentage !== null && percentage === null) || (r.fixedAmount !== null && fixedAmount === null)) return null;
  // the rule's shape must match its kind
  if (r.kind === "none" && (percentage !== null || fixedAmount !== null)) return null;
  if (r.kind === "percentage" && (percentage === null || percentage > 100 || fixedAmount !== null)) return null;
  if (r.kind === "fixed" && (fixedAmount === null || percentage !== null)) return null;
  return { kind: r.kind, percentage, fixedAmount };
}

export function parseCommissionDetail(raw: unknown): CommissionDetail | null {
  const r = rec(raw);
  const total = rec(r?.total);
  if (!r || !total || !Array.isArray(r.rows) || typeof r.hasMore !== "boolean") return null;
  const from = str(r.from);
  const to = str(r.to);
  const currency = str(r.currency);
  const displayName = str(r.displayName);
  const tAmt = num(total.serviceAmount);
  const tCom = num(total.commissionAmount);
  const tRows = int(total.rows);
  if (!from || !to || !currency || !displayName || tAmt === null || tCom === null || tRows === null) return null;
  const rows: CommissionDetail["rows"] = [];
  for (const e of r.rows) {
    const x = rec(e);
    const serviceValue = num(x?.serviceValue);
    const commission = num(x?.commission);
    const rule = parseRule(x?.rule);
    if (!x || typeof x.date !== "string" || typeof x.service !== "string" || serviceValue === null || commission === null || !rule || typeof x.saleDiscount !== "boolean") return null;
    rows.push({ date: x.date, service: x.service, serviceValue, rule, commission, saleDiscount: x.saleDiscount });
  }
  // when the list is complete, its rows must add up to the total exactly
  if (!r.hasMore && (rows.length !== tRows || rows.reduce((n, x) => n + cents(x.commission), 0) !== cents(tCom) || rows.reduce((n, x) => n + cents(x.serviceValue), 0) !== cents(tAmt))) return null;
  return { from, to, currency, displayName, total: { serviceAmount: tAmt, commissionAmount: tCom, rows: tRows }, hasMore: r.hasMore, rows };
}

export function parseCommissionRules(raw: unknown): CommissionRules | null {
  const r = rec(raw);
  const today = str(r?.today);
  if (!r || !today || !Array.isArray(r.rules) || !Array.isArray(r.staff) || !Array.isArray(r.services)) return null;
  const rules: CommissionRules["rules"] = [];
  for (const e of r.rules) {
    const x = rec(e);
    const rule = parseRule(x);
    if (!x || !rule || rule.kind === "none" || typeof x.staffId !== "string" || typeof x.staffName !== "string" || typeof x.serviceId !== "string" || typeof x.serviceName !== "string" || typeof x.effectiveFrom !== "string") return null;
    rules.push({ staffId: x.staffId, staffName: x.staffName, serviceId: x.serviceId, serviceName: x.serviceName, kind: rule.kind, percentage: rule.percentage, fixedAmount: rule.fixedAmount, effectiveFrom: x.effectiveFrom });
  }
  const pairs = (list: unknown[], key: "name"): { id: string; name: string }[] | null => {
    const out: { id: string; name: string }[] = [];
    for (const e of list) {
      const x = rec(e);
      if (!x || typeof x.id !== "string" || typeof x[key] !== "string") return null;
      out.push({ id: x.id, name: x[key] as string });
    }
    return out;
  };
  const staff = pairs(r.staff, "name");
  const services = pairs(r.services, "name");
  if (!staff || !services) return null;
  return { today, rules, staff, services };
}

/** "12,5" / "12.50" → "12.5" (a plain decimal string for the action; the database validates range and precision again). null when not a number. */
export function parseRuleValue(input: string): number | null {
  const cleaned = input.trim().replace(",", ".");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

export function describeRule(rule: CommissionRuleView, currency: string): string {
  if (rule.kind === "percentage") return `%${String(rule.percentage).replace(".", ",")}`;
  if (rule.kind === "fixed") return `${(rule.fixedAmount ?? 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency} sabit`;
  return "Komisyon yok";
}

export function isoDate(value: string | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
