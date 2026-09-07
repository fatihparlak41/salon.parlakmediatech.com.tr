/**
 * Faz 5A.3C — pure, client-safe formatting helpers for the reports UI.
 * Deliberately NOT in queries.ts (which is "server-only" end to end) —
 * these run in the browser too, formatting values the server already
 * computed and passed down as props.
 */

/** {hours}/{minutes} placeholder substitution into a next-intl message
 * string that was resolved server-side with literal "{hours}"/"{minutes}"
 * tokens still in it (see the page's own labels object) — lets the
 * client format a value next-intl itself never sees at render time. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, String(value));
  }
  return result;
}

/** completedMinutes/scheduledMinutes -> {hours, minutes} for display via
 * minutesFormatTemplate ("{hours}s {minutes}dk"). Minutes are already
 * whole numbers from both RPCs' own item-count-derived sums, so no
 * rounding surprises here. */
export function splitMinutes(totalMinutes: number): { hours: number; minutes: number } {
  const safe = Math.max(0, Math.round(totalMinutes));
  return { hours: Math.floor(safe / 60), minutes: safe % 60 };
}

/** Renders the raw utilization ratio (0.85 -> "%85"), NEVER capped above
 * 100, NEVER shown as "0%" for the null (no schedule) case — callers
 * check for null themselves and render the dedicated unavailable/helper
 * copy instead of calling this. */
export function formatUtilizationPercent(ratio: number): string {
  return `%${Math.round(ratio * 100)}`;
}
