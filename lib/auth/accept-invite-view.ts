/**
 * SAAS.1D — which of its three states /accept-invite renders. Pulled out of
 * the page so the decision is a tested pure function and the (presence-only)
 * continuity diagnostics report exactly the state the visitor sees.
 *
 *  no-pending    no valid parked invitation  -> "Davet bağlantısı bulunamadı"
 *  continuation  invitation parked, signed out -> Giriş Yap / Hesap Oluştur
 *  accept-panel  invitation parked, signed in  -> explicit "Daveti Kabul Et"
 *
 * Nothing here reads the token, an invitation or the database.
 */
export type AcceptInviteView = "no-pending" | "continuation" | "accept-panel";

export function resolveAcceptInviteView(input: {
  hasPendingInvitation: boolean;
  authenticated: boolean;
}): AcceptInviteView {
  if (!input.hasPendingInvitation) return "no-pending";
  return input.authenticated ? "accept-panel" : "continuation";
}
