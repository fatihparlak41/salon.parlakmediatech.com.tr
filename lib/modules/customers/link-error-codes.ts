/**
 * Stable LK0nn SQLSTATE codes raised by the salon-assisted account
 * linking RPCs (20260824170000) -> staff-safe Turkish messages. A
 * separate taxonomy from AC0nn (customer-portal) and BK0nn (public
 * booking): this is the first staff-permission-gated surface this
 * feature area has needed, and its audience/error semantics genuinely
 * differ — LK002 is deliberately its own distinct message (the caller
 * here is an authenticated, tenant-scoped, fully-audited staff
 * identity, not an anonymous prober, so a clear "you don't have
 * permission" is normal, expected UI, not an enumeration leak) while
 * every code-validity reason (wrong tenant, expired, wrong code,
 * already consumed, already linked elsewhere) collapses into the
 * single generic LK003, matching the RPC's own one errcode for all of
 * them.
 */
export const LINK_ERROR_MESSAGES: Record<string, string> = {
  LK001: "Bu işlem için giriş yapmanız gerekiyor.",
  LK002: "Bu işlem için yetkiniz yok.",
  LK003: "Kod geçersiz. Kodun süresi dolmuş, yanlış girilmiş veya bu salona ait olmayabilir.",
  LK004: "Bu kayıt için hesap bağlantısı kaldırılamıyor.",
};

const DEFAULT_MESSAGE = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

export function mapLinkErrorCode(code: string | undefined | null): string {
  if (code && code in LINK_ERROR_MESSAGES) {
    return LINK_ERROR_MESSAGES[code]!;
  }
  return DEFAULT_MESSAGE;
}
