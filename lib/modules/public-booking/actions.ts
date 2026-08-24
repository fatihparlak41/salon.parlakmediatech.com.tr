"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getSiteUrl } from "@/lib/site-url";
import { authErrorLogFields } from "@/lib/auth/session-errors";
import { setBookingClaimSecretCookie } from "@/lib/auth/booking-claim-cookie";
import { processGuestBooking, type GatewayResult } from "./gateway";
import type { GuestBookingGatewayInput } from "./schemas";

/**
 * The one authoritative mutation path for public guest booking (Phase
 * 2F.2). Server Action, not a Route Handler: the only caller is
 * BookingWizard, a client component in this same app — every other
 * mutation in this codebase (appointments, customers, staff, services)
 * already uses this exact pattern, and there's no external caller, no
 * webhook, no non-Next.js client that would call for a Route Handler's
 * stable REST-shaped URL instead. Keeps this consistent with the rest
 * of the project rather than introducing a second mutation style.
 *
 * No test seam here on purpose — this is the real path the browser
 * calls, always with the real Turnstile verifier and the real
 * booking_gateway DB connection. Tests exercise the logic through
 * processGuestBooking directly (see gateway.ts's own comment).
 *
 * anon/authenticated no longer have EXECUTE on create_guest_booking at
 * all (20260822170000) — this Server Action, running server-side with
 * the booking_gateway role's own credentials, is the only remaining path
 * to it. A request that never reaches this action (a raw RPC call
 * against Supabase directly) gets a permission-denied error at the
 * database, not a missing feature.
 *
 * Faz 2G.1: the optional authenticated-customer link is derived HERE,
 * server-side, from the actual session cookie — never accepted as a
 * field on `input`. BookingWizard has no idea this exists and needs no
 * changes: an already-logged-in customer's booking gets linked to their
 * account automatically; a logged-out visitor gets ordinary guest
 * behavior; there is no third code path and no client-supplied identity
 * that could ever widen or spoof it.
 *
 * Faz 2G.3.1: this is also the one place the booking-browser claim
 * cookie is ever written, and the one place the Magic Link proving proof
 * B gets sent — both Next.js-request-scoped side effects that belong
 * here, not in the testable gateway.ts core (same reasoning as the
 * authenticated-link derivation above). result.claimSecret/claimRef are
 * stripped before the return below regardless of outcome: neither may
 * ever cross the server/client boundary into what BookingWizard
 * receives.
 *
 * Faz 2G.3.1A: the cookie is keyed by claimRef (booking_account_claims.id)
 * and the Magic Link's `next` carries that same ref in its path — one
 * browser can hold several independently-pending claims this way,
 * rather than the single global cookie/destination that let a second
 * opted-in booking silently overwrite a first, unclaimed one (see the
 * 2G.3.1A report). claimRef is a plain path segment, never authentication
 * material — completion still requires the matching per-claim secret AND
 * the authenticated email, both checked together in one database lookup
 * (see claim_my_recent_booking's own header).
 */
export async function submitGuestBookingAction(input: GuestBookingGatewayInput): Promise<GatewayResult> {
  const user = await getCurrentUser();
  const result = await processGuestBooking(input, user?.id ?? null);

  if (result.success && result.claimSecret && result.claimRef && input.customerEmail) {
    await setBookingClaimSecretCookie(result.claimRef, result.claimSecret);

    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: input.customerEmail,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${getSiteUrl()}/auth/confirm?next=/account/claim/complete/${result.claimRef}`,
      },
    });
    if (error) {
      console.error("[submitGuestBookingAction] claim signInWithOtp failed", authErrorLogFields(error));
    }
  }

  if (result.success) {
    return { success: true, data: result.data };
  }
  return result;
}
