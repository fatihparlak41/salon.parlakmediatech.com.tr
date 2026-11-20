import { z } from "zod";
import { MONEY_PARSE_MESSAGES, parseMoneyInput } from "./money";
import { STAFF_PAYMENT_METHODS, STAFF_PAYMENT_PURPOSES, isAdjustmentKind } from "./types";

/**
 * Faz FIN.1C.1 — authoritative input validation for the ten staff-finance Server Actions. The database re-validates
 * everything (these are the friendly, early checks with Turkish messages); the limits below mirror its CHECK constraints
 * (20261007120100): line description 1-200, note and reasons 1-500, dates 2000-01-01..2100-12-31, 100 lines per period.
 */

const MIN_DATE = "2000-01-01";
const MAX_DATE = "2100-12-31";

const tenantSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "Geçersiz salon");

const uuidSchema = (message: string) => z.string().uuid(message);

const kindSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, "Geçerli bir kalem türü seçin");

const isoDateSchema = (message: string) => z.iso.date(message).refine((value) => value >= MIN_DATE && value <= MAX_DATE, message);

/** A calendar month as its first day (what the RPC takes): YYYY-MM-01 only. */
const periodMonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-01$/, "Geçerli bir ay seçin")
  .pipe(isoDateSchema("Geçerli bir ay seçin"));

/** "" and whitespace become undefined (an absent optional value), anything else is trimmed and length-checked. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} en fazla ${max} karakter olabilir`)
    .optional()
    .transform((value) => (value ? value : undefined));

const optionalDate = (message: string) =>
  z
    .union([isoDateSchema(message), z.literal("")])
    .optional()
    .transform((value) => (value ? value : undefined));

/**
 * A money amount typed by a person: a string such as "250,50" or a number the dialog already parsed. It goes through
 * parseMoneyInput either way (a number is checked through its canonical text), and the output is the exact JS number.
 */
export const moneyAmountSchema = z.union([z.string(), z.number()]).transform((raw, ctx) => {
  const text = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "NaN") : raw;
  const parsed = parseMoneyInput(text);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: MONEY_PARSE_MESSAGES[parsed.reason] });
    return z.NEVER;
  }
  return parsed.number;
});

export const paymentMethodSchema = z.enum(STAFF_PAYMENT_METHODS, { message: "Geçersiz ödeme yöntemi" });
export const paymentPurposeSchema = z.enum(STAFF_PAYMENT_PURPOSES, { message: "Geçersiz ödeme türü" });

const paidAtSchema = z.string().datetime({ offset: true, message: "Geçerli bir ödeme zamanı gerekli" });

const lineDescriptionSchema = z
  .string()
  .trim()
  .max(200, "Açıklama en fazla 200 karakter olabilir")
  .optional()
  .transform((value) => (value ? value : undefined));

const reasonSchema = (missing: string) => z.string().trim().min(1, missing).max(500, "Neden en fazla 500 karakter olabilir");

const expectedVersionSchema = z.number().int("Geçersiz sürüm").min(1, "Geçersiz sürüm");

export const createStaffPeriodSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    staffMemberId: uuidSchema("Personel seçin"),
    periodMonth: periodMonthSchema,
    dueDate: optionalDate("Geçerli bir vade tarihi girin"),
    idempotencyKey: uuidSchema("Geçersiz istek anahtarı"),
  })
  .superRefine((value, ctx) => {
    if (value.dueDate && value.dueDate < value.periodMonth) {
      ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Vade tarihi dönemin ayından önce olamaz" });
    }
  });

export const updateStaffPeriodSchema = z.object({
  tenantSlug: tenantSlugSchema,
  periodId: uuidSchema("Geçersiz dönem"),
  /** null, "" or omitted clears the due date. */
  dueDate: optionalDate("Geçerli bir vade tarihi girin"),
  expectedVersion: expectedVersionSchema,
});

export const addStaffLineSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    periodId: uuidSchema("Geçersiz dönem"),
    kind: kindSchema,
    amount: moneyAmountSchema,
    description: lineDescriptionSchema,
    idempotencyKey: uuidSchema("Geçersiz istek anahtarı"),
  })
  .superRefine((value, ctx) => {
    if (isAdjustmentKind(value.kind) && !value.description) {
      ctx.addIssue({ code: "custom", path: ["description"], message: "Düzeltme kalemi için açıklama gerekli" });
    }
  });

export const updateStaffLineSchema = z.object({
  tenantSlug: tenantSlugSchema,
  lineId: uuidSchema("Geçersiz kalem"),
  amount: moneyAmountSchema,
  /** The desired state: an omitted or blank description clears it (the RPC refuses that for a Düzeltme line). */
  description: lineDescriptionSchema,
  expectedVersion: expectedVersionSchema,
});

export const voidStaffLineSchema = z.object({
  tenantSlug: tenantSlugSchema,
  lineId: uuidSchema("Geçersiz kalem"),
  reason: reasonSchema("İptal nedeni gerekli"),
  expectedVersion: expectedVersionSchema,
});

export const finalizeStaffPeriodSchema = z.object({
  tenantSlug: tenantSlugSchema,
  periodId: uuidSchema("Geçersiz dönem"),
  expectedVersion: expectedVersionSchema,
});

export const reopenStaffPeriodSchema = z.object({
  tenantSlug: tenantSlugSchema,
  periodId: uuidSchema("Geçersiz dönem"),
  reason: reasonSchema("Yeniden açma nedeni gerekli"),
  expectedVersion: expectedVersionSchema,
});

export const cancelStaffPeriodSchema = z.object({
  tenantSlug: tenantSlugSchema,
  periodId: uuidSchema("Geçersiz dönem"),
  reason: reasonSchema("İptal nedeni gerekli"),
});

export const recordStaffPaymentSchema = z.object({
  tenantSlug: tenantSlugSchema,
  periodId: uuidSchema("Geçersiz dönem"),
  purpose: paymentPurposeSchema,
  amount: moneyAmountSchema,
  method: paymentMethodSchema,
  paidAt: paidAtSchema,
  note: optionalText(500, "Ödeme notu"),
  idempotencyKey: uuidSchema("Geçersiz istek anahtarı"),
});

export const voidStaffPaymentSchema = z.object({
  tenantSlug: tenantSlugSchema,
  paymentId: uuidSchema("Geçersiz ödeme"),
  reason: reasonSchema("İptal nedeni gerekli"),
});
