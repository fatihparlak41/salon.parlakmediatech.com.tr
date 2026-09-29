/**
 * Faz NOTIF.1B — the one definition of "a valid public-booking email",
 * shared by the client wizard (booking-wizard.tsx, for the live
 * contactValid/"İleri" gate) and the server schema (schemas.ts, via
 * .refine()). Pure and dependency-free on purpose so it is safe in a
 * client bundle: no zod, no server-only import, no DB access.
 *
 * Deliberately narrower than a full RFC 5322 parser — this only needs to
 * reject the input classes a real booking form should never accept
 * (empty, a recipient list, whitespace/control characters, obvious
 * non-email garbage) while accepting any normal single address. The
 * database enforces the same shape again at the mutation boundary
 * (private.is_public_booking_email_valid) as the authoritative,
 * unbypassable check; this function exists so the browser and the
 * Server Action can reject bad input immediately, without a round trip.
 */
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

export function isValidSingleEmail(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (value.length < 3 || value.length > 254) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  if (value.includes(",") || value.includes(";")) return false;
  return EMAIL_SHAPE.test(value);
}
