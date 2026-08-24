import "server-only";
import { cookies } from "next/headers";

/**
 * Faz 2G.3.1A — carries a booking-browser claim secret (proof A) from
 * the guest-booking Server Action to the later claim-completion Server
 * Action, keyed by claim_ref (booking_account_claims.id — a non-secret
 * locator, never authority on its own) so ONE browser can hold MULTIPLE
 * independently-pending claims without one overwriting another. Faz
 * 2G.3.1's original design used a single fixed cookie name, which meant
 * a second opted-in booking silently clobbered the first's cookie —
 * pressing the claim button after clicking the FIRST booking's email
 * would complete the SECOND claim instead, with no error. See the
 * 2G.3.1A report for the reproduction.
 *
 * HttpOnly so client JS (and thus XSS) can't read it; Secure outside
 * dev since localhost already accepts Secure cookies over plain HTTP in
 * every browser that matters (the same exception
 * lib/auth/pending-confirmation.ts relies on). TTL matches
 * booking_account_claims.expires_at (24h).
 *
 * claimRef is validated as a well-formed uuid before ever being used to
 * build a cookie name or forwarded to the database — it arrives from a
 * client-controlled route segment/form field, and while it carries no
 * authority by itself, a malformed value must never be allowed to
 * shape a cookie name or reach a ::uuid-cast SQL parameter unchecked.
 */

const COOKIE_PREFIX = "sb-booking-claim-";
const TTL_SECONDS = 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidClaimRef(claimRef: string): boolean {
  return UUID_RE.test(claimRef);
}

function cookieName(claimRef: string): string {
  return `${COOKIE_PREFIX}${claimRef}`;
}

export async function setBookingClaimSecretCookie(claimRef: string, rawSecret: string): Promise<void> {
  if (!isValidClaimRef(claimRef)) return;
  const cookieStore = await cookies();
  cookieStore.set(cookieName(claimRef), rawSecret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TTL_SECONDS,
    path: "/",
  });
}

export async function getBookingClaimSecretCookie(claimRef: string): Promise<string | null> {
  if (!isValidClaimRef(claimRef)) return null;
  const cookieStore = await cookies();
  return cookieStore.get(cookieName(claimRef))?.value ?? null;
}

export async function clearBookingClaimSecretCookie(claimRef: string): Promise<void> {
  if (!isValidClaimRef(claimRef)) return;
  const cookieStore = await cookies();
  cookieStore.delete(cookieName(claimRef));
}
