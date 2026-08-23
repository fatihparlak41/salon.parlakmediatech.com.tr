"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getSiteUrl } from "@/lib/site-url";
import { authErrorLogFields } from "@/lib/auth/session-errors";
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
