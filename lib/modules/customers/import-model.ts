/**
 * Faz CUST.1A — shapes of the import answers and customer-history answer, validated strictly. The application never
 * recomputes a classification or a count; it only checks that the database's answer is well-formed and consistent.
 */

export type ImportStatus = "NEW" | "MATCH_EXISTING" | "INVALID" | "AMBIGUOUS";
const STATUSES = new Set<string>(["NEW", "MATCH_EXISTING", "INVALID", "AMBIGUOUS"]);

export type ImportPreview = {
  maxRows: number;
  summary: { total: number; new: number; matchExisting: number; invalid: number; ambiguous: number; willFillPhone: number; willFillEmail: number };
  rows: { row: number; status: ImportStatus; reason: string | null; existingName: string | null; fillPhone: boolean; fillEmail: boolean }[];
};

export type ImportCommit = {
  summary: { total: number; created: number; matchExisting: number; filledPhone: number; filledEmail: number; skippedInvalid: number; skippedAmbiguous: number };
  rows: { row: number; status: ImportStatus; reason: string | null; existingName: string | null }[];
};

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}
function counts<K extends string>(source: unknown, keys: readonly K[]): Record<K, number> | null {
  const r = rec(source);
  if (!r) return null;
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const n = count(r[k]);
    if (n === null) return null;
    out[k] = n;
  }
  return out;
}

export function parseImportPreview(raw: unknown): ImportPreview | null {
  const r = rec(raw);
  const maxRows = count(r?.maxRows);
  const summary = counts(r?.summary, ["total", "new", "matchExisting", "invalid", "ambiguous", "willFillPhone", "willFillEmail"] as const);
  if (!r || maxRows === null || !summary || !Array.isArray(r.rows)) return null;
  const rows: ImportPreview["rows"] = [];
  for (const e of r.rows) {
    const x = rec(e);
    const row = count(x?.row);
    if (!x || row === null || typeof x.status !== "string" || !STATUSES.has(x.status) || typeof x.fillPhone !== "boolean" || typeof x.fillEmail !== "boolean") return null;
    rows.push({
      row,
      status: x.status as ImportStatus,
      reason: typeof x.reason === "string" ? x.reason : null,
      existingName: typeof x.existingName === "string" ? x.existingName : null,
      fillPhone: x.fillPhone,
      fillEmail: x.fillEmail,
    });
  }
  // the summary must agree with the rows it summarises
  const tally = (s: ImportStatus) => rows.filter((x) => x.status === s).length;
  if (summary.total !== rows.length || summary.new !== tally("NEW") || summary.matchExisting !== tally("MATCH_EXISTING") || summary.invalid !== tally("INVALID") || summary.ambiguous !== tally("AMBIGUOUS")) {
    return null;
  }
  return { maxRows, summary, rows };
}

export function parseImportCommit(raw: unknown): ImportCommit | null {
  const r = rec(raw);
  const summary = counts(r?.summary, ["total", "created", "matchExisting", "filledPhone", "filledEmail", "skippedInvalid", "skippedAmbiguous"] as const);
  if (!r || !summary || !Array.isArray(r.rows)) return null;
  const rows: ImportCommit["rows"] = [];
  for (const e of r.rows) {
    const x = rec(e);
    const row = count(x?.row);
    if (!x || row === null || typeof x.status !== "string" || !STATUSES.has(x.status)) return null;
    rows.push({ row, status: x.status as ImportStatus, reason: typeof x.reason === "string" ? x.reason : null, existingName: typeof x.existingName === "string" ? x.existingName : null });
  }
  return { summary, rows };
}

export const IMPORT_REASON_TR: Record<string, string> = {
  name_missing: "Ad soyad boş",
  name_too_long: "Ad soyad çok uzun (en fazla 200 karakter)",
  contact_missing: "Telefon veya e-posta gerekli",
  phone_invalid: "Telefon numarası geçersiz",
  email_invalid: "E-posta adresi geçersiz",
  duplicate_in_file: "Dosyada aynı kişi daha önce var",
  file_conflict: "Dosyada aynı telefon/e-posta başka bir isimle daha önce var",
  phone_other_name: "Bu telefon kayıtlı başka bir isimle var",
  email_other_name: "Bu e-posta kayıtlı başka bir isimle var",
  multiple_existing: "Birden fazla kayıtlı müşteriyle eşleşiyor",
  conflicting_matches: "Telefon ve e-posta farklı kayıtlı müşterilere ait",
};

export type CustomerHistory = {
  timezone: string;
  summary: { completedVisits: number; lastVisitAt: string | null; upcoming: number; cancelled: number; noShow: number; total: number };
  upcoming: HistoryAppointment[];
  past: HistoryAppointment[];
  hasMorePast: boolean;
  servicesReceived: { service: string; count: number }[];
  staff: { displayName: string; count: number }[];
  finance: { completedAmount: number; outstanding: number; completedWithoutCheckout: number; currency: string } | null;
};

export type HistoryAppointment = {
  startAt: string;
  status: string;
  items: { service: string; staff: string | null }[];
  /** present ONLY when the caller holds finance.view */
  money: { amount: number; hasCheckout: boolean; paid: number | null; outstanding: number | null } | null;
};

function parseAppointment(raw: unknown): HistoryAppointment | null {
  const r = rec(raw);
  if (!r || typeof r.startAt !== "string" || typeof r.status !== "string" || !Array.isArray(r.items)) return null;
  const items: HistoryAppointment["items"] = [];
  for (const i of r.items) {
    const x = rec(i);
    if (!x || typeof x.service !== "string" || !(x.staff === null || typeof x.staff === "string")) return null;
    items.push({ service: x.service, staff: x.staff as string | null });
  }
  let money: HistoryAppointment["money"] = null;
  if ("amount" in r) {
    if (typeof r.amount !== "number" || typeof r.hasCheckout !== "boolean") return null;
    money = {
      amount: r.amount,
      hasCheckout: r.hasCheckout,
      paid: typeof r.paid === "number" ? r.paid : null,
      outstanding: typeof r.outstanding === "number" ? r.outstanding : null,
    };
  }
  return { startAt: r.startAt, status: r.status, items, money };
}

export function parseCustomerHistory(raw: unknown): CustomerHistory | null {
  const r = rec(raw);
  const s = rec(r?.summary);
  if (!r || !s || typeof r.timezone !== "string" || typeof r.hasMorePast !== "boolean") return null;
  const summary = counts(s, ["completedVisits", "upcoming", "cancelled", "noShow", "total"] as const);
  if (!summary || !(s.lastVisitAt === null || typeof s.lastVisitAt === "string")) return null;
  if (!Array.isArray(r.upcoming) || !Array.isArray(r.past) || !Array.isArray(r.servicesReceived) || !Array.isArray(r.staff)) return null;
  const upcoming = r.upcoming.map(parseAppointment);
  const past = r.past.map(parseAppointment);
  if (upcoming.some((x) => x === null) || past.some((x) => x === null)) return null;
  const servicesReceived: CustomerHistory["servicesReceived"] = [];
  for (const e of r.servicesReceived) {
    const x = rec(e);
    const n = count(x?.count);
    if (!x || typeof x.service !== "string" || n === null) return null;
    servicesReceived.push({ service: x.service, count: n });
  }
  const staff: CustomerHistory["staff"] = [];
  for (const e of r.staff) {
    const x = rec(e);
    const n = count(x?.count);
    if (!x || typeof x.displayName !== "string" || n === null) return null;
    staff.push({ displayName: x.displayName, count: n });
  }
  let finance: CustomerHistory["finance"] = null;
  if (r.finance !== null) {
    const f = rec(r.finance);
    const completedAmount = typeof f?.completedAmount === "number" ? f.completedAmount : null;
    const outstanding = typeof f?.outstanding === "number" ? f.outstanding : null;
    const without = count(f?.completedWithoutCheckout);
    if (!f || completedAmount === null || outstanding === null || without === null || typeof f.currency !== "string") return null;
    finance = { completedAmount, outstanding, completedWithoutCheckout: without, currency: f.currency };
  }
  return {
    timezone: r.timezone,
    summary: { completedVisits: summary.completedVisits, lastVisitAt: s.lastVisitAt as string | null, upcoming: summary.upcoming, cancelled: summary.cancelled, noShow: summary.noShow, total: summary.total },
    upcoming: upcoming as HistoryAppointment[],
    past: past as HistoryAppointment[],
    hasMorePast: r.hasMorePast,
    servicesReceived,
    staff,
    finance,
  };
}
