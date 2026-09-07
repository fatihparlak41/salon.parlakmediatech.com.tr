/**
 * Tenant-local <-> UTC conversion for the appointment create/reschedule
 * UI. Never uses the browser's own timezone as business truth — the
 * salon's tenant.timezone is the only authority, matching the rule
 * already enforced server-side in private.staff_is_available.
 *
 * Uses Intl.DateTimeFormat to extract a timezone's real offset at a
 * given instant (DST-correct, no hardcoded rule for any specific zone —
 * same country-agnostic approach as Phase 2C's phone/email
 * normalization) rather than a date library dependency. Single-pass: can
 * be off by the DST delta for a local time that falls exactly inside a
 * spring-forward gap or fall-back ambiguity — a narrow, twice-yearly
 * window irrelevant for Europe/Istanbul (fixed UTC+3, no DST) and an
 * accepted limitation elsewhere per Phase 2D's "practical operator UX is
 * sufficient" standard for time/availability handling.
 */

function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** "2026-09-15" + "09:00" interpreted as tenant-local wall-clock time ->
 * the correct UTC ISO instant for RPC input. */
export function tenantLocalToUtcIso(dateStr: string, timeStr: string, tenantTz: string): string {
  const naiveUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const offset = tzOffsetMinutes(tenantTz, naiveUtc);
  return new Date(naiveUtc.getTime() - offset * 60000).toISOString();
}

/** A stored UTC ISO instant -> tenant-local wall-clock date/time parts,
 * for display and for pre-filling edit forms. */
export function utcIsoToTenantLocalParts(isoString: string, tenantTz: string): { date: string; time: string } {
  const d = new Date(isoString);
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tenantTz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function formatTenantLocalDateTime(isoString: string, tenantTz: string): string {
  const { date, time } = utcIsoToTenantLocalParts(isoString, tenantTz);
  return `${date} ${time}`;
}

export function formatTenantLocalTime(isoString: string, tenantTz: string): string {
  return utcIsoToTenantLocalParts(isoString, tenantTz).time;
}

/** The UTC instant range covering one tenant-local calendar day (given as
 * "YYYY-MM-DD"). Computes the offset separately at each boundary rather
 * than reusing one offset for both — immaterial for a fixed-offset zone
 * like Europe/Istanbul, marginally more correct for a DST-observing one,
 * and still subject to the same documented ambiguous/nonexistent
 * wall-clock limitation as tzOffsetMinutes itself on a transition day. */
export function getTenantDayRangeUtc(tenantTz: string, dateStr: string): { startUtc: string; endUtc: string } {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const startLocalAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const endLocalAsUtc = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  const startOffset = tzOffsetMinutes(tenantTz, new Date(startLocalAsUtc));
  const endOffset = tzOffsetMinutes(tenantTz, new Date(endLocalAsUtc));
  return {
    startUtc: new Date(startLocalAsUtc - startOffset * 60000).toISOString(),
    endUtc: new Date(endLocalAsUtc - endOffset * 60000).toISOString(),
  };
}

/** Today's date (as tenant-local YYYY-MM-DD) and the UTC instant range
 * covering that entire tenant-local calendar day — used for the "today"
 * appointment-list filter and the calendar's own "Bugün" navigation,
 * computed server-side-equivalent (never the browser's own local
 * calendar day). */
export function getTenantTodayRangeUtc(tenantTz: string): { today: string; startUtc: string; endUtc: string } {
  const now = new Date();
  const offset = tzOffsetMinutes(tenantTz, now);
  const localNow = new Date(now.getTime() + offset * 60000);
  const todayStr = `${localNow.getUTCFullYear()}-${String(localNow.getUTCMonth() + 1).padStart(2, "0")}-${String(localNow.getUTCDate()).padStart(2, "0")}`;
  return { today: todayStr, ...getTenantDayRangeUtc(tenantTz, todayStr) };
}

/** Tenant-local "now" as calendar-navigation-friendly parts: today's date
 * string, current wall-clock minutes-since-midnight (for the calendar's
 * current-time indicator), and the weekday (0=Sunday..6=Saturday,
 * matching Postgres EXTRACT(DOW) — the same convention already used by
 * staff_schedules/schedule-tab.tsx). */
export function getTenantNowLocalParts(tenantTz: string): { date: string; minutesSinceMidnight: number; weekday: number } {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tenantTz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(dtf.formatToParts(now).map((p) => [p.type, p.value]));
  const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutesSinceMidnight: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday!] ?? new Date(now).getUTCDay(),
  };
}

/** The Monday-starting tenant-local week (matching the Turkish-week
 * display convention already established in staff/tabs/schedule-tab.tsx)
 * containing the given "YYYY-MM-DD" date: each of the 7 day-date-strings
 * in order, and the overall UTC range from that Monday's start to the
 * following Monday's start. Pure calendar-date arithmetic on the date
 * string itself — this part needs no timezone conversion, since a bare
 * "YYYY-MM-DD" unambiguously names one calendar date regardless of zone;
 * only the final UTC boundary conversion goes through getTenantDayRangeUtc. */
export function getTenantWeekRangeUtc(
  tenantTz: string,
  dateStr: string,
): { days: string[]; startUtc: string; endUtc: string } {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sunday..6=Saturday
  const daysSinceMonday = (dow + 6) % 7;
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d - daysSinceMonday + i));
    days.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`);
  }
  const { startUtc } = getTenantDayRangeUtc(tenantTz, days[0]!);
  const { endUtc } = getTenantDayRangeUtc(tenantTz, days[6]!);
  return { days, startUtc, endUtc };
}

/** Faz 5A.3C — the tenant-local calendar MONTH containing "YYYY-MM-DD",
 * as a UTC [startUtc, endUtc) range from that month's 1st through the
 * following month's 1st. Same "compute local calendar boundaries as date
 * strings, then convert each through getTenantDayRangeUtc" shape as
 * getTenantWeekRangeUtc above — deliberately not a list of every day in
 * the month (reports don't need per-day buckets, only the outer range;
 * the RPCs themselves do any day-level work). */
export function getTenantMonthRangeUtc(
  tenantTz: string,
  dateStr: string,
): { startUtc: string; endUtc: string } {
  const [y, m] = dateStr.split("-").map(Number) as [number, number];
  const startDateStr = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const endDateStr = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  const { startUtc } = getTenantDayRangeUtc(tenantTz, startDateStr);
  const { endUtc } = getTenantDayRangeUtc(tenantTz, endDateStr);
  return { startUtc, endUtc };
}

/** Faz 5A.3C — the last N tenant-local calendar days, INCLUSIVE of today
 * (so n=30 covers today and the 29 days before it) — "Son 30 Gün" as a
 * salon operator reads it, not an exclusive rolling window. Reuses
 * getTenantTodayRangeUtc for both today's own date string and its own
 * endUtc, so this and "Bugün" always agree on where "today" ends. */
export function getTenantLastNDaysRangeUtc(
  tenantTz: string,
  n: number,
): { startUtc: string; endUtc: string } {
  const { today, endUtc } = getTenantTodayRangeUtc(tenantTz);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const startDt = new Date(Date.UTC(y, m - 1, d - (n - 1)));
  const startDateStr = `${startDt.getUTCFullYear()}-${String(startDt.getUTCMonth() + 1).padStart(2, "0")}-${String(startDt.getUTCDate()).padStart(2, "0")}`;
  const { startUtc } = getTenantDayRangeUtc(tenantTz, startDateStr);
  return { startUtc, endUtc };
}
