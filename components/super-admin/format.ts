/** Display helpers for the Super Admin console (pure; no Date.now() hidden inside, the caller passes "now" so server render and tests agree). */

const DATE = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Istanbul" });
const DATE_TIME = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" });

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE.format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE_TIME.format(d);
}

export type Relative = { kind: "never" } | { kind: "today" } | { kind: "yesterday" } | { kind: "days"; n: number };

/** Whole days between `iso` and `now`, by Istanbul calendar day (so "yesterday" means the previous local day, not 24 h ago). */
export function relativeDays(iso: string | null | undefined, now: Date): Relative {
  if (!iso) return { kind: "never" };
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return { kind: "never" };
  const day = (d: Date) => Math.floor((d.getTime() + 3 * 3600 * 1000) / 86_400_000); // Istanbul is UTC+3 all year
  const diff = day(now) - day(then);
  if (diff <= 0) return { kind: "today" };
  if (diff === 1) return { kind: "yesterday" };
  return { kind: "days", n: diff };
}

export function relativeLabel(rel: Relative, labels: { never: string; today: string; yesterday: string; daysAgo: string }): string {
  switch (rel.kind) {
    case "never":
      return labels.never;
    case "today":
      return labels.today;
    case "yesterday":
      return labels.yesterday;
    default:
      return labels.daysAgo.replace("{n}", String(rel.n));
  }
}
