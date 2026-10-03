import { fail, type ActionResult, type AppErrorCode } from "@/lib/errors";

/**
 * Faz FIN.1B.1 — the expense module's OWN operator-facing messages for the FN0nn SQLSTATE codes raised by the expense RPCs
 * (20261003090000). The codes keep the meanings FIN.1A gave them where they overlap, but the user-facing text is written for
 * expenses and never borrowed from lib/modules/finance, whose wording is about appointments, sales and collections.
 * Never string-match the raw English exception text: only the code is a stable contract.
 *
 * FN010 ("appointment not completed") is FIN.1A-only and deliberately has no entry: it falls through to the default message.
 */
export const EXPENSE_ERROR_MESSAGES: Record<string, string> = {
  FN001: "Oturumunuz sona ermiş, lütfen tekrar giriş yapın.",
  FN002: "Giderler için bu işlemi yapma yetkiniz yok.",
  FN003: "Gider kaydı bulunamadı.",
  FN004:
    "Girdiğiniz bilgiler geçersiz. Tutar, tarih ve zorunlu alanları kontrol edin.",
  FN005: "Ödeme tutarı giderin kalan tutarını aşamaz.",
  FN006: "Geçersiz ödeme yöntemi.",
  FN007:
    "Bu işlem az önce farklı bilgilerle zaten kaydedildi. Sayfayı yenileyip tekrar deneyin.",
  FN008: "İptal edilmiş gider değiştirilemez.",
  FN009: "Ödeme kaydı bulunamadı.",
  FN011: "Ödemesi bulunan gider iptal edilemez. Önce ödemeleri iptal edin.",
  FN012:
    "Ödeme yapılmış giderin tarihi, şubesi ve kategorisi değiştirilemez; tutar da ödenen toplamın altına düşürülemez. Gerekirse önce ödemeleri iptal edin.",
  FN013: "Gider başka bir işlemle değişti. Sayfayı yenileyip tekrar deneyin.",
};

export const EXPENSE_DEFAULT_ERROR_MESSAGE =
  "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

/** error.code from a Supabase/PostgREST response for any expense RPC call. */
export function mapExpenseErrorCode(code: string | undefined | null): string {
  if (
    code &&
    Object.prototype.hasOwnProperty.call(EXPENSE_ERROR_MESSAGES, code)
  ) {
    return EXPENSE_ERROR_MESSAGES[code]!;
  }
  return EXPENSE_DEFAULT_ERROR_MESSAGE;
}

const APP_ERROR_CODES: Record<string, AppErrorCode> = {
  FN001: "UNAUTHENTICATED",
  FN002: "UNAUTHORIZED",
  FN003: "NOT_FOUND",
  FN009: "NOT_FOUND",
  FN004: "VALIDATION",
  FN005: "VALIDATION",
  FN006: "VALIDATION",
  // The state the user acted on is stale or no longer allows the action: the UI offers a refresh ("Yenile").
  FN007: "CONFLICT",
  FN008: "CONFLICT",
  FN011: "CONFLICT",
  FN012: "CONFLICT",
  FN013: "CONFLICT",
};

/** The AppErrorCode a Server Action reports for an expense RPC error code (UNEXPECTED for anything unknown). */
export function expenseAppErrorCode(
  code: string | undefined | null,
): AppErrorCode {
  if (code && Object.prototype.hasOwnProperty.call(APP_ERROR_CODES, code))
    return APP_ERROR_CODES[code]!;
  return "UNEXPECTED";
}

/** The failed ActionResult for an expense RPC error: stable AppErrorCode plus the expense message. */
export function expenseFailure(
  error: { code?: string | null } | null | undefined,
): ActionResult<never> {
  return fail(
    expenseAppErrorCode(error?.code),
    mapExpenseErrorCode(error?.code),
  );
}
