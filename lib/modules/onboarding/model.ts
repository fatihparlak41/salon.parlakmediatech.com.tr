/**
 * Faz LAUNCH.1C — the guided-onboarding view model.
 *
 * Readiness itself lives in ONE place: the database read model `private.onboarding_status`
 * (served by `public.get_onboarding_status`). Nothing in this file decides whether a salon
 * is ready; it only validates the shape of the answer, names the blockers for people, and
 * parses what the Owner types into quick-add rows. A missing or malformed answer is "not
 * known" (null), never "ready".
 */

export const ONBOARDING_STEP_KEYS = ["profile", "services", "staff", "hours", "mapping", "booking", "ready"] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

export const ONBOARDING_BLOCKERS = [
  "tenant_inactive",
  "salon_profile_missing",
  "no_working_hours",
  "no_services",
  "no_staff",
  "no_bookable_staff",
  "public_booking_disabled",
  "no_available_slot",
] as const;
export type OnboardingBlocker = (typeof ONBOARDING_BLOCKERS)[number];

export type OnboardingStatus = {
  ready: boolean;
  blockers: OnboardingBlocker[];
  tenantSlug: string;
  profile: { name: string; timezone: string; currency: string; phone: string | null; missing: string[] };
  counts: { services: number; staff: number; staffWithHours: number; bookablePaths: number };
  onlineBookingEnabled: boolean;
  hasAppointments: boolean;
  firstAvailableSlotAt: string | null;
  steps: { key: OnboardingStepKey; done: boolean }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Strict parse of the database answer. Anything unexpected → null (the UI then shows "could not check", never "ready"). */
export function parseOnboardingStatus(raw: unknown): OnboardingStatus | null {
  if (!isRecord(raw)) return null;
  const { ready, blockers, tenantSlug, profile, counts, onlineBookingEnabled, hasAppointments, firstAvailableSlotAt, steps } = raw;
  if (typeof ready !== "boolean" || !Array.isArray(blockers) || typeof tenantSlug !== "string") return null;
  if (!isRecord(profile) || !isRecord(counts) || !Array.isArray(steps)) return null;
  if (typeof onlineBookingEnabled !== "boolean" || typeof hasAppointments !== "boolean") return null;

  const known = new Set<string>(ONBOARDING_BLOCKERS);
  if (!blockers.every((b) => typeof b === "string" && known.has(b))) return null;
  // An answer that says "ready" while listing blockers (or the reverse) is internally inconsistent: refuse it.
  if (ready !== (blockers.length === 0)) return null;

  const services = count(counts.services);
  const staff = count(counts.staff);
  const staffWithHours = count(counts.staffWithHours);
  const bookablePaths = count(counts.bookablePaths);
  if (services === null || staff === null || staffWithHours === null || bookablePaths === null) return null;

  if (
    typeof profile.name !== "string" ||
    typeof profile.timezone !== "string" ||
    typeof profile.currency !== "string" ||
    !(profile.phone === null || typeof profile.phone === "string") ||
    !Array.isArray(profile.missing)
  ) {
    return null;
  }

  const stepKeys = new Set<string>(ONBOARDING_STEP_KEYS);
  const parsedSteps: OnboardingStatus["steps"] = [];
  for (const step of steps) {
    if (!isRecord(step) || typeof step.key !== "string" || !stepKeys.has(step.key) || typeof step.done !== "boolean") return null;
    parsedSteps.push({ key: step.key as OnboardingStepKey, done: step.done });
  }
  if (parsedSteps.length !== ONBOARDING_STEP_KEYS.length) return null;

  return {
    ready,
    blockers: blockers as OnboardingBlocker[],
    tenantSlug,
    profile: {
      name: profile.name,
      timezone: profile.timezone,
      currency: profile.currency,
      phone: profile.phone,
      missing: profile.missing.filter((m): m is string => typeof m === "string"),
    },
    counts: { services, staff, staffWithHours, bookablePaths },
    onlineBookingEnabled,
    hasAppointments,
    firstAvailableSlotAt: typeof firstAvailableSlotAt === "string" ? firstAvailableSlotAt : null,
    steps: parsedSteps,
  };
}

/** The step the wizard opens on: the first one that is not done (display only — the data decides, nothing is stored). */
export function currentStepKey(status: OnboardingStatus): OnboardingStepKey {
  return status.steps.find((s) => !s.done)?.key ?? "ready";
}

/** Setup progress for a card: done steps among the six real ones (the closing "ready" step is the result, not a task). */
export function stepProgress(status: OnboardingStatus): { done: number; total: number } {
  const tasks = status.steps.filter((s) => s.key !== "ready");
  return { done: tasks.filter((s) => s.done).length, total: tasks.length };
}

/** The dashboard offers the wizard only to a salon that is not ready AND has never taken an appointment. */
export function shouldOfferOnboarding(status: OnboardingStatus | null): boolean {
  return status !== null && !status.ready && !status.hasAppointments;
}

/** The salon's public booking address; the slug is validated by the database, this only joins it to the site origin. */
export function publicBookingUrl(siteUrl: string, slug: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/book/${slug}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Quick-add parsing (pure; the database validates again — this only turns pasted text into rows)
// ---------------------------------------------------------------------------------------------------------------

export type ServiceRow = { name: string; category: string; durationMinutes: string; price: string };

const DURATION_WORDS = /^(\d{1,4})\s*(dk|dakika|min|minutes)?\.?$/i;

function normalisePrice(raw: string): string {
  const cleaned = raw.replace(/[₺$€£]|tl|try|eur|usd/gi, "").replace(/\s+/g, "");
  // Turkish thousands/decimal: "1.250,50" → "1250.50"; "1250,5" → "1250.5"; "800" → "800"
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(cleaned)) return cleaned.replace(/\./g, "").replace(",", ".");
  if (/^\d+,\d{1,2}$/.test(cleaned)) return cleaned.replace(",", ".");
  return cleaned;
}

/** Fields are split on ; or tab when present (a decimal comma in the price then stays whole); otherwise on commas. */
function splitFields(line: string): string[] {
  if (/[;\t]/.test(line)) return line.split(/[;\t]/).map((p) => p.trim());
  const parts = line.split(",").map((p) => p.trim());
  const last = parts[parts.length - 1] ?? "";
  const before = parts[parts.length - 2] ?? "";
  // "Boya, 120, 2500, 50" → the price was written with a decimal comma
  if (parts.length >= 4 && /^\d{1,2}$/.test(last) && /^\d+$/.test(before)) {
    return [...parts.slice(0, -2), `${before},${last}`];
  }
  return parts;
}

/**
 * One service per line: `Hizmet adı; süre; fiyat` (also tab or comma separated, as pasted from a spreadsheet),
 * optionally prefixed by the category: `Kategori; Hizmet adı; süre; fiyat`. A line that is only `# Kategori`
 * sets the category for the lines below it.
 */
export function parseServiceLines(text: string): ServiceRow[] {
  const rows: ServiceRow[] = [];
  let currentCategory = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      currentCategory = line.replace(/^#+\s*/, "").trim();
      continue;
    }
    const parts = splitFields(line);
    // find the trailing "duration, price" pair; anything before is [category,] name
    if (parts.length < 3) {
      rows.push({ name: parts[0] ?? "", category: currentCategory, durationMinutes: parts[1] ?? "", price: "" });
      continue;
    }
    const price = normalisePrice(parts[parts.length - 1] ?? "");
    const durationRaw = parts[parts.length - 2] ?? "";
    const duration = DURATION_WORDS.exec(durationRaw)?.[1] ?? durationRaw;
    const head = parts.slice(0, -2);
    const name = head.length >= 2 ? head.slice(1).join(", ") : (head[0] ?? "");
    const category = head.length >= 2 ? (head[0] ?? "") : currentCategory;
    rows.push({ name, category, durationMinutes: duration, price });
  }
  return rows;
}

export type StaffRow = { fullName: string; phone: string };

/** One person per line: `Ad Soyad` or `Ad Soyad; telefon`. */
export function parseStaffLines(text: string): StaffRow[] {
  const rows: StaffRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [name = "", phone = ""] = line.split(/[;\t]/).map((p) => p.trim());
    rows.push({ fullName: name, phone });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Weekly hours template
// ---------------------------------------------------------------------------------------------------------------

export type DayHours = { open: boolean; start: string; end: string; breakEnabled: boolean; breakStart: string; breakEnd: string };

/** Monday-first display order, with the database weekday number (0 = Sunday). */
export const WEEK_ORDER: { weekday: number; key: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" }[] = [
  { weekday: 1, key: "mon" },
  { weekday: 2, key: "tue" },
  { weekday: 3, key: "wed" },
  { weekday: 4, key: "thu" },
  { weekday: 5, key: "fri" },
  { weekday: 6, key: "sat" },
  { weekday: 0, key: "sun" },
];

export function defaultWeek(): Record<number, DayHours> {
  const week: Record<number, DayHours> = {};
  for (const { weekday } of WEEK_ORDER) {
    week[weekday] = {
      open: weekday >= 1 && weekday <= 6,
      start: "09:00",
      end: "18:00",
      breakEnabled: false,
      breakStart: "13:00",
      breakEnd: "14:00",
    };
  }
  return week;
}

/** Copy one day's hours onto the chosen other days (closed stays closed if the source is closed). */
export function copyDay(week: Record<number, DayHours>, fromWeekday: number, toWeekdays: number[]): Record<number, DayHours> {
  const source = week[fromWeekday];
  if (!source) return week;
  const next = { ...week };
  for (const weekday of toWeekdays) {
    if (weekday !== fromWeekday) next[weekday] = { ...source };
  }
  return next;
}

export type HoursRow = { weekday: number; start: string; end: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The template → the rows the database takes. Returns a message instead of rows when the template is inconsistent. */
export function weekToRows(week: Record<number, DayHours>): { rows: HoursRow[] } | { error: "time" | "order" | "break" } {
  const rows: HoursRow[] = [];
  for (const { weekday } of WEEK_ORDER) {
    const day = week[weekday];
    if (!day || !day.open) continue;
    if (!TIME.test(day.start) || !TIME.test(day.end)) return { error: "time" };
    if (day.end <= day.start) return { error: "order" };
    if (day.breakEnabled) {
      if (!TIME.test(day.breakStart) || !TIME.test(day.breakEnd)) return { error: "time" };
      if (day.breakEnd <= day.breakStart || day.breakStart <= day.start || day.breakEnd >= day.end) return { error: "break" };
      rows.push({ weekday, start: day.start, end: day.breakStart }, { weekday, start: day.breakEnd, end: day.end });
    } else {
      rows.push({ weekday, start: day.start, end: day.end });
    }
  }
  return { rows };
}
