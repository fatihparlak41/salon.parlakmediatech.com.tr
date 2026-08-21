import { z } from "zod";

export const serviceProfileSchema = z.object({
  name: z.string().trim().min(1, "Hizmet adı gerekli").max(200),
  category: z.string().trim().max(100).optional().or(z.literal("")),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
  durationMinutes: z.coerce.number().int().min(1, "Süre en az 1 dakika olmalı").max(1440),
  // NUMERIC in Postgres, never float arithmetic in the app — this only
  // validates shape/range; the value is passed through as a string to
  // preserve exact decimal precision end to end (see actions.ts).
  price: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Geçerli bir tutar girin (örn. 150 veya 150.50)"),
  branchIds: z.array(z.string().uuid()),
});

export const serviceBranchesSchema = z.object({
  serviceId: z.string().uuid(),
  branchIds: z.array(z.string().uuid()),
});

export const serviceStaffSchema = z.object({
  serviceId: z.string().uuid(),
  staffMemberIds: z.array(z.string().uuid()),
});

export const serviceStatusSchema = z.object({
  serviceId: z.string().uuid(),
  status: z.enum(["active", "inactive"]),
});
