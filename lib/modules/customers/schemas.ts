import { z } from "zod";

export const customerProfileSchema = z.object({
  fullName: z.string().trim().min(1, "Ad soyad gerekli").max(200),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  email: z
    .string()
    .trim()
    .email("Geçerli bir e-posta girin")
    .optional()
    .or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const customerStatusSchema = z.object({
  customerId: z.string().uuid(),
  status: z.enum(["active", "archived"]),
});
