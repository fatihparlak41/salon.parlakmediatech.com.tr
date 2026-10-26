/**
 * Faz BEAUTY.1B - the view side of the treatment-history read model (public.get_customer_treatment_history,
 * get_treatment_rebook_defaults, get_treatment_photo_access) and the image rules shared by the uploader. Everything here
 * validates the shape of a database answer or words a state; nothing computes a date, an interval or a price: the database does.
 */

export type RebookState = "booked" | "not_due" | "due" | "overdue";

export type TreatmentRebook = { minDays: number; maxDays: number | null; windowStart: string; windowEnd: string | null; state: RebookState };
export type TreatmentMedia = { id: string; kind: PhotoKind; createdAt: string };
export type TreatmentItem = {
  itemId: string;
  appointmentId: string;
  date: string;
  serviceId: string;
  serviceName: string;
  staffName: string | null;
  value: string | null;
  note: string | null;
  media: TreatmentMedia[];
  rebook: TreatmentRebook | null;
};
export type TreatmentHistory = { today: string; timezone: string; canSeeValue: boolean; hasMore: boolean; items: TreatmentItem[] };
export type RebookDefaults = { serviceId: string; serviceName: string; branchId: string | null; staffId: string | null };

export type PhotoKind = "before" | "after" | "other";
export const PHOTO_KINDS: PhotoKind[] = ["before", "after", "other"];
export const PHOTO_KIND_LABEL: Record<PhotoKind, string> = { before: "Önce", after: "Sonra", other: "Diğer" };

/** Conservative, image-only: no HEIC (the browser re-encodes camera photos to JPEG before upload), no GIF/PDF/SVG. */
export const ALLOWED_PHOTO_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_PHOTOS_PER_TREATMENT = 8;
export const NOTE_MAX_LENGTH = 500;

/** A plain-language refusal for a file the uploader must not even try to send, or null when it is acceptable. */
export function validatePhotoFile(file: { type: string; size: number }): string | null {
  if (!(ALLOWED_PHOTO_MIME as readonly string[]).includes(file.type)) return "Yalnızca JPEG, PNG veya WEBP fotoğraf yüklenebilir";
  if (file.size <= 0) return "Dosya boş";
  if (file.size > MAX_PHOTO_BYTES) return "Fotoğraf en fazla 2 MB olabilir";
  return null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const optStr = (v: unknown): string | null | undefined => (v === null ? null : typeof v === "string" ? v : undefined);
const nonNegInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const REBOOK_STATES: RebookState[] = ["booked", "not_due", "due", "overdue"];

function parseRebook(v: unknown): TreatmentRebook | null | undefined {
  if (v === null) return null;
  const r = rec(v);
  if (!r) return undefined;
  const minDays = nonNegInt(r.minDays);
  const maxDays = r.maxDays === null ? null : nonNegInt(r.maxDays);
  const windowStart = str(r.windowStart);
  const windowEnd = r.windowEnd === null ? null : str(r.windowEnd);
  const state = REBOOK_STATES.find((s) => s === r.state);
  if (minDays === null || maxDays === undefined || (r.maxDays !== null && maxDays === null) || !windowStart || windowEnd === undefined || (r.windowEnd !== null && windowEnd === null) || !state) return undefined;
  if (maxDays !== null && maxDays < minDays) return undefined;
  return { minDays, maxDays, windowStart, windowEnd, state };
}

export function parseTreatmentHistory(raw: unknown): TreatmentHistory | null {
  const r = rec(raw);
  if (!r || !Array.isArray(r.items)) return null;
  const today = str(r.today);
  const timezone = str(r.timezone);
  if (!today || !timezone || typeof r.canSeeValue !== "boolean" || typeof r.hasMore !== "boolean") return null;
  const items: TreatmentItem[] = [];
  for (const e of r.items) {
    const x = rec(e);
    const itemId = str(x?.itemId);
    const appointmentId = str(x?.appointmentId);
    const date = str(x?.date);
    const serviceId = str(x?.serviceId);
    const serviceName = str(x?.serviceName);
    const staffName = optStr(x?.staffName);
    const value = optStr(x?.value);
    const note = optStr(x?.note);
    const rebook = parseRebook(x?.rebook);
    if (!x || !itemId || !appointmentId || !date || !serviceId || !serviceName || staffName === undefined || value === undefined || note === undefined || rebook === undefined || !Array.isArray(x.media)) return null;
    if (!r.canSeeValue && value !== null) return null; // a value must never reach someone who may not see it
    const media: TreatmentMedia[] = [];
    for (const m of x.media) {
      const y = rec(m);
      const id = str(y?.id);
      const kind = PHOTO_KINDS.find((k) => k === y?.kind);
      const createdAt = str(y?.createdAt);
      if (!id || !kind || !createdAt) return null;
      media.push({ id, kind, createdAt });
    }
    items.push({ itemId, appointmentId, date, serviceId, serviceName, staffName, value, note, media, rebook });
  }
  return { today, timezone, canSeeValue: r.canSeeValue, hasMore: r.hasMore, items };
}

export function parseRebookDefaults(raw: unknown): RebookDefaults | null {
  const r = rec(raw);
  const serviceId = str(r?.serviceId);
  const serviceName = str(r?.serviceName);
  const branchId = optStr(r?.branchId);
  const staffId = optStr(r?.staffId);
  if (!r || !serviceId || !serviceName || branchId === undefined || staffId === undefined) return null;
  return { serviceId, serviceName, branchId, staffId };
}

export function parsePhotoAccess(raw: unknown): { path: string; mime: string } | null {
  const r = rec(raw);
  const path = str(r?.path);
  const mime = str(r?.mime);
  if (!path || !mime || !(ALLOWED_PHOTO_MIME as readonly string[]).includes(mime)) return null;
  return { path, mime };
}

// ---- wording (Turkish first; no health claim, no guarantee) --------------------------------------------------

function span(days: number): string {
  return days % 7 === 0 ? `${days / 7} hafta` : `${days} gün`;
}

/** "4–8 hafta", "28 gün'den sonra" style: weeks when both bounds are whole weeks, days otherwise. */
export function intervalText(minDays: number, maxDays: number | null): string {
  if (maxDays === null || maxDays === minDays) return span(minDays);
  if (minDays % 7 === 0 && maxDays % 7 === 0) return `${minDays / 7}–${maxDays / 7} hafta`;
  return `${minDays}–${maxDays} gün`;
}

/** The recommended-window line for an Owner's history row, per state. `daysToStart` is windowStart - today, from the database's dates. */
export function rebookText(r: TreatmentRebook, today: string): { headline: string; detail: string; tone: "info" | "due" | "late" | "done" } {
  const detail = `Önerilen tekrar dönemi: ${intervalText(r.minDays, r.maxDays)}`;
  if (r.state === "booked") return { headline: "Tekrar randevu planlandı", detail, tone: "done" };
  if (r.state === "due") return { headline: "Tekrar randevu zamanı", detail, tone: "due" };
  if (r.state === "overdue") return { headline: "Önerilen dönem geçti", detail, tone: "late" };
  const days = Math.round((Date.parse(`${r.windowStart}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return days <= 7 ? { headline: "Tekrar randevu zamanı yaklaşıyor", detail, tone: "info" } : { headline: detail, detail: "", tone: "info" };
}

/** Link to the appointments page with the quick-rebook preselection; ids are validated again by the receiving page. */
export function rebookHref(tenantSlug: string, d: RebookDefaults, customerId?: string): string {
  const q = new URLSearchParams({ rebookService: d.serviceId });
  if (customerId) q.set("rebookCustomer", customerId); // RC.1C: an id only; the receiving page looks the person up under the viewer's own access
  if (d.branchId) q.set("rebookBranch", d.branchId);
  if (d.staffId) q.set("rebookStaff", d.staffId);
  return `/app/${tenantSlug}/appointments?${q.toString()}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The receiving side of rebookHref: only well-formed ids survive, anything else is dropped. */
export function parseRebookParams(sp: Record<string, string | string[] | undefined>): { serviceId: string; branchId?: string; staffId?: string; customerId?: string } | null {
  const one = (k: string) => (typeof sp[k] === "string" && UUID_RE.test(sp[k] as string) ? (sp[k] as string) : undefined);
  const serviceId = one("rebookService");
  if (!serviceId) return null;
  return { serviceId, branchId: one("rebookBranch"), staffId: one("rebookStaff"), customerId: one("rebookCustomer") };
}
