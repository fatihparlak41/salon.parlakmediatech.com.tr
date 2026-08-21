import { describe, expect, it } from "vitest";
import {
  tenantLocalToUtcIso,
  utcIsoToTenantLocalParts,
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
