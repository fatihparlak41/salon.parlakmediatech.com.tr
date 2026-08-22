import "server-only";
import { guestBookingGatewayInputSchema, type GuestBookingGatewayInput } from "./schemas";
import { verifyTurnstileToken, type TurnstileVerifier } from "./turnstile";
import { callCreateGuestBooking, type GuestBookingDbInput, type GuestBookingDbResult } from "./gateway-db";
import { mapPublicBookingErrorCode } from "./error-codes";
import type { GuestBookingConfirmation } from "./client-queries";

type DbCaller = (input: GuestBookingDbInput) => Promise<GuestBookingDbResult>;

export type GatewayResult =
  | { success: true; data: GuestBookingConfirmation }
  | { success: false; message: string };

const SECURITY_CHECK_FAILED_MESSAGE = "Güvenlik doğrulaması başarısız oldu. Lütfen tekrar deneyin.";
const GENERIC_FAILURE_MESSAGE = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

/**
 * The gateway's real logic, kept separate from the "use server" action
 * wrapper (actions.ts) specifically so tests can call it directly with
 * an injected Turnstile verifier — never a real network call to
 * Cloudflare from the test suite — while the actual Server Action the
 * browser calls (actions.ts) always takes the default, real verifier
 * with no test seam of its own. There is no parameter or environment
 * flag that lets a real request skip verification; `deps` only exists
 * because this function is called directly, unwrapped, from tests.
 *
 * Order matches the approved architecture exactly: shape-validate the
 * payload, verify Turnstile server-side, and only on success ever touch
 * the database. A Turnstile failure never reaches callCreateGuestBooking
 * — deps.callDb exists so a test can prove that directly (inject a
 * spy/throwing stub and assert it was never invoked), not just infer it
 * from the absence of a side effect.
 */
export async function processGuestBooking(
  rawInput: GuestBookingGatewayInput,
  deps: { verifyTurnstile?: TurnstileVerifier; callDb?: DbCaller } = {},
): Promise<GatewayResult> {
  const parsed = guestBookingGatewayInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { success: false, message: GENERIC_FAILURE_MESSAGE };
  }
  const input = parsed.data;

  const verify = deps.verifyTurnstile ?? verifyTurnstileToken;
  const verification = await verify(input.turnstileToken);
  if (!verification.success) {
    if (verification.errorCodes) {
      // Server-side diagnostic only — stable category, no secret, no PII.
      console.warn("[booking-gateway] turnstile verification failed", { codes: verification.errorCodes });
    }
    return { success: false, message: SECURITY_CHECK_FAILED_MESSAGE };
  }

  const callDb = deps.callDb ?? callCreateGuestBooking;
  const dbResult = await callDb({
    tenantSlug: input.tenantSlug,
    branchId: input.branchId,
    serviceId: input.serviceId,
    scheduledStartAtUtc: input.scheduledStartAtUtc,
    customerFullName: input.customerFullName,
    customerPhone: input.customerPhone,
    staffMemberId: input.staffMemberId,
    customerEmail: input.customerEmail,
    idempotencyKey: input.idempotencyKey,
  });

  if (!dbResult.success) {
    if (!dbResult.code.startsWith("BK")) {
      // Anything that isn't one of our own stable BK0nn codes — a raw
      // connection failure, an unexpected constraint, etc. — is a
      // genuine internal problem. Logged with a stable category and the
      // DB's own error code only; never the connection string, role
      // name, or a stack trace, and this line never runs for the
      // ordinary customer-facing BK0nn cases below.
      console.error("[booking-gateway] unexpected database error", { code: dbResult.code });
    }
    return { success: false, message: mapPublicBookingErrorCode(dbResult.code) };
  }

  return { success: true, data: dbResult.data as unknown as GuestBookingConfirmation };
}
