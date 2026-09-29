import { z } from "zod";
import { isValidSingleEmail } from "./email-validation";

/** Shape-level validation only — a defensive first gate before the
 * request ever reaches Postgres, catching garbage input with a normal
 * form-validation-shaped error instead of a raw type-cast failure. The
 * real domain validation (tenant/branch/service/staff/contact) stays
 * authoritative inside private.create_guest_booking, exactly as it was
 * before this gateway existed — this schema narrows types, it doesn't
 * duplicate business rules.
 *
 * customerEmail is the one exception (Faz NOTIF.1B): every public
 * booking now requires a real, single, well-formed address, so this
 * schema itself rejects missing/empty/whitespace/malformed/list-shaped
 * input via the same isValidSingleEmail() the client wizard uses for its
 * live "İleri" gate — one definition of "valid", not two that could
 * silently drift apart. public.create_guest_booking enforces the same
 * requirement again at the database boundary regardless of this schema
 * (see the migration's own header), so a caller that bypasses this
 * Server Action entirely still cannot submit a bookable request without
 * a valid email. */
export const guestBookingGatewayInputSchema = z.object({
  tenantSlug: z.string().trim().min(1),
  branchId: z.string().uuid(),
  serviceId: z.string().uuid(),
  scheduledStartAtUtc: z.string().datetime({ offset: true }),
  customerFullName: z.string().trim().min(1),
  customerPhone: z.string().trim().min(1),
  staffMemberId: z.string().uuid().optional(),
  customerEmail: z
    .string()
    .trim()
    .refine(isValidSingleEmail, { message: "invalid email" }),
  idempotencyKey: z.string().uuid(),
  turnstileToken: z.string().min(1),
  // Faz 2G.3.1 — plain intent flag, not an identity claim: worst case a
  // tampered value only affects the tamperer's own booking (an unwanted
  // claim cookie for themselves, or a skipped one). The server
  // independently re-derives whether this can ever mean anything
  // (trustedAccountUserId must be null, customerEmail must be present —
  // see gateway.ts), so this field alone can never widen access.
  wantAccountClaim: z.boolean().optional().default(false),
});

export type GuestBookingGatewayInput = z.infer<typeof guestBookingGatewayInputSchema>;
