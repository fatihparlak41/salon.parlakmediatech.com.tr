import { z } from "zod";

export const appointmentItemInputSchema = z.object({
  serviceId: z.string().uuid(),
  staffMemberId: z.string().uuid(),
  scheduledStartAt: z.string().datetime({ offset: true }),
  sequence: z.number().int().min(1),
});

export const createAppointmentSchema = z.object({
  tenantId: z.string().uuid(),
  branchId: z.string().uuid(),
  customerId: z.string().uuid(),
  items: z.array(appointmentItemInputSchema).min(1, "En az bir hizmet eklemelisiniz"),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const rescheduleAppointmentSchema = z.object({
  appointmentId: z.string().uuid(),
  items: z.array(appointmentItemInputSchema).min(1, "En az bir hizmet eklemelisiniz"),
});

// Faz 5A.2 — "completed" deliberately excluded: update_appointment_status
// no longer accepts it (closed completion bypass, Option A) — completion
// goes exclusively through completeAppointmentSchema/complete_appointment
// below. Narrowed here, not just enforced server-side, so no future
// caller can even construct a well-typed request that would hit the new
// AP017 rejection.
export const appointmentStatusSchema = z.object({
  appointmentId: z.string().uuid(),
  status: z.enum(["confirmed", "in_progress", "cancelled", "no_show"]),
});

/** Faz 5A.1 — one entry per appointment_item the caller wants to correct
 * away from its booked staff_member_id. An item not named here (empty
 * array included) falls back to its own booked staff at the DB layer —
 * this schema only validates shape, the RPC is the actual authority on
 * tenant/eligibility facts (see private.complete_appointment). */
export const performerOverrideSchema = z.object({
  appointmentItemId: z.string().uuid(),
  actualStaffMemberId: z.string().uuid(),
});

export const completeAppointmentSchema = z.object({
  appointmentId: z.string().uuid(),
  performerOverrides: z.array(performerOverrideSchema).default([]),
});
