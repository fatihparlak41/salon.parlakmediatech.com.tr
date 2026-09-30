"use server";

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { mapFinanceErrorCode } from "./error-codes";
import {
  getOrCreateAppointmentSaleSchema,
  adjustSaleItemPriceSchema,
  adjustSaleDiscountSchema,
  recordAppointmentPaymentSchema,
  voidAppointmentPaymentSchema,
} from "./schemas";

/** Every finance RPC failure carries a stable FN0nn code (20260929120000)
 * — map that, never the raw message. */
function mapRpcError(error: { code?: string; message: string } | null): ActionResult<never> {
  return fail("UNEXPECTED", mapFinanceErrorCode(error?.code));
}

export type GetOrCreateAppointmentSaleInput = { appointmentId: string };

/** Lazy checkout creation — the only way a sale row comes into existence.
 * Idempotent server-side (repeat calls return the same sale); the finance
 * panel calls this once when it first opens for an appointment. */
export async function getOrCreateAppointmentSaleAction(
  _prevState: ActionResult<{ id: string }> | null,
  input: GetOrCreateAppointmentSaleInput,
): Promise<ActionResult<{ id: string }>> {
  await requireUser();

  const parsed = getOrCreateAppointmentSaleSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz istek");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_or_create_appointment_sale", {
    p_appointment_id: parsed.data.appointmentId,
  });

  if (error || !data) return mapRpcError(error);
  return ok({ id: data.id as string });
}

export type AdjustSaleItemPriceInput = { saleItemId: string; unitPrice: number };

export async function adjustAppointmentSaleItemPriceAction(
  _prevState: ActionResult<null> | null,
  input: AdjustSaleItemPriceInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = adjustSaleItemPriceSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz fiyat");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("adjust_appointment_sale_item_price", {
    p_sale_item_id: parsed.data.saleItemId,
    p_unit_price: parsed.data.unitPrice,
  });

  if (error) return mapRpcError(error);
  return ok(null);
}

export type AdjustSaleDiscountInput = { saleId: string; discountAmount: number; reason?: string };

export async function adjustAppointmentSaleDiscountAction(
  _prevState: ActionResult<null> | null,
  input: AdjustSaleDiscountInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = adjustSaleDiscountSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz indirim");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("adjust_appointment_sale_discount", {
    p_sale_id: parsed.data.saleId,
    p_discount_amount: parsed.data.discountAmount,
    p_reason: parsed.data.reason || undefined,
  });

  if (error) return mapRpcError(error);
  return ok(null);
}

export type RecordAppointmentPaymentInput = {
  saleId: string;
  amount: number;
  method: "cash" | "card" | "bank_transfer" | "other";
  paidAt: string;
  note?: string;
  idempotencyKey: string;
};

export async function recordAppointmentPaymentAction(
  _prevState: ActionResult<{ id: string }> | null,
  input: RecordAppointmentPaymentInput,
): Promise<ActionResult<{ id: string }>> {
  await requireUser();

  const parsed = recordAppointmentPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz ödeme");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_appointment_payment", {
    p_sale_id: parsed.data.saleId,
    p_amount: parsed.data.amount,
    p_method: parsed.data.method,
    p_paid_at: parsed.data.paidAt,
    p_note: parsed.data.note || undefined,
    p_idempotency_key: parsed.data.idempotencyKey,
  });

  if (error || !data) return mapRpcError(error);
  return ok({ id: data.id as string });
}

export type VoidAppointmentPaymentInput = { paymentId: string; reason: string };

export async function voidAppointmentPaymentAction(
  _prevState: ActionResult<null> | null,
  input: VoidAppointmentPaymentInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = voidAppointmentPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz iptal nedeni");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("void_appointment_payment", {
    p_payment_id: parsed.data.paymentId,
    p_reason: parsed.data.reason,
  });

  if (error) return mapRpcError(error);
  return ok(null);
}
