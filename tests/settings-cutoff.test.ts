import { describe, expect, it } from "vitest";
import { splitMinutes, toMinutes, resolveCutoffOnToggle, SUGGESTED_CUTOFF_MINUTES } from "@/lib/modules/settings/cutoff";

/**
 * Faz 2I.4A — pure unit coverage for the cutoff-conversion/decision
 * logic extracted from SelfServicePolicyForm/CutoffInput. No DOM
 * needed: this project has no component-rendering test harness (every
 * other test file exercises real backend behavior), so the diagnosed
 * bug's actual fix logic is covered here as plain functions, and the
 * end-to-end UI behavior was verified live against a real DEV browser
 * session (see the Faz 2I.4A diagnosis/fix report) rather than a
 * simulated DOM.
 */

describe("splitMinutes", () => {
  it("0 stays minutes/0, not hours/0 or days/0", () => {
    expect(splitMinutes(0)).toEqual({ amount: 0, unit: "minutes" });
  });

  it("picks the coarsest unit that divides evenly", () => {
    expect(splitMinutes(45)).toEqual({ amount: 45, unit: "minutes" });
    expect(splitMinutes(90)).toEqual({ amount: 90, unit: "minutes" }); // 90 % 60 !== 0
    expect(splitMinutes(60)).toEqual({ amount: 1, unit: "hours" });
    expect(splitMinutes(180)).toEqual({ amount: 3, unit: "hours" });
    expect(splitMinutes(720)).toEqual({ amount: 12, unit: "hours" }); // the pilot's intended value
    expect(splitMinutes(1440)).toEqual({ amount: 1, unit: "days" });
    expect(splitMinutes(10080)).toEqual({ amount: 7, unit: "days" }); // the DB's own upper bound
  });
});

describe("toMinutes", () => {
  it("converts each unit correctly, rounds, and never goes negative", () => {
    expect(toMinutes(12, "hours")).toBe(720);
    expect(toMinutes(1, "days")).toBe(1440);
    expect(toMinutes(45, "minutes")).toBe(45);
    expect(toMinutes(1.6, "minutes")).toBe(2); // rounds
    expect(toMinutes(-5, "minutes")).toBe(0); // clamped, matches the DB's >= 0 CHECK constraint
  });
});

describe("resolveCutoffOnToggle — the Faz 2I.4A fix", () => {
  it("turning ON with an untouched 0 cutoff suggests 12 hours (720) — the exact scenario that was silently saving 0 before the fix", () => {
    expect(resolveCutoffOnToggle({ turningOn: true, currentMinutes: 0, touched: false })).toBe(
      SUGGESTED_CUTOFF_MINUTES,
    );
  });

  it("turning ON does NOT override a cutoff the owner has already touched this session, even if it's 0 (0 is a valid, explicit choice)", () => {
    expect(resolveCutoffOnToggle({ turningOn: true, currentMinutes: 0, touched: true })).toBe(0);
  });

  it("turning ON never overrides an already nonzero (deliberately configured) cutoff", () => {
    expect(resolveCutoffOnToggle({ turningOn: true, currentMinutes: 180, touched: false })).toBe(180);
    expect(resolveCutoffOnToggle({ turningOn: true, currentMinutes: 180, touched: true })).toBe(180);
  });

  it("turning OFF never changes the cutoff value, touched or not", () => {
    expect(resolveCutoffOnToggle({ turningOn: false, currentMinutes: 0, touched: false })).toBe(0);
    expect(resolveCutoffOnToggle({ turningOn: false, currentMinutes: 720, touched: true })).toBe(720);
  });
});
