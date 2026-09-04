import { z } from "zod";
import {
  isValidInstagramHandle,
  isValidLocationUrl,
  isValidWhatsappPhone,
  normalizeInstagramHandle,
  normalizeWhatsappPhone,
} from "./normalize";

/**
 * Faz 2I.2F (Batch A) — shape/format validation for the owner-managed
 * branch contact form. Mirrors customerProfileSchema's own style
 * (lib/modules/customers/schemas.ts: trim + max length +
 * .optional().or(z.literal(""))) so an empty field means "clear this
 * value", not "leave unchanged". The three new fields additionally
 * .refine() against normalize.ts's validators — the refine runs on the
 * RAW trimmed input (before normalization), same "@Handle" or "Handle"
 * either way, so a value that only becomes valid after stripping the
 * "@"/"+" still passes.
 */
export const branchContactSchema = z.object({
  branchId: z.string().uuid(),
  tenantSlug: z.string().trim().min(1),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  whatsappPhone: z
    .string()
    .trim()
    .max(50)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isValidWhatsappPhone(normalizeWhatsappPhone(v)), "Geçerli bir telefon numarası girin"),
  instagramHandle: z
    .string()
    .trim()
    .max(50)
    .optional()
    .or(z.literal(""))
    .refine(
      (v) => !v || isValidInstagramHandle(normalizeInstagramHandle(v)),
      "Geçerli bir Instagram kullanıcı adı girin",
    ),
  locationUrl: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isValidLocationUrl(v), "Geçerli bir bağlantı girin (http:// veya https://)"),
});

export type BranchContactInput = z.infer<typeof branchContactSchema>;
