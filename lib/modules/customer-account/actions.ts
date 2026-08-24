"use server";

import { revalidatePath } from "next/cache";
import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getSiteUrl } from "@/lib/site-url";
import { authErrorLogFields } from "@/lib/auth/session-errors";
import { getBookingClaimSecretCookie, clearBookingClaimSecretCookie, isValidClaimRef } from "@/lib/auth/booking-claim-cookie";
import type { ActionResult } from "@/lib/errors";
import { fail, ok } from "@/lib/errors";
import { accountMagicLinkSchema, updateAccountProfileSchema } from "./schemas";
import { mapAccountErrorCode } from "./error-codes";
import type { AccountProfile } from "./queries";

/**
 * Requests a magic-link sign-in for the customer portal. Reuses the
 * existing prefetch-safe email-confirmation infrastructure end to end
 * (app/auth/confirm/route.ts -> /confirm-email -> confirmEmailAction) —
 * next=/account is the only new wiring, everything else (token_hash
 * storage, single-use verifyOtp, safe redirect resolution) already
 * existed and already supports type=magiclink (see that route's own
 * KNOWN_EMAIL_OTP_TYPES and header comment).
 *
 * Deliberately the same success response regardless of what actually
 * happened server-side — same enumeration-safety rule as
 * resendConfirmationAction: never reveal whether this email has an
 * account, appears in any tenant's CRM, or has any bookings anywhere.
 * shouldCreateUser: true (the SDK default, stated explicitly here) is
 * what makes this work as both first-time signup AND returning login in
 * one call — a customer never fills out a separate signup form.
 */
export async function requestAccountMagicLinkAction(
  _prevState: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const parsed = accountMagicLinkSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${getSiteUrl()}/auth/confirm?next=/account`,
    },
  });

  if (error) {
    console.error("[requestAccountMagicLinkAction] signInWithOtp failed", authErrorLogFields(error));
  }

  return ok(null);
}

export async function updateMyAccountProfileAction(
  _prevState: ActionResult<AccountProfile> | null,
  formData: FormData,
): Promise<ActionResult<AccountProfile>> {
  const user = await getCurrentUser();
  if (!user) {
    return fail("UNAUTHENTICATED", mapAccountErrorCode("AC001"));
  }

  const parsed = updateAccountProfileSchema.safeParse({
    fullName: formData.get("fullName"),
    phone: formData.get("phone") || undefined,
  });

  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_my_account_profile", {
    p_full_name: parsed.data.fullName,
    p_phone: parsed.data.phone,
  });

  if (error) {
    return fail("UNEXPECTED", mapAccountErrorCode(error.code));
  }

  return ok(data as unknown as AccountProfile);
}

/**
 * Faz 2G.2A — the customer-facing cancellation mutation. Deliberately no
 * tenant/customer id parameter: cancel_my_appointment (20260823201517)
 * derives auth.uid() itself and re-proves ownership through
 * customer_account_links inside the database, under a row lock — this
 * action is a thin, unauthenticated-at-the-TS-layer pass-through by
 * design, since the RPC boundary is what actually enforces everything.
 */
export async function cancelMyAppointmentAction(
  _prevState: ActionResult<{ appointmentId: string; status: string }> | null,
  appointmentId: string,
): Promise<ActionResult<{ appointmentId: string; status: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_my_appointment", {
    p_appointment_id: appointmentId,
  });

  if (error) {
    return fail("UNEXPECTED", mapAccountErrorCode(error.code));
  }

  revalidatePath("/account/appointments");
  revalidatePath("/account");
  return ok(data as unknown as { appointmentId: string; status: string });
}

/**
 * Faz 2G.2B — the customer-facing reschedule mutation. Same shape as
 * cancelMyAppointmentAction: no tenant/customer id, no service/staff/item
 * array — reschedule_my_appointment (20260823205200) derives auth.uid()
 * itself, re-proves ownership, and moves every existing item by one
 * uniform delta server-side. This action only ever passes through the
 * new target start time the customer picked from get_my_reschedule_slots.
 */
export async function rescheduleMyAppointmentAction(
  _prevState: ActionResult<{ appointmentId: string; scheduledStartAt: string }> | null,
  input: { appointmentId: string; newStartAtIso: string },
): Promise<ActionResult<{ appointmentId: string; scheduledStartAt: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reschedule_my_appointment", {
    p_appointment_id: input.appointmentId,
    p_new_start_at: input.newStartAtIso,
  });

  if (error) {
    return fail("UNEXPECTED", mapAccountErrorCode(error.code));
  }

  revalidatePath("/account/appointments");
  revalidatePath("/account");
  return ok(data as unknown as { appointmentId: string; scheduledStartAt: string });
}

/**
 * Faz 2G.3.1 / 2G.3.1A — completes a future-booking verified claim. No
 * customer/tenant/appointment id is accepted as input, from formData or
 * otherwise. Two things ARE accepted from formData: claimRef (a
 * non-secret locator, booking_account_claims.id — see the migration's
 * own header for why it carries no authority by itself) and, indirectly
 * through it, the matching per-claim HttpOnly cookie. The raw secret is
 * hashed here the same way gateway.ts hashed it at issuance (SHA-256)
 * and handed to claim_my_recent_booking alongside the ref as an opaque
 * pair — never the raw secret, never any other id. auth.uid() (proof
 * B's carrier) is read inside that RPC from the real session, not from
 * anything this action passes.
 *
 * claimRef is validated as a well-formed uuid before it's used to build
 * a cookie name or reach the database — a malformed/tampered value is
 * treated identically to "no such claim" (AC010), never a distinct
 * error, so it adds no enumeration signal.
 *
 * The matching cookie is cleared only on success, not on every failure
 * — see booking-claim-cookie.ts's own header. Only THAT ONE claim's
 * cookie is ever touched; every other pending claim's cookie (a
 * different name entirely, keyed by its own ref) is untouched by this
 * call, by construction.
 */
export async function claimMyRecentBookingAction(
  _prevState: ActionResult<{ claimed: boolean }> | null,
  formData: FormData,
): Promise<ActionResult<{ claimed: boolean }>> {
  void _prevState;
  const claimRef = formData.get("claimRef");
  if (typeof claimRef !== "string" || !isValidClaimRef(claimRef)) {
    return fail("VALIDATION", mapAccountErrorCode("AC010"));
  }

  const rawSecret = await getBookingClaimSecretCookie(claimRef);
  if (!rawSecret) {
    return fail("NOT_FOUND", mapAccountErrorCode("AC010"));
  }
  const secretHash = createHash("sha256").update(rawSecret).digest("hex");

  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_my_recent_booking", {
    p_claim_ref: claimRef,
    p_claim_secret_hash: secretHash,
  });

  if (error) {
    return fail("UNEXPECTED", mapAccountErrorCode(error.code));
  }

  await clearBookingClaimSecretCookie(claimRef);
  revalidatePath("/account/appointments");
  revalidatePath("/account");
  return ok({ claimed: true });
}
