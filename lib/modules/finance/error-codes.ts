/**
 * Maps the stable FN0nn SQLSTATE codes (20260929120000) to operator-facing
 * Turkish messages. Same convention as APPOINTMENT_ERROR_MESSAGES — never
 * string-match the raw English exception text, which is not a stable
 * contract.
 */
import { enforcementMessage } from "@/lib/modules/billing/enforcement-errors";
export const FINANCE_ERROR_MESSAGES: Record<string, string> = {
  FN001: "Oturumunuz sona ermiş, lütfen tekrar giriş yapın.",
  FN002: "Bu işlem için yetkiniz yok.",
  FN003: "Randevu veya işlem bulunamadı.",
  FN004: "Geçersiz tutar, fiyat veya indirim.",
  FN005: "Ödeme, kalan tutarı aşamaz.",
  FN006: "Geçersiz ödeme yöntemi.",
  FN007: "Bu işlem az önce farklı bilgilerle zaten kaydedildi.",
  FN008: "Bu işlem iptal edilmiş, değiştirilemez.",
  FN009: "Ödeme bulunamadı.",
  FN010: "Randevu tamamlanmadan tahsilat oluşturulamaz.",
};

const DEFAULT_MESSAGE = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

/** error.code from a Supabase/PostgREST response for any finance RPC call. */
export function mapFinanceErrorCode(code: string | undefined | null): string {
  const enforcement = enforcementMessage(code); // BL001-BL004 (SAAS.1C.2c-A2): never raised at stage 0 / 1
  if (enforcement) return enforcement;
  if (code && code in FINANCE_ERROR_MESSAGES) {
    return FINANCE_ERROR_MESSAGES[code]!;
  }
  return DEFAULT_MESSAGE;
}
