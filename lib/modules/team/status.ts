/** Faz SAAS.1D.1 — keyed by list_team_invitations' effective_status, never
 * the raw persisted status: a pending-but-past-expires_at row isn't swept
 * to 'expired' until next touched, so the RPC computes the display-correct
 * value itself (see 20260917080000's own list_team_invitations body). */
export const INVITATION_STATUS_LABELS_TR: Record<string, string> = {
  pending: "Bekliyor",
  accepted: "Kabul edildi",
  expired: "Süresi doldu",
  revoked: "İptal edildi",
};

export const INVITATION_STATUS_BADGE_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  accepted: "default",
  expired: "secondary",
  revoked: "destructive",
};
