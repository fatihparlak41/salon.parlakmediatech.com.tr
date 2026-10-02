"use server";

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { mapFinanceErrorCode } from "./error-codes";
import {
  getOrCreateAppointmentSaleSchema,
  updateAppointmentSalePricingSchema,
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
 * Idempotent server-side (repeat calls return the same sale). Faz FIN.1A
 * Owner review (Blocker 1) — NOT called merely by opening the finance
 * panel: a plain read must never be a financial write. This is called
 * from exactly one place, StartCheckoutButton's own explicit "Tahsilatı
 * Başlat" click (components/appointments/appointment-finance-panel.tsx)
 * — a distinct, auditable user action, not a mount-time side effect. */
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

export type UpdateAppointmentSalePricingInput = {
  saleId: string;
  items: { saleItemId: string; unitPrice: number }[];
  discountAmount: number;
  discountReason?: string;
};

/** Faz FIN.1A Owner review — ONE atomic pricing save, replacing two
 * earlier separate actions (per-item price + discount) whose sequential
 * calls could leave a sale partially edited if a later call failed
 * after an earlier one had already succeeded. items must be the
 * COMPLETE desired price for every one of the sale's current items —
 * the DB RPC independently re-validates this is exactly the sale's
 * real item set (no missing/extra/duplicate ids) and commits every
 * item price plus the discount together, or rejects the whole call
 * with zero rows changed. */
export async function updateAppointmentSalePricingAction(
  _prevState: ActionResult<null> | null,
  input: UpdateAppointmentSalePricingInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = updateAppointmentSalePricingSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz fiyat/indirim");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_appointment_sale_pricing", {
    p_sale_id: parsed.data.saleId,
    p_items: parsed.data.items.map((i) => ({ sale_item_id: i.saleItemId, unit_price: i.unitPrice })),
    p_discount_amount: parsed.data.discountAmount,
    p_discount_reason: parsed.data.discountReason || undefined,
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
