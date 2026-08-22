"use server";

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
 */
export async function submitGuestBookingAction(input: GuestBookingGatewayInput): Promise<GatewayResult> {
  return processGuestBooking(input);
}
