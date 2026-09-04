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

/** Best-effort redaction for a provider error body before it ever reaches
 * a log line — catches long runs of URL-safe/base64-ish characters, the
 * shape a token, secret, or other credential would take if one were ever
 * echoed back. Deliberately over-inclusive (it will also redact harmless
 * long strings, e.g. a site key, if one happens to appear) — see this
 * function's only caller for why that tradeoff is intentional here. This
 * function only ever touches Cloudflare's OWN response text; the real
 * secret and the caller's token are never passed to it. */
function redactLikelyCredential(text: string): string {
  return text.replace(/[A-Za-z0-9_\-.]{20,}/g, "[REDACTED]");
}

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
    // Diagnostic-only enrichment — the fail-closed outcome below is
    // identical whether or not any of this succeeds. Every field pulled
    // out is either a status code, one of Cloudflare's own documented
    // machine-readable fields, or redacted free text; never the secret
    // (never sent anywhere but the request we just made) or the caller's
    // token (never read here at all).
    const codes = [`provider-http-${response.status}`];
    try {
      const bodyText = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Not JSON — handled by the raw-text fallback below.
      }
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        if (Array.isArray(p["error-codes"]) && p["error-codes"].length > 0) {
          codes.push(`provider-error-codes:${p["error-codes"].join(",")}`);
        }
        const messageField = typeof p.message === "string" ? p.message : Array.isArray(p.messages) ? p.messages.join(";") : null;
        if (messageField) {
          codes.push(`provider-message:${redactLikelyCredential(messageField).slice(0, 200)}`);
        }
        if (typeof p.hostname === "string") {
          codes.push(`provider-hostname:${p.hostname}`);
        }
        if (typeof p.action === "string") {
          codes.push(`provider-action:${p.action}`);
        }
      } else {
        const redacted = redactLikelyCredential(bodyText).slice(0, 300);
        if (redacted.length > 0) {
          codes.push(`provider-body:${redacted}`);
        }
      }
    } catch {
      // Reading the body itself failed — the http-status code above is
      // still returned; this extra detail was only ever best-effort.
    }
    return { success: false, errorCodes: codes };
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
