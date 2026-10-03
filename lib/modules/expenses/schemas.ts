import { z } from "zod";
import { MONEY_PARSE_MESSAGES, parseMoneyInput } from "./money";
import { EXPENSE_PAYMENT_METHODS } from "./types";

/**
 * Faz FIN.1B.1 — authoritative input validation for the expense Server Actions. The database re-validates everything
 * (these are the friendly, early checks with Turkish messages); the limits below mirror its CHECK constraints
 * (20261003090000): description 1-200, vendor 1-200, note and reasons 1-500, dates 2000-01-01..2100-12-31.
 */

const MIN_DATE = "2000-01-01";
const MAX_DATE = "2100-12-31";

const tenantSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "Geçersiz salon");

const uuidSchema = (message: string) => z.string().uuid(message);

const categoryKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Kategori seçin");

const isoDateSchema = (message: string) =>
  z.iso
    .date(message)
    .refine((value) => value >= MIN_DATE && value <= MAX_DATE, message);

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
export const moneyAmountSchema = z
  .union([z.string(), z.number()])
  .transform((raw, ctx) => {
    const text =
      typeof raw === "number"
        ? Number.isFinite(raw)
          ? String(raw)
          : "NaN"
        : raw;
    const parsed = parseMoneyInput(text);
    if (!parsed.ok) {
      ctx.addIssue({
        code: "custom",
        message: MONEY_PARSE_MESSAGES[parsed.reason],
      });
      return z.NEVER;
    }
    return parsed.number;
  });

export const paymentMethodSchema = z.enum(EXPENSE_PAYMENT_METHODS, {
  message: "Geçersiz ödeme yöntemi",
});

const paidAtSchema = z
  .string()
  .datetime({ offset: true, message: "Geçerli bir ödeme zamanı gerekli" });

const descriptionSchema = z
  .string()
  .trim()
  .min(1, "Açıklama gerekli")
  .max(200, "Açıklama en fazla 200 karakter olabilir");

const reasonSchema = (missing: string) =>
  z
    .string()
    .trim()
    .min(1, missing)
    .max(500, "Neden en fazla 500 karakter olabilir");

export const initialPaymentSchema = z.object({
  amount: moneyAmountSchema,
  method: paymentMethodSchema,
  paidAt: paidAtSchema,
  note: optionalText(500, "Ödeme notu"),
});

export const createExpenseSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    categoryKey: categoryKeySchema,
    description: descriptionSchema,
    expenseDate: isoDateSchema("Geçerli bir gider tarihi girin"),
    amount: moneyAmountSchema,
    dueDate: optionalDate("Geçerli bir vade tarihi girin"),
    branchId: uuidSchema("Geçersiz şube").nullable().optional(),
    vendorName: optionalText(200, "Tedarikçi"),
    note: optionalText(500, "Not"),
    idempotencyKey: uuidSchema("Geçersiz istek anahtarı"),
    initialPayment: initialPaymentSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.dueDate && value.dueDate < value.expenseDate) {
      ctx.addIssue({
        code: "custom",
        path: ["dueDate"],
        message: "Vade tarihi gider tarihinden önce olamaz",
      });
    }
  });

export const updateExpenseSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    expenseId: uuidSchema("Geçersiz gider"),
    expectedVersion: z.number().int("Geçersiz sürüm").min(1, "Geçersiz sürüm"),
    categoryKey: categoryKeySchema,
    description: descriptionSchema,
    expenseDate: isoDateSchema("Geçerli bir gider tarihi girin"),
    amount: moneyAmountSchema,
    dueDate: optionalDate("Geçerli bir vade tarihi girin"),
    branchId: uuidSchema("Geçersiz şube").nullable().optional(),
    vendorName: optionalText(200, "Tedarikçi"),
    note: optionalText(500, "Not"),
  })
  .superRefine((value, ctx) => {
    if (value.dueDate && value.dueDate < value.expenseDate) {
      ctx.addIssue({
        code: "custom",
        path: ["dueDate"],
        message: "Vade tarihi gider tarihinden önce olamaz",
      });
    }
  });

export const cancelExpenseSchema = z.object({
  tenantSlug: tenantSlugSchema,
  expenseId: uuidSchema("Geçersiz gider"),
  reason: reasonSchema("İptal nedeni gerekli"),
});

export const recordExpensePaymentSchema = z.object({
  tenantSlug: tenantSlugSchema,
  expenseId: uuidSchema("Geçersiz gider"),
  amount: moneyAmountSchema,
  method: paymentMethodSchema,
  paidAt: paidAtSchema,
  note: optionalText(500, "Ödeme notu"),
  idempotencyKey: uuidSchema("Geçersiz istek anahtarı"),
});

export const voidExpensePaymentSchema = z.object({
  tenantSlug: tenantSlugSchema,
  paymentId: uuidSchema("Geçersiz ödeme"),
  reason: reasonSchema("İptal nedeni gerekli"),
});
