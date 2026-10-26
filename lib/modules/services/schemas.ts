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
  // Faz BEAUTY.1A - optional generic experience fields; see experience.ts for the cross-field rules.
  pricingMode: z.enum(["fixed", "inquiry"]).optional(),
  bookingMode: z.enum(["direct", "inquiry"]).optional(),
  pricePublic: z.boolean().optional(),
  displayDurationMin: z.number().int().min(1).max(1440).nullable().optional(),
  displayDurationMax: z.number().int().min(1).max(1440).nullable().optional(),
  publicSummary: z.string().max(400).optional(),
  publicDetails: z.string().max(3000).optional(),
  preparationNote: z.string().max(900).optional(),
  aftercareNote: z.string().max(900).optional(),
  importantNote: z.string().max(600).optional(),
  badgeLabel: z.string().max(120).optional(),
  // Faz BEAUTY.1B - optional recommended re-booking window (days); cross-field rules in rebook.ts.
  rebookMinDays: z.number().int().min(1).max(730).nullable().optional(),
  rebookMaxDays: z.number().int().min(1).max(730).nullable().optional(),
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
