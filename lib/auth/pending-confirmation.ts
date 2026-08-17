import "server-only";
import { cookies } from "next/headers";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Server-held state for the prefetch-safe email confirmation flow (see
 * app/auth/confirm/route.ts). The GET from the email link never verifies
 * anything — it stores the token here and redirects to a token-free URL.
 * Only the explicit POST from /confirm-email's button reads this and
 * calls verifyOtp(). HttpOnly so client JS (and thus XSS) can't read it;
 * Secure since this app is HTTPS-only in every environment that matters
 * (Vercel, custom domain); short-lived because it exists purely to
 * bridge one GET to one POST from the same person, not as a session.
 */

const COOKIE_NAME = "sb-pending-email-confirmation";
const TTL_SECONDS = 5 * 60;

const KNOWN_EMAIL_OTP_TYPES = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export type PendingConfirmation = {
  tokenHash: string;
  type: EmailOtpType;
  next: string;
};

function isPendingConfirmation(value: unknown): value is PendingConfirmation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tokenHash === "string" &&
    v.tokenHash.length > 0 &&
    typeof v.type === "string" &&
    KNOWN_EMAIL_OTP_TYPES.has(v.type as EmailOtpType) &&
    typeof v.next === "string"
  );
}

export async function setPendingConfirmation(
  value: PendingConfirmation,
): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, JSON.stringify(value), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: TTL_SECONDS,
    path: "/",
  });
}

/** Re-validates on every read — a cookie is still client-supplied data
 * on every subsequent request, not just at the moment we set it. */
export async function getPendingConfirmation(): Promise<PendingConfirmation | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isPendingConfirmation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearPendingConfirmation(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
