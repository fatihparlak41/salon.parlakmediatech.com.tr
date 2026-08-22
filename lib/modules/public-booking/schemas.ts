import { z } from "zod";

/** Shape-level validation only — a defensive first gate before the
 * request ever reaches Postgres, catching garbage input with a normal
 * form-validation-shaped error instead of a raw type-cast failure. The
 * real domain validation (tenant/branch/service/staff/contact) stays
 * authoritative inside private.create_guest_booking, exactly as it was
 * before this gateway existed — this schema narrows types, it doesn't
 * duplicate business rules. */
export const guestBookingGatewayInputSchema = z.object({
  tenantSlug: z.string().trim().min(1),
  branchId: z.string().uuid(),
  serviceId: z.string().uuid(),
  scheduledStartAtUtc: z.string().datetime({ offset: true }),
  customerFullName: z.string().trim().min(1),
  customerPhone: z.string().trim().min(1),
  staffMemberId: z.string().uuid().optional(),
  customerEmail: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().uuid(),
  turnstileToken: z.string().min(1),
});

export type GuestBookingGatewayInput = z.infer<typeof guestBookingGatewayInputSchema>;
