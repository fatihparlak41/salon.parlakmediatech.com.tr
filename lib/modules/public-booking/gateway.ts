import "server-only";
import { randomBytes, createHash } from "node:crypto";
import { guestBookingGatewayInputSchema, type GuestBookingGatewayInput } from "./schemas";
import { verifyTurnstileToken, type TurnstileVerifier } from "./turnstile";
import { callCreateGuestBooking, type GuestBookingDbInput, type GuestBookingDbResult } from "./gateway-db";
import { mapPublicBookingErrorCode } from "./error-codes";
import type { GuestBookingConfirmation } from "./client-queries";

type DbCaller = (input: GuestBookingDbInput) => Promise<GuestBookingDbResult>;

export type GatewayResult =
  // claimSecret/claimRef (Faz 2G.3.1/2G.3.1A) are present only when a
  // claim capability was actually issued this call. Neither may ever
  // reach the browser: actions.ts reads them to set the per-claim
  // HttpOnly cookie and build the Magic Link's `next` path, then
  // returns {success, data} only, omitting both before the result
  // crosses the server/client boundary. claimRef alone carries no
  // authority (see the migration's own header), but it's still an
  // internal correlation detail with no reason to reach client JS.
  | { success: true; data: GuestBookingConfirmation; claimSecret?: string; claimRef?: string }
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
 *
 * trustedAccountUserId is a SEPARATE parameter from rawInput on purpose
 * (Faz 2G.1) — GuestBookingGatewayInput is the Zod-validated shape of
 * whatever the browser sent, and this value must never be extractable
 * from that object. The only caller, actions.ts's submitGuestBookingAction,
 * derives it itself from the server-side session (getCurrentUser()) and
 * passes it here; nothing about it ever round-trips through the client.
 */
export async function processGuestBooking(
  rawInput: GuestBookingGatewayInput,
  trustedAccountUserId: string | null,
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

  // Faz 2G.3.1 — the booking-browser claim secret (proof A) is generated
  // here, on the Next.js server, and ONLY here: node:crypto.randomBytes,
  // 256 bits. Only its SHA-256 hash ever reaches callDb/Postgres — the
  // raw value lives exclusively in this function's local variable and,
  // moments later, actions.ts's HttpOnly cookie write. Never generated
  // for an authenticated booker (Phase 2G.1's trusted linking already
  // owns that case) and never without an email to bind proof B to.
  let rawClaimSecret: string | undefined;
  let claimSecretHash: string | undefined;
  if (trustedAccountUserId === null && input.wantAccountClaim && input.customerEmail) {
    rawClaimSecret = randomBytes(32).toString("hex");
    claimSecretHash = createHash("sha256").update(rawClaimSecret).digest("hex");
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
    customerAccountUserId: trustedAccountUserId,
    claimSecretHash,
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

  // claimRef (booking_account_claims.id) travels inside the raw DB
  // response alongside the public fields — extracted here and never
  // forwarded as part of `data`, the same way claimSecret never enters
  // the DB response at all. Destructuring it out is deliberate: `data`
  // must carry exactly the fields BookingWizard has always received,
  // nothing new.
  const { claimRef, ...data } = dbResult.data as unknown as GuestBookingConfirmation & { claimRef: string | null };
  // claimIssued (see private.upsert_booking_claim) confirms the row was
  // actually written before this function ever promises a browser a
  // working capability — claim creation is best-effort and swallows its
  // own failures inside the database, so this check is load-bearing, not
  // decorative. claimRef must also be present (it always is exactly
  // when claimIssued is true — private.upsert_booking_claim returns the
  // row's id if and only if it wrote/rotated it) before a cookie is
  // ever promised.
  if (rawClaimSecret && data.claimIssued && claimRef) {
    return { success: true, data, claimSecret: rawClaimSecret, claimRef };
  }
  return { success: true, data };
}
