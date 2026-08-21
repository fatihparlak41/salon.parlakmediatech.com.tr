import { describe, expect, it } from "vitest";
import {
  tenantLocalToUtcIso,
  utcIsoToTenantLocalParts,
  getTenantDayRangeUtc,
  getTenantWeekRangeUtc,
  getTenantNowLocalParts,
} from "@/lib/modules/appointments/timezone";

/**
 * Phase 2D.1 — pure unit test, no DB/auth (unlike every other file in
 * tests/**, which hits the real DEV Supabase project). Exists to prove
 * lib/modules/appointments/timezone.ts computes each tenant's real UTC
 * offset from the IANA zone string alone, never from whatever timezone
 * this test runner / a future browser happens to be in — Phase 2E's
 * calendar positions events using this exact module, so a hidden
 * dependency on the local machine's zone would silently misplace every
 * event for any tenant outside that one machine's zone.
 *
 * The proof is structural: every expected UTC instant below is a
 * hand-computed literal against each zone's real, published UTC offset
 * (Asia/Tokyo UTC+9 year-round; America/New_York UTC-5 in January/EST,
 * UTC-4 in July/EDT). These would only accidentally pass if this
 * process's own local zone happened to equal the zone under test, which
 * it does not (and does not need to, for this proof to hold) — every
 * assertion here is checked against Europe/Istanbul's own existing
 * coverage in tests/phase2-appointments.test.ts, which uses a fixed
 * UTC+3 zone; this file deliberately covers a no-DST zone with a
 * DIFFERENT offset (Tokyo) and a DST-observing zone (New York) instead,
 * so Istanbul's coincidentally-simple case can't mask a latent bug.
 *
 * Deliberately does NOT test the spring-forward/fall-back transition
 * days themselves (a wall-clock time that's ambiguous or doesn't exist
 * for an hour) — tzOffsetMinutes's own doc comment already discloses
 * that narrow, twice-yearly limitation, and nothing here proves it's
 * actually broken, so it is out of scope for this cleanup per the
 * instruction not to solve an unproven problem.
 */

describe("tenantLocalToUtcIso / utcIsoToTenantLocalParts — non-Istanbul IANA zones", () => {
  it("Asia/Tokyo (UTC+9, no DST ever) round-trips correctly", () => {
    const utcIso = tenantLocalToUtcIso("2026-06-15", "14:00", "Asia/Tokyo");
    expect(utcIso).toBe("2026-06-15T05:00:00.000Z");

    const back = utcIsoToTenantLocalParts(utcIso, "Asia/Tokyo");
    expect(back).toEqual({ date: "2026-06-15", time: "14:00" });
  });

  it("Asia/Tokyo local midnight crosses back to the previous UTC calendar day", () => {
    // 00:30 Tokyo-local on the 15th is still 15:30 UTC on the 14th — a
    // naive implementation that forgot the offset direction, or that
    // silently used the test runner's own local zone instead of Tokyo's,
    // would very likely get the calendar DATE wrong here, not just the
    // clock time.
    const utcIso = tenantLocalToUtcIso("2026-06-15", "00:30", "Asia/Tokyo");
    expect(utcIso).toBe("2026-06-14T15:30:00.000Z");
  });

  it("America/New_York in January (EST, UTC-5) round-trips correctly", () => {
    const utcIso = tenantLocalToUtcIso("2026-01-15", "10:00", "America/New_York");
    expect(utcIso).toBe("2026-01-15T15:00:00.000Z");

    const back = utcIsoToTenantLocalParts(utcIso, "America/New_York");
    expect(back).toEqual({ date: "2026-01-15", time: "10:00" });
  });

  it("America/New_York in July (EDT, UTC-4) round-trips correctly — same zone, different real offset than January", () => {
    const utcIso = tenantLocalToUtcIso("2026-07-15", "10:00", "America/New_York");
    expect(utcIso).toBe("2026-07-15T14:00:00.000Z");

    const back = utcIsoToTenantLocalParts(utcIso, "America/New_York");
    expect(back).toEqual({ date: "2026-07-15", time: "10:00" });
  });

  it("the same UTC instant maps to different local wall-clock times in different zones — proves the zone parameter, not ambient state, drives the result", () => {
    const utcIso = "2026-06-15T05:00:00.000Z";
    expect(utcIsoToTenantLocalParts(utcIso, "Asia/Tokyo")).toEqual({ date: "2026-06-15", time: "14:00" });
    expect(utcIsoToTenantLocalParts(utcIso, "America/New_York")).toEqual({ date: "2026-06-15", time: "01:00" });
    expect(utcIsoToTenantLocalParts(utcIso, "Europe/Istanbul")).toEqual({ date: "2026-06-15", time: "08:00" });
  });
});

/**
 * Phase 2E — calendar range boundaries. Same non-UTC-zone proof strategy
 * as above: every expected UTC instant is a hand-computed literal
 * against Asia/Tokyo's real, published, DST-free UTC+9 offset — this
 * only passes if getTenantDayRangeUtc/getTenantWeekRangeUtc genuinely
 * use the tenant's own zone, never the browser/test-runner's ambient one.
 */
describe("getTenantDayRangeUtc — non-Istanbul IANA zone", () => {
  it("Asia/Tokyo (UTC+9) day boundaries", () => {
    const { startUtc, endUtc } = getTenantDayRangeUtc("Asia/Tokyo", "2026-06-15");
    expect(startUtc).toBe("2026-06-14T15:00:00.000Z");
    expect(endUtc).toBe("2026-06-15T15:00:00.000Z");
  });

  it("America/New_York (UTC-5, EST) day boundaries", () => {
    const { startUtc, endUtc } = getTenantDayRangeUtc("America/New_York", "2026-01-15");
    expect(startUtc).toBe("2026-01-15T05:00:00.000Z");
    expect(endUtc).toBe("2026-01-16T05:00:00.000Z");
  });
});

describe("getTenantWeekRangeUtc — Monday-starting week, non-Istanbul IANA zone", () => {
  // 2026-01-01 is a Thursday (independently verifiable: 2024-01-01 was a
  // Monday; 2024 is a leap year (366 days, 366 mod 7 = 2) so 2025-01-01
  // was a Wednesday; 2025 is not a leap year (365 days, 365 mod 7 = 1)
  // so 2026-01-01 is a Thursday) — its Monday is 2025-12-29, crossing
  // both a month and a year boundary, which exercises the day-arithmetic
  // more than a same-month example would.
  it("computes the correct 7 consecutive Monday-starting dates", () => {
    const { days } = getTenantWeekRangeUtc("Europe/Istanbul", "2026-01-01");
    expect(days).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });

  it("returns the same week regardless of which day within it is passed in", () => {
    const fromThursday = getTenantWeekRangeUtc("Europe/Istanbul", "2026-01-01");
    const fromMonday = getTenantWeekRangeUtc("Europe/Istanbul", "2025-12-29");
    const fromSunday = getTenantWeekRangeUtc("Europe/Istanbul", "2026-01-04");
    expect(fromMonday.days).toEqual(fromThursday.days);
    expect(fromSunday.days).toEqual(fromThursday.days);
  });

  it("UTC range boundaries are computed in the tenant zone, not UTC", () => {
    const { startUtc, endUtc } = getTenantWeekRangeUtc("Asia/Tokyo", "2026-01-01");
    // Monday 2025-12-29 00:00 Tokyo-local -> UTC (-9h)
    expect(startUtc).toBe("2025-12-28T15:00:00.000Z");
    // Following Monday 2026-01-05 00:00 Tokyo-local -> UTC (-9h)
    expect(endUtc).toBe("2026-01-04T15:00:00.000Z");
  });
});

describe("getTenantNowLocalParts", () => {
  it("returns internally consistent tenant-local now (date/weekday agree, minutes in range)", () => {
    const parts = getTenantNowLocalParts("Asia/Tokyo");
    expect(parts.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parts.minutesSinceMidnight).toBeGreaterThanOrEqual(0);
    expect(parts.minutesSinceMidnight).toBeLessThan(1440);
    const [y, m, d] = parts.date.split("-").map(Number) as [number, number, number];
    // Independent cross-check: the calendar weekday of the returned date
    // string, computed via Date.UTC (a pure calendar-date fact, not a
    // timezone conversion), must agree with the returned weekday field.
    expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay()).toBe(parts.weekday);
  });
});
