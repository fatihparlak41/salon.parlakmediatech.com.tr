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
  // Faz 2G.2B (20260823205200) — reschedule_my_appointment /
  // get_my_reschedule_slots.
  AC006: "Bu salon için online randevu değişikliği kapalı.",
  AC007: "Randevu değişikliği süresi geçti.",
  AC008: "Seçilen saat artık uygun değil.",
  AC009: "Bu işlem artık gerçekleştirilemiyor.",
  // Faz 2G.3.1 (20260824120000) — claim_my_recent_booking. One generic
  // code for every rejection reason (missing/wrong/expired/consumed
  // secret, email mismatch, already linked to someone else) — matches
  // that function's own single errcode for all of them, no enumeration
  // signal between "this claim never existed" and "this claim was
  // valid but something about it failed".
  AC010: "Bu randevu hesabınıza eklenemedi. Bağlantı süresi dolmuş veya geçersiz olabilir.",
  // Faz 2G.3.2 (20260824170000) — get_my_link_salon_context /
  // create_my_link_code. One generic code for "no such tenant" and "bad
  // code input" — no reason to distinguish them for the customer.
  AC011: "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.",
};

const DEFAULT_MESSAGE = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

export function mapAccountErrorCode(code: string | undefined | null): string {
  if (code && code in ACCOUNT_ERROR_MESSAGES) {
    return ACCOUNT_ERROR_MESSAGES[code]!;
  }
  return DEFAULT_MESSAGE;
}
