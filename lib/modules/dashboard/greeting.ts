/**
 * Faz DASHBOARD.1 — pure logic only, deliberately carrying no display
 * text of its own (that lives in messages/tr.json, resolved via
 * next-intl in the page/components, matching every other page in this
 * app) so these stay trivial to unit test in isolation.
 */

export type GreetingBand = "morning" | "day" | "evening";

/** Before noon -> morning, noon to 18:00 -> day, after 18:00 -> evening
 * — ordinary greeting convention, not a business metric. Takes an
 * already-resolved tenant-local hour (0-23); has no timezone opinion of
 * its own. */
export function greetingBandForHour(hour: number): GreetingBand {
  if (hour < 12) return "morning";
  if (hour < 18) return "day";
  return "evening";
}

/** First given name only, for "Günaydın, Gökhan 👋" rather than the full
 * legal name. Null/empty in -> null out, so the caller can fall back to
 * the generic heading. */
export function firstNameOnly(fullName: string | null | undefined): string | null {
  const trimmed = fullName?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}
