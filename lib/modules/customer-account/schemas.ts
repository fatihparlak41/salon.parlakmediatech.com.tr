import { z } from "zod";

export const accountMagicLinkSchema = z.object({
  email: z.string().trim().email("Geçerli bir e-posta adresi girin"),
});

export const updateAccountProfileSchema = z.object({
  fullName: z.string().trim().min(1, "Ad soyad gerekli").max(200),
  phone: z.string().trim().max(30).optional(),
});
