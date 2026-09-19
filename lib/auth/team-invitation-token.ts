import { NextResponse, type NextRequest } from "next/server";

/**
 * Faz SAAS.1D.2 — pure (no server-only, no next/headers) pieces of the
 * team-invitation token capture, shared by proxy.ts (which must run
 * before any page renders, and can't use next/headers' cookies()) and
 * lib/auth/pending-team-invitation.ts (the server-only cookie reader used
 * by the accept page/action).
 *
 * Deliberately the same shape as the prefetch-safe email confirmation
 * flow (lib/auth/pending-confirmation.ts + app/auth/confirm/route.ts): a
 * GET carrying a single-use credential in its query string must never
 * consume it — an email/link scanner (Google Workspace's Safe Browsing
 * prefetch is the real, observed case) fetches every link before the
 * human does. The GET therefore only parks the raw token in an HttpOnly
 * cookie and redirects to a token-free URL; the actual acceptance happens
 * later, on an explicit authenticated POST (lib/modules/team/
 * accept-actions.ts), which reads the token back from the cookie so it
 * never touches client JS or React props.
 */

export const PENDING_TEAM_INVITATION_COOKIE = "sb-pending-team-invitation";

/** The one URL that carries the email CTA and hosts the accept page. */
export const TEAM_INVITATION_ROUTE_PATH = "/accept-invite";

/**
 * Cookie path is "/", NOT the narrower /accept-invite it was first
 * built with — found by manual browser smoke, not by any unit test: when
 * a Server Action ends in redirect(), Next.js renders the destination
 * page INSIDE that same POST, using that POST's request cookies. Login's
 * POST goes to /login (and email confirmation's to /confirm-email), and a
 * browser never sends a Path=/accept-invite cookie on a request to a
 * different path — so right after signing in, /accept-invite rendered its
 * "no pending invitation" state even though the cookie existed. "/" is
 * the narrowest path that includes every request in the login →
 * accept and signup → confirm → accept journeys, and matches the two
 * other secret cookies in this codebase (pending-confirmation,
 * booking-claim). The exposure this widens is small by design: HttpOnly,
 * a 1-hour life, and a token that is useless without an authenticated
 * user whose email matches the invitation.
 */
export const PENDING_TEAM_INVITATION_COOKIE_PATH = "/";

/** Bridges "click email link" -> (optional signup + email confirmation)
 * -> "click Daveti Kabul Et". Deliberately far shorter than the
 * invitation's own 7-day expiry: a token sitting in a browser cookie
 * should be short-lived, and the recovery for a lapsed cookie is cheap
 * and safe — re-click the same invitation email link. */
export const PENDING_TEAM_INVITATION_TTL_SECONDS = 60 * 60;

/** create_team_invitation/resend_team_invitation generate
 * encode(gen_random_bytes(32), 'hex'): exactly 64 lowercase hex chars.
 * Input hygiene only — the database's hash lookup stays the sole
 * authority on whether a token is real. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

export function isValidTeamInvitationTokenShape(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

export function pendingTeamInvitationCookieOptions() {
  return {
    httpOnly: true,
    // Same convention as lib/auth/booking-claim-cookie.ts: localhost
    // already accepts Secure cookies over plain HTTP in every browser
    // that matters, but a non-localhost dev host (e.g. a LAN address)
    // doesn't, so this stays off outside production.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: PENDING_TEAM_INVITATION_TTL_SECONDS,
    path: PENDING_TEAM_INVITATION_COOKIE_PATH,
  };
}

/** Whether a request carries the pending-invitation cookie at all (the
 * value is not read). For proxy.ts's continuity diagnostics, which must not
 * reference the cookie name themselves: this module owns it. */
export function requestHasPendingTeamInvitationCookie(request: { cookies: { has(name: string): boolean } }): boolean {
  return request.cookies.has(PENDING_TEAM_INVITATION_COOKIE);
}

/**
 * Called first thing in proxy.ts. Returns a redirect response ONLY for
 * `GET /accept-invite?token=...` (any value, including malformed ones —
 * a token-bearing URL is never rendered as a page); returns null for
 * everything else so the normal request pipeline continues untouched.
 *
 * Never calls accept_team_invitation, never reads or writes the database,
 * never changes auth state. A well-formed token is stored in the
 * HttpOnly cookie; a malformed one is simply dropped (the token-free
 * page then shows its generic "no pending invitation" state). Either way
 * the browser is redirected to /accept-invite with the query string
 * stripped, so the raw token never survives in the address bar, browser
 * history, or a Referer header sent by anything the page later loads.
 */
export function captureTeamInvitationToken(request: NextRequest): NextResponse | null {
  if (request.method !== "GET") return null;
  if (request.nextUrl.pathname !== TEAM_INVITATION_ROUTE_PATH) return null;

  const token = request.nextUrl.searchParams.get("token");
  if (token === null) return null;

  const destination = request.nextUrl.clone();
  destination.search = "";
  const response = NextResponse.redirect(destination);

  if (isValidTeamInvitationTokenShape(token)) {
    response.cookies.set(PENDING_TEAM_INVITATION_COOKIE, token, pendingTeamInvitationCookieOptions());
  }
  // A response that both carries Set-Cookie and redirects must never be
  // served from a shared cache to someone else.
  response.headers.set("Cache-Control", "no-store");

  return response;
}
