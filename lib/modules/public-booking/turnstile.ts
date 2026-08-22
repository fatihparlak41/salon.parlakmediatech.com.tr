import "server-only";

/**
 * Server-side Turnstile verification. Browser-reported success is never
 * trusted on its own — this is the authoritative check, called only from
 * the booking gateway (lib/modules/public-booking/gateway.ts), never
 * from anything a client component can reach directly. TURNSTILE_SECRET_KEY
 * is read here and only here; nothing in this file is importable from a
 * "use client" component (the server-only import makes that a build error,
 * matching lib/supabase/admin.ts's own pattern for the same reason).
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileVerification = {
  success: boolean;
  /** Present only on failure — Cloudflare's own machine-readable reason
   * codes (e.g. "timeout-or-duplicate", "invalid-input-response").
   * Logged server-side for diagnosis; never returned to the client. */
  errorCodes?: string[];
};

/** expectedHostname: checked against the verify response's own `hostname`
 * field when Cloudflare returns one — skipped (not weakened, just not
 * asserted) when unset, so local DEV over localhost doesn't need PROD's
 * hostname enforcement. A real PROD deployment should always pass this. */
export async function verifyTurnstileToken(
  token: string,
  options?: { expectedHostname?: string },
): Promise<TurnstileVerification> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Fails closed — never silently treats "not configured" as "passed".
    return { success: false, errorCodes: ["missing-input-secret"] };
  }

  let response: Response;
  try {
    response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
  } catch {
    // Network/provider failure — fail closed, never treated as success.
    return { success: false, errorCodes: ["provider-unreachable"] };
  }

  if (!response.ok) {
    return { success: false, errorCodes: [`provider-http-${response.status}`] };
  }

  const body = (await response.json()) as { success?: boolean; ["error-codes"]?: string[]; hostname?: string };

  // The provider's own success field is the actual signal — a 200
  // response alone proves nothing about verification outcome.
  if (body.success !== true) {
    return { success: false, errorCodes: body["error-codes"] ?? ["unknown"] };
  }

  if (options?.expectedHostname && body.hostname && body.hostname !== options.expectedHostname) {
    return { success: false, errorCodes: ["hostname-mismatch"] };
  }

  return { success: true };
}

export type TurnstileVerifier = typeof verifyTurnstileToken;
