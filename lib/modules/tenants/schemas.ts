import { z } from "zod";
import { isAvailableSlugCandidate } from "@/lib/tenancy/reserved-slugs";

export const createTenantSchema = z.object({
  name: z.string().trim().min(1, "Salon adı gerekli").max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      isAvailableSlugCandidate,
      "Bu adres kullanılamaz veya geçersiz format",
    ),
});
