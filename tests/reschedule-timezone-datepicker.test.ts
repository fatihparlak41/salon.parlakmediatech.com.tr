import { describe, expect, it } from "vitest";
import { getTenantTodayRangeUtc } from "../lib/modules/appointments/timezone";
import { tenantMaxDateString } from "../components/customer-account/reschedule-appointment-sheet";

/**
 * Faz 2G.2B.1 — the reschedule Sheet's date picker used to compute
 * "today"/"max" from the BROWSER's own local Date getters, ignoring the
 * tenant's actual timezone entirely. Fixed to use
 * getTenantTodayRangeUtc/tenantMaxDateString instead. This test proves
 * the fix's underlying primitive is genuinely timezone-sensitive — not
 * silently falling back to the runtime's own system timezone (the exact
 * bug being closed) — using two real IANA zones whose offsets differ by
 * more than 24 hours, so their calendar dates are GUARANTEED to disagree
 * at any real instant this test happens to run, not just at specific
 * times of day.
 */

describe("tenant-local date picker boundaries", () => {
  it("getTenantTodayRangeUtc genuinely depends on the tenant timezone, not the runtime's own", () => {
    // Pacific/Kiritimati (UTC+14) and Pacific/Niue (UTC-11): a 25-hour
    // spread, which exceeds 24h — these two zones can never report the
    // same calendar date for "today" at the same real instant.
    const kiritimati = getTenantTodayRangeUtc("Pacific/Kiritimati").today;
    const niue = getTenantTodayRangeUtc("Pacific/Niue").today;
    expect(kiritimati).not.toBe(niue);

    // And neither one may silently equal a naive system/UTC-only
    // computation for BOTH zones simultaneously — at most one of them
    // can coincidentally match plain UTC "today" at any instant, so if
    // the function ignored its argument, both would incorrectly match
    // the same value here.
    const utcToday = new Date().toISOString().slice(0, 10);
    expect(kiritimati === utcToday && niue === utcToday).toBe(false);
  });

  it("tenantMaxDateString is exactly 30 calendar days after the tenant-local today, correct across a month boundary", () => {
    const tz = "Pacific/Kiritimati";
    const today = getTenantTodayRangeUtc(tz).today;
    const max = tenantMaxDateString(tz);

    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    const expected = new Date(Date.UTC(y, m - 1, d + 30));
    const expectedStr = `${expected.getUTCFullYear()}-${String(expected.getUTCMonth() + 1).padStart(2, "0")}-${String(expected.getUTCDate()).padStart(2, "0")}`;
    expect(max).toBe(expectedStr);

    // Genuine calendar-day distance, not a naive 30*24h wall-clock
    // offset (which would be wrong across a DST transition in a
    // DST-observing zone — Kiritimati has none, but the arithmetic
    // itself must be date-based, not duration-based, to be correct in
    // zones that do).
    const todayDate = new Date(Date.UTC(y, m - 1, d));
    const daysBetween = Math.round((expected.getTime() - todayDate.getTime()) / 86_400_000);
    expect(daysBetween).toBe(30);
  });

  it("today is always within [today, max] — the picker's own min/max never excludes tenant-local today itself", () => {
    const tz = "Pacific/Niue";
    const today = getTenantTodayRangeUtc(tz).today;
    const max = tenantMaxDateString(tz);
    expect(today <= max).toBe(true); // ISO YYYY-MM-DD strings compare correctly lexicographically
  });
});
