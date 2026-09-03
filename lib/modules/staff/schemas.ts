import { z } from "zod";

export const staffProfileSchema = z.object({
  staffMemberId: z.string().uuid().optional(),
  fullName: z.string().trim().min(1, "Ad soyad gerekli").max(200),
  email: z
    .string()
    .trim()
    .email("Geçerli bir e-posta girin")
    .optional()
    .or(z.literal("")),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  branchIds: z.array(z.string().uuid()),
  tenantMembershipId: z.string().uuid().optional().or(z.literal("")),
  // Faz 2I.2B — staff_members.concurrent_capacity (20260902090000). Mirrors
  // the DB check constraint (1..20) so a bad value is rejected here with a
  // clear message instead of surfacing as a raw 23514 from Postgres.
  concurrentCapacity: z.coerce
    .number()
    .int("Tam sayı olmalı")
    .min(1, "En az 1 olmalı")
    .max(20, "En fazla 20 olabilir")
    .default(1),
});

export const staffBranchesSchema = z.object({
  staffMemberId: z.string().uuid(),
  branchIds: z.array(z.string().uuid()),
});

export const staffServicesSchema = z.object({
  staffMemberId: z.string().uuid(),
  serviceIds: z.array(z.string().uuid()),
});

const timeString = z.string().regex(/^\d{2}:\d{2}$/, "Geçersiz saat");

export const staffScheduleSchema = z.object({
  staffMemberId: z.string().uuid(),
  rows: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        branchId: z.string().uuid().nullable(),
        startTime: timeString,
        endTime: timeString,
      }),
    )
    .refine(
      (rows) => rows.every((r) => r.startTime < r.endTime),
      "Bitiş saati başlangıçtan sonra olmalı",
    ),
});

export const staffExceptionSchema = z
  .object({
    staffMemberId: z.string().uuid(),
    exceptionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Geçersiz tarih"),
    type: z.enum(["unavailable", "custom_hours"]),
    startTime: timeString.optional(),
    endTime: timeString.optional(),
    reason: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine(
    (data) =>
      data.type === "unavailable"
        ? !data.startTime && !data.endTime
        : !!data.startTime && !!data.endTime && data.startTime < data.endTime,
    { message: "Özel saatler için geçerli bir başlangıç/bitiş aralığı girin" },
  );

export const staffStatusSchema = z.object({
  staffMemberId: z.string().uuid(),
  status: z.enum(["active", "inactive"]),
});
