/**
 * Faz FIN.1B.1 — the two values that identify ONE write attempt: its idempotency key and its payment instant.
 *
 * A dialog creates both exactly once, as useState initializers at mount, and never again (not on render, not on a retry, not
 * when a section is toggled). A retried submit then sends the identical key and payload, so the database returns the original
 * result instead of treating the retry as a different request; closing the dialog and opening it again is a new mount and
 * therefore a new attempt. (FIN.1A's own lesson: an always-mounted dialog, or a paidAt recomputed per submit, let two
 * different payments share one key.)
 */

/** A v4 UUID: crypto.randomUUID where it exists (secure contexts), otherwise built from getRandomValues. */
export function newAttemptKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/** The current instant as an ISO-8601 UTC string with millisecond precision, e.g. 2026-10-03T09:15:30.123Z. */
export function newAttemptInstant(): string {
  return new Date().toISOString();
}
