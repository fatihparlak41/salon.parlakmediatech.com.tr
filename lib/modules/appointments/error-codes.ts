/**
 * Maps the stable AP0nn SQLSTATE codes (20260822090000) to operator-facing
 * Turkish messages. One taxonomy for both the authoritative write-path
 * RPCs (create_appointment/reschedule_appointment/update_appointment_status)
 * and the advisory check_appointment_availability read path
 * (20260822091500) — never string-match the raw English exception text,
 * which is not a stable contract and can't safely distinguish the
 * interpolated-name variants (e.g. two different "staff not eligible"
 * messages naming different people).
 */
export const APPOINTMENT_ERROR_MESSAGES: Record<string, string> = {
  AP001: "Oturumunuz sona ermiş, lütfen tekrar giriş yapın.",
  AP002: "Bu işlem için yetkiniz yok.",
  AP003: "Şube bulunamadı.",
  AP004: "Müşteri bulunamadı.",
  AP005: "En az bir hizmet eklemelisiniz.",
  AP006: "Hizmet bulunamadı veya pasif.",
  AP007: "Bu hizmet seçilen şubede sunulmuyor.",
  AP008: "Personel bulunamadı veya pasif.",
  AP009: "Bu personel seçilen şubede çalışmıyor.",
  AP010: "Bu personel bu hizmeti gerçekleştiremiyor.",
  AP011: "Personel bu saatte müsait değil (çalışma saatleri dışında veya izinli).",
  AP012: "Bu personel tam o saatte başka bir randevu için az önce dolduruldu.",
  AP013: "Randevu bulunamadı.",
  AP014: "Bu randevu tamamlanmış veya iptal edilmiş, değiştirilemez.",
  AP015: "Geçersiz durum.",
};

const DEFAULT_MESSAGE = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

/** error.code from a Supabase/PostgREST response for any appointment RPC
 * call — create_appointment, reschedule_appointment,
 * update_appointment_status, or check_appointment_availability's own
 * permission-denied raise. Never surfaces the raw DB message. */
export function mapAppointmentErrorCode(code: string | undefined | null): string {
  if (code && code in APPOINTMENT_ERROR_MESSAGES) {
    return APPOINTMENT_ERROR_MESSAGES[code]!;
  }
  return DEFAULT_MESSAGE;
}
