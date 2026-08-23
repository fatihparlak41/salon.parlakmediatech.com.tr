/**
 * Stable AC0nn SQLSTATE codes raised by the customer-portal RPCs
 * (20260822190000) -> customer-safe Turkish messages. Mirrors
 * lib/modules/public-booking/error-codes.ts's BK0nn pattern — a separate
 * taxonomy so a portal failure never gets translated through the
 * booking-domain's message set by accident.
 */
export const ACCOUNT_ERROR_MESSAGES: Record<string, string> = {
  AC001: "Bu işlem için giriş yapmanız gerekiyor.",
  AC002: "Lütfen ad soyad bilgisini kontrol edin.",
  // Faz 2G.2A (20260823201517) — cancel_my_appointment. AC003 is
  // deliberately one generic message for every "not manageable" reason
  // (doesn't exist / not owned / wrong status) — no existence side
  // channel, matching the DB function's own single errcode for all three.
  AC003: "Bu randevu şu anda yönetilemiyor.",
  AC004: "Bu salon için online iptal kapalı.",
  AC005: "İptal süresi geçti.",
};

const DEFAULT_MESSAGE = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

export function mapAccountErrorCode(code: string | undefined | null): string {
  if (code && code in ACCOUNT_ERROR_MESSAGES) {
    return ACCOUNT_ERROR_MESSAGES[code]!;
  }
  return DEFAULT_MESSAGE;
}
