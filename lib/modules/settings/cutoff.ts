/**
 * Faz 2I.4A — pure cutoff-conversion/decision logic for
 * SelfServicePolicyForm, extracted so it's unit-testable without a
 * DOM/component-rendering harness (this project has none — every
 * existing test exercises real backend behavior, not rendered React;
 * see tests/*.test.ts). No React import here on purpose.
 */

export type Unit = "minutes" | "hours" | "days";
export const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

/** A sensible starting point suggested ONLY in local, unsaved form state
 * — see resolveCutoffOnToggle. Never written anywhere until the owner
 * explicitly saves, and never applied over a cutoff the owner has
 * actually changed since the last successful save, or that's already
 * persisted nonzero. */
export const SUGGESTED_CUTOFF_MINUTES = 720; // 12 hours

/** Picks the coarsest unit that divides evenly into the stored minute
 * value, so e.g. 180 displays as "3 saat" not "180 dakika" — purely a
 * display convenience, the canonical value is always minutes. */
export function splitMinutes(totalMinutes: number): { amount: number; unit: Unit } {
  if (totalMinutes !== 0 && totalMinutes % 1440 === 0) return { amount: totalMinutes / 1440, unit: "days" };
  if (totalMinutes !== 0 && totalMinutes % 60 === 0) return { amount: totalMinutes / 60, unit: "hours" };
  return { amount: totalMinutes, unit: "minutes" };
}

export function toMinutes(amount: number, unit: Unit): number {
  return Math.max(0, Math.round(amount * UNIT_MINUTES[unit]));
}

/**
 * Faz 2I.4A (fix), Faz 2I.4B (dirty-tracking integration) — decides the
 * cutoff value to carry forward when the enable toggle changes state,
 * and whether that change should mark the cutoff dirty (i.e. included
 * in the next save) as part of the SAME operation.
 *
 * Only ever substitutes SUGGESTED_CUTOFF_MINUTES — and only ever
 * reports the cutoff as newly dirty — when turning the toggle ON *and*
 * the cutoff is still exactly its untouched-since-last-save 0 default.
 * Never when turning off, never when the owner has already changed the
 * cutoff since the last successful save (even to explicitly choose 0, a
 * meaningful choice in its own right — "up to the appointment start
 * itself"), and never when the value is already nonzero (an existing,
 * deliberately-configured tenant setting must never be silently
 * overwritten by re-toggling, and turning the feature off must never
 * erase it either — see the Faz 2I.4B report's toggle/cutoff pairing
 * rules).
 *
 * `cutoffDirty` here means precisely "changed since the last successful
 * save" (SelfServicePolicyForm's `dirty` set), never "touched at some
 * point in this component's lifetime" — the exact distinction the Faz
 * 2I.4B fix's dirty-state model depends on throughout.
 */
export function resolveCutoffOnToggle(params: {
  turningOn: boolean;
  currentMinutes: number;
  cutoffDirty: boolean;
}): { minutes: number; suggested: boolean } {
  if (params.turningOn && params.currentMinutes === 0 && !params.cutoffDirty) {
    return { minutes: SUGGESTED_CUTOFF_MINUTES, suggested: true };
  }
  return { minutes: params.currentMinutes, suggested: false };
}
