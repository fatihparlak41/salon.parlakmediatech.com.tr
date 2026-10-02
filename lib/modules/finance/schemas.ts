import { z } from "zod";

export const getOrCreateAppointmentSaleSchema = z.object({
  appointmentId: z.string().uuid(),
});

/** Faz FIN.1A Owner review — ONE atomic pricing save, replacing two
 * earlier separate schemas (per-item price + discount). The caller
 * submits the COMPLETE desired item set, never a partial patch — the
 * DB RPC (private.update_appointment_sale_pricing) independently
 * re-validates this is exactly the sale's current item set regardless
 * of what the client believes it is. */
export const salePricingItemSchema = z.object({
  saleItemId: z.string().uuid(),
  unitPrice: z.coerce.number().finite().min(0, "Fiyat negatif olamaz"),
});

export const updateAppointmentSalePricingSchema = z.object({
  saleId: z.string().uuid(),
  items: z.array(salePricingItemSchema).min(1, "En az bir kalem gerekli"),
  discountAmount: z.coerce.number().finite().min(0, "İndirim negatif olamaz"),
  discountReason: z.string().trim().max(500).optional().or(z.literal("")),
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
