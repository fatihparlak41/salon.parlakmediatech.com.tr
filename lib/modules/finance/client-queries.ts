/**
 * Faz FIN.1A — client mirror of the finance read model. Called directly
 * from appointment-detail-sheet.tsx (same "fetch on sheet open" pattern
 * as loadAppointmentDetail there) rather than through a Server Action,
 * since it is a pure read with no mutation to gate behind requireUser +
 * revalidatePath. The RPC itself (private.get_appointment_sale_for_appointment)
 * is the real authority: finance.view required, hand-curated PII-free
 * jsonb shape — see the migration's own header for the full rationale.
 */
import { createClient } from "@/lib/supabase/client";

export type AppointmentSaleItem = {
  id: string;
  appointmentItemId: string;
  serviceName: string;
  unitPrice: number;
};

export type AppointmentSalePayment = {
  id: string;
  amount: number;
  method: "cash" | "card" | "bank_transfer" | "other";
  paidAt: string;
  note: string | null;
  status: "posted" | "voided";
  voidReason: string | null;
};

export type AppointmentFinanceSummary = {
  id: string;
  appointmentId: string;
  currency: string;
  subtotal: number;
  discountAmount: number;
  totalAmount: number;
  collected: number;
  outstanding: number;
  status: "open" | "partially_paid" | "paid" | "voided";
  items: AppointmentSaleItem[];
  payments: AppointmentSalePayment[];
};

/** Returns null both when the caller lacks finance.view (fails closed,
 * same as any other permission-gated read in this codebase) and when no
 * sale has been created yet for this appointment (checkout never
 * opened) — the finance panel treats both identically: nothing to show
 * yet. A real error (network failure) is also folded into null here,
 * since the panel's only reaction to "no data" is the same empty state
 * either way. */
export async function fetchAppointmentFinanceSummary(
  appointmentId: string,
): Promise<AppointmentFinanceSummary | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_appointment_sale_for_appointment", {
    p_appointment_id: appointmentId,
  });
  if (error || !data) return null;
  return data as unknown as AppointmentFinanceSummary;
}
