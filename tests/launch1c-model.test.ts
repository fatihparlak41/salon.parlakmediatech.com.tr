import { describe, expect, it } from "vitest";
import {
  WEEK_ORDER,
  copyDay,
  currentStepKey,
  defaultWeek,
  parseOnboardingStatus,
  parseServiceLines,
  parseStaffLines,
  publicBookingUrl,
  shouldOfferOnboarding,
  stepProgress,
  weekToRows,
  type OnboardingStatus,
} from "@/lib/modules/onboarding/model";

/**
 * Faz LAUNCH.1C — the pure view model. Readiness is decided by the database; here we pin that the app never
 * invents it: a malformed or self-contradictory answer is "unknown" (null), never "ready".
 */

function statusJson(overrides: Record<string, unknown> = {}) {
  return {
    ready: false,
    blockers: ["no_services"],
    bookingEngineReady: false,
    bookingEngineBlockers: ["no_services"],
    tenantSlug: "ornek-salon",
    profile: { name: "Ornek", timezone: "Europe/Istanbul", currency: "TRY", phone: "0532", missing: [] },
    counts: { services: 0, staff: 1, staffWithHours: 1, bookablePaths: 0 },
    onlineBookingEnabled: true,
    hasAppointments: false,
    firstAvailableSlotAt: null,
    steps: [
      { key: "profile", done: true },
      { key: "services", done: false },
      { key: "staff", done: true },
      { key: "hours", done: true },
      { key: "mapping", done: false },
      { key: "booking", done: true },
      { key: "ready", done: false },
    ],
    ...overrides,
  };
}

describe("parseOnboardingStatus", () => {
  it("accepts the database answer and keeps its facts", () => {
    const parsed = parseOnboardingStatus(statusJson())!;
    expect(parsed.ready).toBe(false);
    expect(parsed.blockers).toEqual(["no_services"]);
    expect(parsed.counts.staff).toBe(1);
    expect(parsed.steps).toHaveLength(7);
  });

  it("a malformed answer is UNKNOWN, never ready", () => {
    for (const bad of [
      null,
      undefined,
      "ready",
      [],
      {},
      statusJson({ ready: "yes" }),
      statusJson({ blockers: "no_services" }),
      statusJson({ counts: { services: -1, staff: 1, staffWithHours: 1, bookablePaths: 0 } }),
      statusJson({ counts: { services: 1.5, staff: 1, staffWithHours: 1, bookablePaths: 0 } }),
      statusJson({ profile: null }),
      statusJson({ steps: [] }),
      statusJson({ steps: [{ key: "bogus", done: true }] }),
      statusJson({ onlineBookingEnabled: "true" }),
    ]) {
      expect(parseOnboardingStatus(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("an unknown blocker code is refused (a newer database than the app must not be read as ready)", () => {
    expect(parseOnboardingStatus(statusJson({ blockers: ["something_new"] }))).toBeNull();
  });

  it("a self-contradictory answer is refused: ready with blockers, or not ready without any", () => {
    expect(parseOnboardingStatus(statusJson({ ready: true, blockers: ["no_services"] }))).toBeNull();
    expect(parseOnboardingStatus(statusJson({ ready: false, blockers: [] }))).toBeNull();
    expect(parseOnboardingStatus(statusJson({ ready: true, blockers: [], bookingEngineReady: true, bookingEngineBlockers: [] }))).not.toBeNull();
  });
});

describe("booking engine readiness is consistent with the full answer", () => {
  it("refuses an engine answer that contradicts itself or the blockers", () => {
    for (const bad of [
      statusJson({ bookingEngineReady: true }), // says ready but lists a blocker
      statusJson({ bookingEngineReady: false, bookingEngineBlockers: [] }),
      statusJson({ bookingEngineBlockers: ["no_staff"] }), // not among the blockers
      statusJson({ bookingEngineReady: "yes" }),
      statusJson({ bookingEngineBlockers: "no_services" }),
      statusJson({ ready: true, blockers: [], bookingEngineReady: false, bookingEngineBlockers: [] }),
      (() => {
        const j = statusJson();
        delete (j as Record<string, unknown>).bookingEngineReady;
        return j;
      })(),
    ]) {
      expect(parseOnboardingStatus(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("a 'ready' flag that disagrees with the blockers is refused even when the engine answer is internally fine; an unknown code is refused wherever it appears", () => {
    expect(parseOnboardingStatus(statusJson({ ready: true, blockers: ["salon_profile_missing"], bookingEngineReady: true, bookingEngineBlockers: [] }))).toBeNull();
    expect(parseOnboardingStatus(statusJson({ ready: false, blockers: ["something_new"], bookingEngineReady: true, bookingEngineBlockers: [] }))).toBeNull();
  });

  it("the engine can be ready while the onboarding is not (profile / public switch only)", () => {
    const parsed = parseOnboardingStatus(statusJson({ blockers: ["salon_profile_missing"], bookingEngineReady: true, bookingEngineBlockers: [] }))!;
    expect(parsed.ready).toBe(false);
    expect(parsed.bookingEngineReady).toBe(true);
  });
});

describe("step helpers", () => {
  const status = parseOnboardingStatus(statusJson()) as OnboardingStatus;

  it("opens on the first step that is not done, and on 'ready' when everything is", () => {
    expect(currentStepKey(status)).toBe("services");
    const allDone = parseOnboardingStatus(
      statusJson({ ready: true, blockers: [], bookingEngineReady: true, bookingEngineBlockers: [], steps: status.steps.map((s) => ({ ...s, done: true })) }),
    ) as OnboardingStatus;
    expect(currentStepKey(allDone)).toBe("ready");
  });

  it("progress counts the six real steps, not the closing 'ready'", () => {
    expect(stepProgress(status)).toEqual({ done: 4, total: 6 });
  });

  it("the setup is offered only while not ready AND the salon has never had an appointment", () => {
    expect(shouldOfferOnboarding(status)).toBe(true);
    expect(shouldOfferOnboarding({ ...status, hasAppointments: true })).toBe(false);
    expect(shouldOfferOnboarding({ ...status, ready: true, blockers: [] })).toBe(false);
    expect(shouldOfferOnboarding(null)).toBe(false);
  });

  it("builds the public booking address without doubling slashes", () => {
    expect(publicBookingUrl("https://salon.example.test/", "ornek")).toBe("https://salon.example.test/book/ornek");
    expect(publicBookingUrl("https://salon.example.test", "ornek")).toBe("https://salon.example.test/book/ornek");
  });
});

describe("parseServiceLines", () => {
  it("semicolon lines: name; minutes; price", () => {
    expect(parseServiceLines("Saç Kesimi; 45; 800\nFön; 30 dk; 400 TL")).toEqual([
      { name: "Saç Kesimi", category: "", durationMinutes: "45", price: "800" },
      { name: "Fön", category: "", durationMinutes: "30", price: "400" },
    ]);
  });

  it("category column, '# Category' headings, comma and tab separators, spreadsheet paste", () => {
    const rows = parseServiceLines(["# Saç", "Saç Kesimi; 45; 800", "Tırnak; Manikür; 45; 600", "Boya, 120, 2500", "Fön\t30\t400"].join("\n"));
    expect(rows).toEqual([
      { name: "Saç Kesimi", category: "Saç", durationMinutes: "45", price: "800" },
      { name: "Manikür", category: "Tırnak", durationMinutes: "45", price: "600" },
      { name: "Boya", category: "Saç", durationMinutes: "120", price: "2500" },
      { name: "Fön", category: "Saç", durationMinutes: "30", price: "400" },
    ]);
  });

  it("Turkish number formats become plain decimals", () => {
    const [a, b, c] = parseServiceLines("A; 30; 1.250,50 ₺\nB; 30; 99,5\nC, 30, 2500, 50");
    expect(a!.price).toBe("1250.50");
    expect(b!.price).toBe("99.5");
    expect(c!.price).toBe("2500.50");
  });

  it("ignores blank lines and keeps incomplete lines so the Owner sees (and fixes) them", () => {
    const rows = parseServiceLines("\n\nSadece Ad\n");
    expect(rows).toEqual([{ name: "Sadece Ad", category: "", durationMinutes: "", price: "" }]);
  });
});

describe("parseStaffLines", () => {
  it("one person per line, optional phone", () => {
    expect(parseStaffLines("Ayşe Demir\n\nMehmet Kaya; 0533 111 22 33\n")).toEqual([
      { fullName: "Ayşe Demir", phone: "" },
      { fullName: "Mehmet Kaya", phone: "0533 111 22 33" },
    ]);
  });
});

describe("weekly hours template", () => {
  it("default week: Monday–Saturday open 09:00–18:00, Sunday closed", () => {
    const week = defaultWeek();
    expect(WEEK_ORDER.map((d) => week[d.weekday]!.open)).toEqual([true, true, true, true, true, true, false]);
    const built = weekToRows(week);
    expect("rows" in built && built.rows).toHaveLength(6);
  });

  it("copying Monday onto the working days; a closed source stays closed; Sunday is untouched", () => {
    let week = defaultWeek();
    week = { ...week, 1: { ...week[1]!, start: "10:00", end: "19:00", breakEnabled: true } };
    const copied = copyDay(week, 1, [2, 3, 4, 5, 6]);
    for (const d of [2, 3, 4, 5, 6]) expect(copied[d]).toMatchObject({ start: "10:00", end: "19:00", breakEnabled: true });
    expect(copied[0]).toEqual(week[0]);
    const closedSource = copyDay({ ...week, 1: { ...week[1]!, open: false } }, 1, [2]);
    expect(closedSource[2]!.open).toBe(false);
  });

  it("a break splits the day into two rows", () => {
    const week = defaultWeek();
    week[1] = { ...week[1]!, breakEnabled: true, breakStart: "13:00", breakEnd: "14:00" };
    const built = weekToRows({ ...week, 2: { ...week[2]!, open: false }, 3: { ...week[3]!, open: false }, 4: { ...week[4]!, open: false }, 5: { ...week[5]!, open: false }, 6: { ...week[6]!, open: false } });
    expect(built).toEqual({
      rows: [
        { weekday: 1, start: "09:00", end: "13:00" },
        { weekday: 1, start: "14:00", end: "18:00" },
      ],
    });
  });

  it("inconsistent days are reported instead of sent", () => {
    const week = defaultWeek();
    expect(weekToRows({ ...week, 1: { ...week[1]!, start: "18:00", end: "09:00" } })).toEqual({ error: "order" });
    expect(weekToRows({ ...week, 1: { ...week[1]!, start: "9am" } })).toEqual({ error: "time" });
    expect(weekToRows({ ...week, 1: { ...week[1]!, breakEnabled: true, breakStart: "08:00", breakEnd: "09:30" } })).toEqual({ error: "break" });
    expect(weekToRows({ ...week, 1: { ...week[1]!, breakEnabled: true, breakStart: "17:00", breakEnd: "19:00" } })).toEqual({ error: "break" });
  });
});
