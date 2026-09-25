import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Faz SAAS.1E.1 — the ONE way an appointment surface obtains its NOTES and
 * item PRICE snapshots.
 *
 * appointments.notes and appointment_items.price are no longer selectable
 * columns for `authenticated` (20260921132656) — appointments.view alone
 * (Personel) must not carry them, the same reasoning as customer-display.ts's
 * split from customers.view. get_appointment_private_details is the
 * database-authoritative answer: it additionally requires appointments.update
 * (held by Owner, Yönetici, Resepsiyon — not Personel) before it releases
 * anything; a view-only caller gets `{ visible: false, notes: null, prices: {} }`,
 * never an error, so the detail sheet always renders.
 *
 * One RPC call per detail-sheet open (never per item) — isomorphic (server
 * components, server actions and browser components all import it), can only
 * ever degrade to "hidden", never fail the page.
 */

export type AppointmentPrivateDetails = {
  /** false = the caller may see the appointment but not its private fields (Personel). */
  visible: boolean;
  notes: string | null;
  /** appointment_items.id -> its price snapshot, as text (numeric column). */
  prices: Map<string, string>;
};

const HIDDEN: AppointmentPrivateDetails = { visible: false, notes: null, prices: new Map() };

type RpcClient = Pick<SupabaseClient<Database>, "rpc">;

export async function getAppointmentPrivateDetails(
  client: RpcClient,
  tenantId: string,
  appointmentId: string,
): Promise<AppointmentPrivateDetails> {
  const { data, error } = await client.rpc("get_appointment_private_details", {
    p_tenant_id: tenantId,
    p_appointment_id: appointmentId,
  });
  // A refused or failed lookup must not take the detail sheet down — degrade
  // to hidden, exactly like an unauthorized caller.
  if (error || !data || typeof data !== "object") return HIDDEN;

  const raw = data as { visible?: boolean; notes?: string | null; prices?: Record<string, string> };
  if (!raw.visible) return HIDDEN;

  return {
    visible: true,
    notes: raw.notes ?? null,
    prices: new Map(Object.entries(raw.prices ?? {})),
  };
}
