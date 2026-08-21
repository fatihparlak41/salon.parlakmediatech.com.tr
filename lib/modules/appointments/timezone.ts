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

/** Today's date (as tenant-local YYYY-MM-DD) and the UTC instant range
 * covering that entire tenant-local calendar day — used for the "today"
 * appointment-list filter, computed server-side-equivalent (never the
 * browser's own local calendar day). */
export function getTenantTodayRangeUtc(tenantTz: string): { today: string; startUtc: string; endUtc: string } {
  const now = new Date();
  const offset = tzOffsetMinutes(tenantTz, now);
  const localNow = new Date(now.getTime() + offset * 60000);
  const y = localNow.getUTCFullYear();
  const m = localNow.getUTCMonth();
  const d = localNow.getUTCDate();
  const todayStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const startLocalAsUtc = Date.UTC(y, m, d, 0, 0, 0);
  const endLocalAsUtc = Date.UTC(y, m, d + 1, 0, 0, 0);
  return {
    today: todayStr,
    startUtc: new Date(startLocalAsUtc - offset * 60000).toISOString(),
    endUtc: new Date(endLocalAsUtc - offset * 60000).toISOString(),
  };
}
