/**
 * Faz SAAS.1C.2c-A2 - the stable error contract of the billing ENFORCEMENT guard (private.billing_guard / the guard triggers).
 *
 * The database refuses with one of four SQLSTATEs and a fixed message token; the application maps them to customer-safe Turkish copy and never
 * shows raw database text. At stage 0 (and at stage 1, which never refuses) none of these codes is ever raised, so nothing in the product changes.
 *
 *   BL001  subscription_read_only        commercial lapse: new business growth is refused (existing work keeps running)
 *   BL002  tenant_blocked                platform lifecycle (suspended / canceled / deleted): the workspace is locked
 *   BL003  public_booking_unavailable    a NEW public booking is refused (the public page shows the calm closed message)
 *   BL004  enforcement_guard_error       the guard itself failed for a growth action (fails closed at stages >= 2; stage 1 fails open)
 *
 * Copy follows the accepted banner model: no amounts, no dates, no technical text; the Owner-facing detail lives on "Plan ve kullanım".
 */
export type EnforcementErrorKind = "subscription_read_only" | "tenant_blocked" | "public_booking_unavailable" | "enforcement_guard_error";

export const ENFORCEMENT_SQLSTATE_KINDS: Readonly<Record<string, EnforcementErrorKind>> = Object.freeze({
  BL001: "subscription_read_only",
  BL002: "tenant_blocked",
  BL003: "public_booking_unavailable",
  BL004: "enforcement_guard_error",
});

export const ENFORCEMENT_MESSAGES_TR: Readonly<Record<EnforcementErrorKind, string>> = Object.freeze({
  subscription_read_only: "Bu işlem şu an yapılamıyor. Salon sahibine bildirin.",
  tenant_blocked: "Bu işlem şu an yapılamıyor. Salon sahibine bildirin.",
  public_booking_unavailable: "Online randevu şu anda kullanılamıyor.",
  enforcement_guard_error: "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.",
});

/** the kind of a SQLSTATE raised by the enforcement guard, or null for any other code (never matches by message text) */
export function mapEnforcementError(code: string | undefined | null): EnforcementErrorKind | null {
  if (!code || !Object.prototype.hasOwnProperty.call(ENFORCEMENT_SQLSTATE_KINDS, code)) return null;
  return ENFORCEMENT_SQLSTATE_KINDS[code]!;
}

/** customer-safe copy for an enforcement SQLSTATE, or null when the code is not an enforcement code (the caller's own mapping then applies) */
export function enforcementMessage(code: string | undefined | null): string | null {
  const kind = mapEnforcementError(code);
  return kind ? ENFORCEMENT_MESSAGES_TR[kind] : null;
}
