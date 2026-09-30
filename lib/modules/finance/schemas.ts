import { z } from "zod";

export const getOrCreateAppointmentSaleSchema = z.object({
  appointmentId: z.string().uuid(),
});

export const adjustSaleItemPriceSchema = z.object({
  saleItemId: z.string().uuid(),
  unitPrice: z.coerce.number().finite().min(0, "Fiyat negatif olamaz"),
});

export const adjustSaleDiscountSchema = z.object({
  saleId: z.string().uuid(),
  discountAmount: z.coerce.number().finite().min(0, "İndirim negatif olamaz"),
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

export const paymentMethodSchema = z.enum(["cash", "card", "bank_transfer", "other"]);

export const recordAppointmentPaymentSchema = z.object({
  saleId: z.string().uuid(),
  amount: z.coerce.number().finite().positive("Tutar sıfırdan büyük olmalı"),
  method: paymentMethodSchema,
  paidAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(500).optional().or(z.literal("")),
  idempotencyKey: z.string().uuid(),
});

export const voidAppointmentPaymentSchema = z.object({
  paymentId: z.string().uuid(),
  reason: z.string().trim().min(1, "İptal nedeni gerekli").max(500),
});
