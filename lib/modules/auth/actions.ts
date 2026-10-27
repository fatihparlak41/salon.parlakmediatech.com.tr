"use server";

import { createClient } from "@/lib/supabase/server";
// Plain next/navigation — see lib/auth/session.ts for why server-side
// redirects don't use lib/i18n/navigation's locale-aware version.
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { ActionResult } from "@/lib/errors";
import { fail } from "@/lib/errors";
import {
  clearPendingConfirmation,
  getPendingConfirmation,
} from "@/lib/auth/pending-confirmation";
import { authErrorLogFields } from "@/lib/auth/session-errors";
import { resolveSafeNext } from "@/lib/auth/safe-redirect";
import {
  forgotPasswordSchema,
  resendConfirmationSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from "./schemas";
import { getSiteUrl } from "@/lib/site-url";
import { createStatelessAnonClient } from "@/lib/supabase/anon-stateless";
import {
  PASSWORD_RECOVERY_NEUTRAL_MESSAGE,
  RESET_FAILED_MESSAGE,
  RESET_INVALID_LINK_MESSAGE,
  RESET_SAME_PASSWORD_MESSAGE,
  RESET_WEAK_PASSWORD_MESSAGE,
  completePasswordReset,
  performPasswordRecoveryRequest,
} from "@/lib/auth/password-recovery";
import {
  POST_CONFIRM_NEXT_METADATA_KEY,
  chooseConfirmationDestination,
  resolvePostConfirmHintForWrite,
} from "@/lib/auth/post-confirm-destination";

/**
 * Faz SAAS.1D.2 — optional post-auth return path, e.g. /accept-invite.
 * Same shape as the customer portal's (lib/modules/customer-account/
 * actions.ts requestAccountMagicLinkAction): the page that rendered the
 * form already validated `?next=` once with resolveSafeNext, but a hidden
 * form field is client-submitted data, so it's re-validated here with
 * that same guard rather than trusted. Null when absent or empty, so the
 * caller keeps its own existing default ("/" for sign-in/sign-out, the
 * bare site URL for sign-up's emailRedirectTo).
 */
function readSafeNext(formData: FormData | undefined): string | null {
  const raw = formData?.get("next");
  if (typeof raw !== "string" || !raw) return null;
  return resolveSafeNext(raw, getSiteUrl());
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
    // Faz SAAS.1A: the one failure that is NOT answered with the generic message. The auth service answers
    // "email_not_confirmed" ONLY when the password was right (a wrong password is always invalid_credentials,
    // whatever the account's state), so showing it tells nobody whether an address has an account — it
    // helps the legitimate owner who never clicked the confirmation link. Everything else (unknown address,
    // wrong password, a banned account, an unexpected error) keeps the one neutral message.
    if (error.code === "email_not_confirmed") {
      return fail(
        "EMAIL_NOT_CONFIRMED",
        "E-posta adresiniz henüz doğrulanmamış. Gelen kutunuzdaki doğrulama bağlantısına tıklayın veya yeni bir doğrulama e-postası isteyin.",
      );
    }
    return fail("UNAUTHENTICATED", "E-posta veya şifre hatalı");
  }

  // Deliberately NOT accepting any pending team invitation here — login
  // only navigates. The person still has to press "Daveti Kabul Et" on
  // /accept-invite themselves.
  redirect(readSafeNext(formData) ?? "/");
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
  //
  // Faz SAAS.1D.2: a signup that began from an invitation continues to
  // /accept-invite after confirmation this way — the existing mechanism,
  // no change to confirm semantics, and no invitation token anywhere in
  // this URL (that stays in the HttpOnly cookie). Confirmed against the
  // DEV project's allowlist that a same-origin path here is honored, not
  // replaced by the Site URL.
  const next = readSafeNext(formData);

  // Faz SAAS.1D confirmation-continuity: PROD's shared "Confirm signup"
  // email template does not forward RedirectTo as `next` (proven from a
  // real PROD confirmation link), so emailRedirectTo alone cannot bring an
  // invited team member back to /accept-invite. The validated destination
  // is therefore ALSO stored on the account as a non-secret hint that
  // confirmEmailAction reads after a successful signup confirmation (see
  // lib/auth/post-confirm-destination.ts for the security model). Only an
  // allowlisted route is ever written — never a token, id, email or
  // cookie content. emailRedirectTo is deliberately left unchanged.
  const postConfirmNext = resolvePostConfirmHintForWrite(next, getSiteUrl());

  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: {
        full_name: parsed.data.fullName,
        ...(postConfirmNext ? { [POST_CONFIRM_NEXT_METADATA_KEY]: postConfirmNext } : {}),
      },
      emailRedirectTo: next && next !== "/" ? `${getSiteUrl()}${next}` : getSiteUrl(),
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

  // Faz SAAS.1A: a password-recovery link is consumed ONLY by the reset-password
  // form (resetPasswordAction), never here. Verifying it on this button would sign
  // the person in without ever asking for a new password, and would blur the
  // password-reset flow with the plain email-confirmation / customer magic-link
  // flow that shares this page. Nothing is verified and the parked token stays
  // where it is.
  if (pending.type === "recovery") {
    redirect("/reset-password");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
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

  // Faz SAAS.1D confirmation-continuity: an explicit destination from the
  // confirmation link wins; otherwise a SIGNUP confirmation falls back to
  // the validated post_confirm_next hint stored at sign-up (an invited
  // team member returns to /accept-invite), then to "/". Recovery,
  // magic-link, email-change, invite and email confirmations never
  // inherit the hint. Choosing a redirect is ALL this does — it does not
  // accept an invitation, create a membership, link staff or touch the
  // invitation: the explicit "Daveti Kabul Et" click remains mandatory.
  const { destination } = chooseConfirmationDestination({
    confirmType: pending.type,
    pendingNext: pending.next,
    userMetadata: data.user?.user_metadata,
    siteOrigin: getSiteUrl(),
  });

  redirect(destination);
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

/**
 * Faz SAAS.1A — step 1 of password recovery: ask for the e-mail.
 *
 * The response is the SAME neutral success for every well-formed address — known, unknown, unconfirmed,
 * customer-only, suspended — and the work (asking the auth provider to send the message) runs in after(),
 * i.e. only once the response has been produced, so neither the answer nor the time it takes depends on the
 * address and the form cannot be used to learn which addresses have an account (see
 * lib/auth/password-recovery.ts for the full model). A malformed address is the only visible error, and it
 * says nothing about accounts. Nothing is ever redirected to a user-supplied URL and no `next` is read.
 *
 * The request goes through a stateless publishable-key client, so no cookie, session or PKCE verifier is
 * written to the visitor. No `redirectTo` is passed: the recovery e-mail template the project must use
 * builds its own link to /auth/confirm with the token hash (see the SAAS.1A hosted-acceptance
 * requirements), and an unlisted redirect would only be silently replaced by the Site URL anyway.
 */
export async function requestPasswordRecoveryAction(
  _prevState: ActionResult<{ message: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ message: string }>> {
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get("email") });

  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçerli bir e-posta adresi girin");
  }

  const address = parsed.data.email;

  // performPasswordRecoveryRequest never throws, so nothing here can surface a difference.
  after(() =>
    performPasswordRecoveryRequest(address, {
      sendRecoveryEmail: (email) => createStatelessAnonClient().auth.resetPasswordForEmail(email),
    }),
  );

  return { success: true, data: { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE } };
}

/**
 * Faz SAAS.1A — step 2 of password recovery: the new password.
 *
 * The only place a recovery token is ever verified. It reads NOTHING from the form except the two password
 * fields: the token comes from the HttpOnly cookie parked by GET /auth/confirm, so a forged form cannot
 * choose which token is verified, and there is no `next` — success always lands on the staff login
 * (`/login`), never on a caller-supplied address. The password rules and the match check run BEFORE the
 * token is touched, so a typo does not burn the link.
 */
export async function resetPasswordAction(
  _prevState: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const pending = await getPendingConfirmation();
  const supabase = await createClient();

  const outcome = await completePasswordReset(
    { pending, password: parsed.data.password },
    {
      verifyRecoveryToken: async (tokenHash) => {
        const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
        return error ? { ok: false, error } : { ok: true };
      },
      updatePassword: async (password) => {
        const { error } = await supabase.auth.updateUser({ password });
        return error ? { ok: false, error } : { ok: true };
      },
      signOutEverywhere: async () => {
        const { error } = await supabase.auth.signOut({ scope: "global" });
        if (error) {
          console.error("[resetPasswordAction] global sign-out failed", authErrorLogFields(error));
        }
      },
      clearPending: clearPendingConfirmation,
    },
  );

  switch (outcome.kind) {
    case "success":
      // redirect() throws by design — keep it outside any try/catch.
      redirect("/login?reset=success");
    case "invalid_link":
      return fail("UNAUTHENTICATED", RESET_INVALID_LINK_MESSAGE);
    case "password_rejected":
      return fail("VALIDATION", outcome.reason === "same_password" ? RESET_SAME_PASSWORD_MESSAGE : RESET_WEAK_PASSWORD_MESSAGE);
    case "failed":
      return fail("UNEXPECTED", RESET_FAILED_MESSAGE);
  }
}

/** Optional `next` (Faz SAAS.1D.2): the invitation email-mismatch screen
 * signs the wrong account out and returns to /accept-invite, where the
 * still-parked invitation cookie lets the RIGHT account sign in and
 * continue. The sidebar's own sign-out form sends no `next`, so it keeps
 * landing on "/" exactly as before. */
export async function signOutAction(formData?: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(readSafeNext(formData) ?? "/");
}
