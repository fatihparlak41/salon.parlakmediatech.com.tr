import { fail, type ActionResult, type AppErrorCode } from "@/lib/errors";

/**
 * Faz FIN.1C.1 — the personnel ledger's OWN operator-facing messages for the FN0nn SQLSTATE codes raised by the staff-finance
 * RPCs (20261007120100). FN001, FN002, FN004, FN006, FN007 and FN013 keep the meanings FIN.1A and FIN.1B.1 gave them, but the
 * text is written for this module and never borrowed from lib/modules/finance or lib/modules/expenses (their wording is about
 * sales and expenses): this file imports neither. Never string-match the raw English exception text: only the code is a
 * stable contract.
 *
 * FN003, FN005, FN008-FN012 belong to the expense module and deliberately have no entry here: they fall through to the
 * default message.
 */
export const STAFF_FINANCE_ERROR_MESSAGES: Record<string, string> = {
  FN001: "Oturum açmanız gerekiyor.",
  FN002: "Bu işlem için yetkiniz yok.",
  FN004: "Girilen bilgiler geçersiz. Alanları kontrol edin.",
  FN006: "Geçersiz ödeme yöntemi.",
  FN007: "Bu işlem daha önce farklı bilgilerle kaydedilmiş. Sayfayı yenileyin.",
  FN013: "Kayıt başka bir işlemle değişti. Yenileyip tekrar deneyin.",
  FN020: "Dönem bulunamadı.",
  FN021: "Kalem bulunamadı.",
  FN022: "Ödeme bulunamadı.",
  FN023: "Kesinleşmiş dönemde ödeme tutarı kalan net tutarı aşamaz.",
  FN024: "Kesinleşmiş dönemde yalnızca düzeltme kalemi ve işveren maliyeti kalemi eklenebilir. Diğer değişiklikler için dönemi yeniden açın.",
  FN025: "İptal edilmiş döneme işlem yapılamaz.",
  FN026: "Bu değişiklik kesintileri hakedişin üzerine çıkarır veya kesinleşmiş dönemin net tutarını ödemelerin altına düşürür.",
  FN027: "Ödeme kaydı bulunduğu için bu işlem yapılamaz. Önce ilgili ödemeleri iptal edin.",
  FN028: "Bu personel için bu ayın dönemi zaten var.",
  FN029: "Personel bulunamadı veya kullanılamıyor.",
  FN030: "Geçersiz kalem türü.",
  FN031: "Kesinleştirmek için en az bir hakediş kalemi gerekir.",
  FN032: "Bu kayıt bu şekilde değiştirilemez.",
  FN033: "Yapılan ödemeler ve avanslar net ödenecek tutarı aşıyor. Kesinleştirmeden önce hakedişi düzeltin veya fazla ödemeyi iptal edin.",
};

export const STAFF_FINANCE_DEFAULT_ERROR_MESSAGE = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

/** error.code from a Supabase/PostgREST response for any staff-finance RPC call. */
export function mapStaffFinanceErrorCode(code: string | undefined | null): string {
  if (code && Object.prototype.hasOwnProperty.call(STAFF_FINANCE_ERROR_MESSAGES, code)) {
    return STAFF_FINANCE_ERROR_MESSAGES[code]!;
  }
  return STAFF_FINANCE_DEFAULT_ERROR_MESSAGE;
}

const APP_ERROR_CODES: Record<string, AppErrorCode> = {
  FN001: "UNAUTHENTICATED",
  FN002: "UNAUTHORIZED",
  FN020: "NOT_FOUND",
  FN021: "NOT_FOUND",
  FN022: "NOT_FOUND",
  FN004: "VALIDATION",
  FN006: "VALIDATION",
  FN023: "VALIDATION",
  FN026: "VALIDATION",
  FN029: "VALIDATION",
  FN030: "VALIDATION",
  FN031: "VALIDATION",
  // Finalization refused because payments and advances exceed the net payable: the Owner fixes the statement, so it is a
  // validation problem, not a stale-state conflict.
  FN033: "VALIDATION",
  // The state the user acted on is stale or no longer allows the action: the UI offers a refresh ("Yenile").
  FN007: "CONFLICT",
  FN013: "CONFLICT",
  FN024: "CONFLICT",
  FN025: "CONFLICT",
  FN027: "CONFLICT",
  FN028: "CONFLICT",
  FN032: "CONFLICT",
};

/** The AppErrorCode a Server Action reports for a staff-finance RPC error code (UNEXPECTED for anything unknown). */
export function staffFinanceAppErrorCode(code: string | undefined | null): AppErrorCode {
  if (code && Object.prototype.hasOwnProperty.call(APP_ERROR_CODES, code)) return APP_ERROR_CODES[code]!;
  return "UNEXPECTED";
}

/** The failed ActionResult for a staff-finance RPC error: stable AppErrorCode plus the module's own message. */
export function staffFinanceFailure(error: { code?: string | null } | null | undefined): ActionResult<never> {
  return fail(staffFinanceAppErrorCode(error?.code), mapStaffFinanceErrorCode(error?.code));
}
