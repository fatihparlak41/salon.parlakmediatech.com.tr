import { z } from "zod";

const uuid = z.string().uuid();

export const SUPPORTED_CURRENCIES = ["TRY", "EUR", "USD", "GBP"] as const;

/** Time zones the setup offers by name; any other IANA name the database knows is accepted too (validated there). */
export const COMMON_TIMEZONES = ["Europe/Istanbul", "Asia/Nicosia"] as const;

export const profileInputSchema = z.object({
  tenantId: uuid,
  tenantSlug: z.string().min(1).max(63),
  name: z.string().trim().min(1, "Salon adı gerekli").max(200),
  timezone: z.string().trim().min(1, "Saat dilimi gerekli").max(64),
  currency: z.enum(SUPPORTED_CURRENCIES, { message: "Geçerli bir para birimi seçin" }),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+()\-\s]{7,24}$/, "Geçerli bir telefon numarası girin"),
  address: z.string().trim().max(500).optional().or(z.literal("")),
});

export const serviceRowsSchema = z.object({
  tenantId: uuid,
  tenantSlug: z.string().min(1).max(63),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Hizmet adı gerekli").max(200),
        category: z.string().trim().max(100).optional().or(z.literal("")),
        durationMinutes: z.coerce.number().int().min(5, "Süre en az 5 dakika olmalı").max(1440, "Süre en fazla 1440 dakika olabilir"),
        price: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/, "Geçerli bir tutar girin (örn. 150 veya 150.50)"),
      }),
    )
    .min(1, "En az bir hizmet girin")
    .max(50, "Bir seferde en fazla 50 hizmet eklenebilir"),
});

export const staffRowsSchema = z.object({
  tenantId: uuid,
  tenantSlug: z.string().min(1).max(63),
  items: z
    .array(
      z.object({
        fullName: z.string().trim().min(1, "Personel adı gerekli").max(200),
        phone: z.string().trim().max(24).optional().or(z.literal("")),
      }),
    )
    .min(1, "En az bir kişi girin")
    .max(30, "Bir seferde en fazla 30 kişi eklenebilir"),
});

export const hoursInputSchema = z.object({
  tenantId: uuid,
  tenantSlug: z.string().min(1).max(63),
  staffIds: z.array(uuid).min(1, "En az bir personel seçin").max(100),
  days: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }),
    )
    .max(28),
});

export const mappingInputSchema = z.object({
  tenantId: uuid,
  tenantSlug: z.string().min(1).max(63),
  assignments: z
    .array(z.object({ staffId: uuid, serviceIds: z.array(uuid).max(200) }))
    .min(1)
    .max(100),
});
