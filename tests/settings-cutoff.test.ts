import { describe, expect, it } from "vitest";
import { splitMinutes, toMinutes, resolveCutoffOnToggle, SUGGESTED_CUTOFF_MINUTES } from "@/lib/modules/settings/cutoff";
import { selfServicePolicySchema } from "@/lib/modules/settings/schemas";

/**
 * Faz 2I.4A/2I.4B — pure unit coverage for the cutoff-conversion/
 * decision logic extracted from SelfServicePolicyForm/CutoffInput, and
 * for the partial-update schema's validation rules. No DOM needed: this
 * project has no component-rendering test harness (every other test
 * file exercises real backend behavior), so the diagnosed bugs' actual
 * fix logic is covered here as plain functions, and the end-to-end UI
 * behavior was verified live against real DEV browser sessions (see the
 * Faz 2I.4A/2I.4B reports) rather than a simulated DOM.
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

describe("resolveCutoffOnToggle — the Faz 2I.4A fix, expressed against Faz 2I.4B's dirty-since-last-save model", () => {
  it("turning ON with a not-dirty 0 cutoff suggests 12 hours (720) AND reports it as newly dirty — the exact scenario that was silently saving 0 before the fix", () => {
    expect(resolveCutoffOnToggle({ turningOn: true, currentMinutes: 0, cutoffDirty: false })).toEqual({
      minutes: SUGGESTED_CUTOFF_MINUTES,
      suggested: true,
    });
  });

  it("turning ON does NOT override a cutoff already dirty this round, even if it's 0 (0 is a valid, explicit choice) — and does not report it as newly dirty", () => {
    expect(resolveCutoffOnToggle({ turningOn: true, currentMinutes: 0, cutoffDirty: true })).toEqual({
      minutes: 0,
      suggested: false,
    });
  });

  it("turning ON never overrides an already nonzero (deliberately configured) cutoff, dirty or not", () => {
    expect(resolveCutoffOnToggle({ turningOn: true, currentMinutes: 180, cutoffDirty: false })).toEqual({
      minutes: 180,
      suggested: false,
    });
    expect(resolveCutoffOnToggle({ turningOn: true, currentMinutes: 180, cutoffDirty: true })).toEqual({
      minutes: 180,
      suggested: false,
    });
  });

  it("turning OFF never changes the cutoff value or marks it dirty — disabling a feature must not erase its cutoff", () => {
    expect(resolveCutoffOnToggle({ turningOn: false, currentMinutes: 0, cutoffDirty: false })).toEqual({
      minutes: 0,
      suggested: false,
    });
    expect(resolveCutoffOnToggle({ turningOn: false, currentMinutes: 720, cutoffDirty: true })).toEqual({
      minutes: 720,
      suggested: false,
    });
  });
});

describe("selfServicePolicySchema — partial validation (Faz 2I.4B)", () => {
  const base = { tenantId: "11111111-1111-4111-8111-111111111111", tenantSlug: "test-salon" };

  it("accepts a single field present", () => {
    expect(selfServicePolicySchema.safeParse({ ...base, rescheduleEnabled: false }).success).toBe(true);
    expect(selfServicePolicySchema.safeParse({ ...base, cancellationCutoffMinutes: 720 }).success).toBe(true);
  });

  it("accepts all four fields present (the pre-2I.4B shape still works)", () => {
    const result = selfServicePolicySchema.safeParse({
      ...base,
      cancellationEnabled: true,
      cancellationCutoffMinutes: 720,
      rescheduleEnabled: false,
      rescheduleCutoffMinutes: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload with zero policy fields — the server's own defense against an empty write, independent of the client's own guard", () => {
    const result = selfServicePolicySchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it("still enforces type/range validation on whichever fields are present", () => {
    expect(selfServicePolicySchema.safeParse({ ...base, cancellationCutoffMinutes: -1 }).success).toBe(false);
    expect(selfServicePolicySchema.safeParse({ ...base, cancellationCutoffMinutes: 10081 }).success).toBe(false);
    expect(selfServicePolicySchema.safeParse({ ...base, rescheduleEnabled: "yes" }).success).toBe(false);
  });
});
