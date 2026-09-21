import { fail, type ActionResult } from "@/lib/errors";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Faz SAAS.1C.2B/2C/1D.1 — pure, synchronous helpers for the team
 * invitation actions. Deliberately NOT in actions.ts: that file has a
 * file-level "use server" directive, which requires every export to be
 * an async function. These are plain functions kept here so actions.ts
 * can import (not re-export) them, and so tests can exercise them
 * directly without touching the Server Action machinery at all.
 */

/** Exact live RPC error messages (private.create_team_invitation,
 * 20260917080000; authority rule per 20260921083417) — re-read from the
 * deployed DEV function body for this phase, not recalled from memory. */
export function mapCreateInvitationError(error: { message: string }): ActionResult<never> {
  const msg = error.message;
  if (msg.includes("authentication required")) {
    return fail("UNAUTHENTICATED", "Oturum açmanız gerekiyor");
  }
  if (msg.includes("staff.manage required")) {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  if (msg.includes("cannot invite into a role with permissions you do not hold")) {
    return fail("UNAUTHORIZED", "Sahip olmadığınız izinleri içeren bir role davet gönderemezsiniz");
  }
  // Faz SAAS.1E.0 part 2 — the invited role's permissions equal the caller's
  // own (a peer): only an unrestricted caller may invite into it.
  if (msg.includes("insufficient_authority")) {
    return fail("UNAUTHORIZED", "Kendi yetki seviyenize eşit veya daha yüksek bir role davet gönderemezsiniz");
  }
  if (msg.includes("role not found in this tenant")) {
    return fail("VALIDATION", "Geçersiz rol");
  }
  if (msg.includes("staff member not found in this tenant")) {
    return fail("VALIDATION", "Geçersiz personel");
  }
  if (msg.includes("invalid_email")) {
    return fail("VALIDATION", "Geçersiz e-posta adresi");
  }
  if (msg.includes("pending_invitation_exists")) {
    return fail("CONFLICT", "Bu e-posta için zaten bekleyen bir davet var");
  }
  if (msg.includes("already_member")) {
    return fail("CONFLICT", "Bu kişi zaten ekibin bir üyesi");
  }
  if (msg.includes("membership_suspended")) {
    return fail("CONFLICT", "Bu kişinin üyeliği askıya alınmış");
  }
  return fail("UNEXPECTED", "Davet oluşturulamadı, lütfen tekrar deneyin");
}

/** Exact live RPC error messages — private.resend_team_invitation AND
 * private.list_team_invitations (Faz SAAS.1C.2C, 20260918070000; the
 * prelookup call below can only ever raise the shared
 * "staff.manage required" case). Note: an already-expired-but-still-
 * pending invitation is NOT an error from resend_team_invitation — it
 * returns a normal {status:"expired", token:null} row instead, handled
 * separately, not here. invitation_changed is new this phase: the
 * caller's observed expires_at no longer matches the row's current
 * value — someone else (most likely a concurrent resend) already
 * mutated it first. */
export function mapResendInvitationError(error: { message: string }): ActionResult<never> {
  const msg = error.message;
  if (msg.includes("invitation_not_found")) {
    return fail("NOT_FOUND", "Davet bulunamadı");
  }
  if (msg.includes("staff.manage required")) {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  if (msg.includes("cannot resend an invitation into a role with permissions you do not hold")) {
    return fail("UNAUTHORIZED", "Sahip olmadığınız izinleri içeren bir role daveti yeniden gönderemezsiniz");
  }
  // Faz SAAS.1E.0 part 2 — equal authority (a peer role) is refused too.
  if (msg.includes("insufficient_authority")) {
    return fail("UNAUTHORIZED", "Kendi yetki seviyenize eşit veya daha yüksek bir role ait daveti yeniden gönderemezsiniz");
  }
  // The invited role has been deleted since: the link could never be accepted.
  if (msg.includes("role_not_found")) {
    return fail("CONFLICT", "Bu davetin rolü artık mevcut değil");
  }
  if (msg.includes("invitation_not_pending")) {
    return fail("CONFLICT", "Bu davet artık beklemede değil");
  }
  if (msg.includes("invitation_changed")) {
    return fail("CONFLICT", "Davet başka bir işlem tarafından güncellendi. Lütfen tekrar deneyin.");
  }
  return fail("UNEXPECTED", "Davet yeniden gönderilemedi, lütfen tekrar deneyin");
}

/** Exact live RPC error messages — private.revoke_team_invitation
 * (20260917080000). Note: an already-expired-but-still-pending invitation
 * is NOT an error here either — the RPC transitions it to expired and
 * returns a normal {status:"expired"} row instead of revoking it, same
 * shape as resend_team_invitation's own expiry handling. */
export function mapRevokeInvitationError(error: { message: string }): ActionResult<never> {
  const msg = error.message;
  if (msg.includes("invitation_not_found")) {
    return fail("NOT_FOUND", "Davet bulunamadı");
  }
  if (msg.includes("staff.manage required")) {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  if (msg.includes("cannot revoke an invitation into a role with permissions you do not hold")) {
    return fail("UNAUTHORIZED", "Sahip olmadığınız izinleri içeren bir davetin iptalini gerçekleştiremezsiniz");
  }
  // Faz SAAS.1E.0 part 2 — equal authority (a peer role) is refused too.
  if (msg.includes("insufficient_authority")) {
    return fail("UNAUTHORIZED", "Kendi yetki seviyenize eşit veya daha yüksek bir role ait daveti iptal edemezsiniz");
  }
  if (msg.includes("invitation_not_pending")) {
    return fail("CONFLICT", "Bu davet artık beklemede değil");
  }
  return fail("UNEXPECTED", "Davet iptal edilemedi, lütfen tekrar deneyin");
}

export function buildAcceptUrl(rawToken: string): string {
  return `${getSiteUrl()}/accept-invite?token=${encodeURIComponent(rawToken)}`;
}
