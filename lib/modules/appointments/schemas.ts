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

export const appointmentStatusSchema = z.object({
  appointmentId: z.string().uuid(),
  status: z.enum(["confirmed", "in_progress", "completed", "cancelled", "no_show"]),
});
