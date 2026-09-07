/**
 * Faz 5A.3A — stable RP0nn SQLSTATE codes for the reporting RPC surface,
 * mapped to operator-facing Turkish messages. Deliberately a fresh
 * namespace, not a continuation of lib/modules/appointments/error-codes.ts's
 * AP0nn sequence: these are report-input/authorization errors, not
 * appointment-lifecycle errors, and reusing AP0nn would blur that
 * distinction for no benefit. Never string-match the raw exception text.
 */
export const REPORTS_ERROR_MESSAGES: Record<string, string> = {
  RP001: "Oturumunuz sona ermiş, lütfen tekrar giriş yapın.",
  RP002: "Bu raporu görüntülemek için yetkiniz yok.",
  RP003: "Başlangıç ve bitiş tarihi gereklidir.",
  RP004: "Başlangıç tarihi bitiş tarihinden önce olmalıdır.",
};

const DEFAULT_MESSAGE = "Rapor yüklenemedi, lütfen tekrar deneyin.";

/** error.code from a Supabase/PostgREST response for any reporting RPC
 * call. Never surfaces the raw DB message. */
export function mapReportsErrorCode(code: string | undefined | null): string {
  if (code && code in REPORTS_ERROR_MESSAGES) {
    return REPORTS_ERROR_MESSAGES[code]!;
  }
  return DEFAULT_MESSAGE;
}
