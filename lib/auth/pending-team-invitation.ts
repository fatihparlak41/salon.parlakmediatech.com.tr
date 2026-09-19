import "server-only";
import { cookies } from "next/headers";
import {
  PENDING_TEAM_INVITATION_COOKIE,
  isValidTeamInvitationTokenShape,
  pendingTeamInvitationCookieOptions,
} from "@/lib/auth/team-invitation-token";

/**
 * Faz SAAS.1D.2 — server-side reader/clearer for the invitation token
 * parked by proxy.ts's captureTeamInvitationToken (see
 * lib/auth/team-invitation-token.ts for the security model).
 *
 * The raw token has exactly one legitimate consumer: the accept Server
 * Action (lib/modules/team/accept-actions.ts), which forwards it to
 * accept_team_invitation. Everything that merely needs to know WHETHER an
 * invitation is pending — the accept page deciding which state to render —
 * uses hasPendingTeamInvitation(), which never returns the token, so it
 * can't end up in a Server Component's props or rendered markup.
 *
 * Re-validates the shape on every read: a cookie is client-supplied data
 * on every request after it's set, not just at the moment we set it.
 */

async function readRawCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(PENDING_TEAM_INVITATION_COOKIE)?.value;
  return isValidTeamInvitationTokenShape(value) ? value : null;
}

/** Boolean only — safe for Server Components that render the page. */
export async function hasPendingTeamInvitation(): Promise<boolean> {
  return (await readRawCookie()) !== null;
}

/** For the accept Server Action ONLY. Never pass the result to a Client
 * Component prop, a redirect URL, a log line, or an ActionResult. */
export async function getPendingTeamInvitationToken(): Promise<string | null> {
  return readRawCookie();
}

/** A cookie is deleted by re-setting it with Max-Age=0 and the SAME
 * attributes (path especially) it was created with — reusing the one
 * options function guarantees they can't drift apart. */
export async function clearPendingTeamInvitation(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(PENDING_TEAM_INVITATION_COOKIE, "", {
    ...pendingTeamInvitationCookieOptions(),
    maxAge: 0,
  });
}
