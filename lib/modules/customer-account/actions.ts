"use server";

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
