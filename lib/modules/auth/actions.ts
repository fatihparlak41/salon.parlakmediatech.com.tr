"use server";

import { createClient } from "@/lib/supabase/server";
// Plain next/navigation — see lib/auth/session.ts for why server-side
// redirects don't use lib/i18n/navigation's locale-aware version.
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/errors";
import { fail } from "@/lib/errors";
import {
  clearPendingConfirmation,
  getPendingConfirmation,
} from "@/lib/auth/pending-confirmation";
import { authErrorLogFields } from "@/lib/auth/session-errors";
import { resendConfirmationSchema, signInSchema, signUpSchema } from "./schemas";

// NEXT_PUBLIC_SITE_URL wins once set (the real custom domain, once
// attached). Until then, Vercel's own VERCEL_URL — auto-populated per
// deployment, including a unique one per Preview build — resolves this
// correctly with no per-deployment config. Bare localhost fallback is
// for `pnpm dev` only.
function getSiteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}

export async function signInAction(
  _prevState: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz form",
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return fail("UNAUTHENTICATED", "E-posta veya şifre hatalı");
  }

  redirect("/");
}

export async function signUpAction(
  _prevState: ActionResult<{ email: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ email: string }>> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz form",
    );
  }

  const supabase = await createClient();

  // Not `/auth/callback` — the confirmation email template builds its own
  // link to /auth/confirm (prefetch-safe token_hash flow, see that
  // route's comment). This value only supplies Supabase's
  // `{{ .RedirectTo }}` template variable, i.e. where confirmEmailAction
  // sends the user after a successful verifyOtp() — also checked
  // server-side against the project's Redirect URL allowlist.
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: getSiteUrl(),
    },
  });

  if (error) {
    if (error.code === "user_already_exists") {
      return fail("CONFLICT", "Bu e-posta adresiyle zaten bir hesap var");
    }
    // Safe diagnostic fields only — code/status are fixed enum-like
    // values from the SDK, never user input. error.message is skipped:
    // some Supabase error types (e.g. email_address_invalid) embed the
    // submitted email in the message text.
    console.error("[signUpAction] supabase.auth.signUp failed", {
      code: error.code,
      status: error.status,
    });
    return fail("UNEXPECTED", "Kayıt oluşturulamadı, lütfen tekrar deneyin");
  }

  return { success: true, data: { email: parsed.data.email } };
}

/**
 * The only place verifyOtp() is ever called — deliberately reachable
 * only via an explicit POST from the button on /confirm-email, never
 * from the GET in app/auth/confirm/route.ts. Takes no input from
 * formData; the token_hash/type come from the HttpOnly cookie that GET
 * set, so an attacker submitting arbitrary form data can't influence
 * which token gets verified.
 */
export async function confirmEmailAction(): Promise<void> {
  const pending = await getPendingConfirmation();

  if (!pending) {
    // Nothing to verify (cookie missing/expired/already consumed) —
    // land back on /confirm-email, which renders the "expired" state
    // for exactly this case. No verifyOtp() call, nothing to log.
    redirect("/confirm-email");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    type: pending.type,
    token_hash: pending.tokenHash,
  });

  // Single-use regardless of outcome — a failed attempt must not leave
  // a reusable cookie sitting around either.
  await clearPendingConfirmation();

  if (error) {
    // Safe diagnostic fields only — never the token_hash itself
    // (single-use credential).
    console.error("[confirmEmailAction] verifyOtp failed", authErrorLogFields(error));
    redirect("/confirm-email");
  }

  redirect(pending.next);
}

export async function resendConfirmationAction(
  _prevState: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const parsed = resendConfirmationSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçerli bir e-posta adresi girin",
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: parsed.data.email,
    options: { emailRedirectTo: getSiteUrl() },
  });

  // Deliberately the same success response regardless of what actually
  // happened server-side (unknown email, already confirmed, rate
  // limited) — enumeration-safe by construction, not by hoping every
  // Supabase error code stays silent forever. Rate limiting itself is
  // enforced by Supabase's own email-send limits; no need to duplicate
  // that here, only to avoid leaking whether it fired.
  if (error) {
    console.error("[resendConfirmationAction] resend failed", authErrorLogFields(error));
  }

  return { success: true, data: null };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
