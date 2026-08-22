/**
 * Stable BK0nn SQLSTATE codes raised by private.create_guest_booking
 * (20260822150500) -> customer-safe Turkish messages. A separate
 * taxonomy from AP0nn (lib/modules/appointments/error-codes.ts): AP0nn
 * is an operator-facing vocabulary (assumes a staff member who
 * understands "branch", "service branch assignment", etc.) and must
 * never reach a customer directly — create_guest_booking translates the
 * internal AP0nn failures it catches from validate_and_insert_appointment_item
 * into this smaller, generic-on-purpose set before they ever leave the
 * database. Never string-match raw error text.
 */
export const PUBLIC_BOOKING_ERROR_MESSAGES: Record<string, string> = {
  BK001: "Online randevu şu anda kullanılamıyor.",
  BK002: "Geçersiz şube.",
  BK003: "Geçersiz hizmet.",
  BK004: "Seçilen personel şu anda uygun değil.",
  BK005: "Bu saat artık müsait değil. Lütfen başka bir saat seçin.",
  BK006: "Lütfen ad soyad ve telefon bilgilerinizi kontrol edin.",
  BK007: "Bu randevu zaten oluşturulmuş.",
};

const DEFAULT_MESSAGE = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

/** error.code from a Supabase/PostgREST response for any public booking
 * RPC call. Never surfaces the raw DB message, a SQLSTATE the customer
 * wouldn't recognize, or anything AP0nn-flavored. */
export function mapPublicBookingErrorCode(code: string | undefined | null): string {
  if (code && code in PUBLIC_BOOKING_ERROR_MESSAGES) {
    return PUBLIC_BOOKING_ERROR_MESSAGES[code]!;
  }
  return DEFAULT_MESSAGE;
}
