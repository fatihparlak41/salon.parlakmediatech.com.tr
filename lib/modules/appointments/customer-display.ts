import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Faz SAAS.1E.1 — the ONE way appointment screens obtain a customer's name.
 *
 * Every appointment surface (calendar, list, detail, dashboard "today") used
 * to embed customers(full_name) through PostgREST. That embed is subject to
 * the customers SELECT policy (customers.view), so a member who may see
 * appointments but not the customer directory — Personel — silently got a
 * placeholder, and granting customers.view just to show a name would have
 * exposed phone, e-mail, notes and account linkage too.
 *
 * public.get_appointment_customer_display is the database-authoritative
 * answer: for appointments the caller can already see (appointments.view in
 * the tenant) it returns the customer's DISPLAY NAME and nothing else. This
 * module is a thin, isomorphic wrapper (server components, server actions and
 * browser components all import it — there is deliberately no "server-only"
 * marker): one RPC per screen load, never one per row, and it can only ever
 * degrade to the placeholder, never fail the page.
 */

/** What an appointment surface shows when no name is available. */
export const CUSTOMER_NAME_FALLBACK = "—";

/** The RPC refuses more than 500 ids per call; larger sets are split. */
const RPC_MAX_IDS = 500;

type RpcClient = Pick<SupabaseClient<Database>, "rpc">;

export async function getAppointmentCustomerNames(
  client: RpcClient,
  tenantId: string,
  appointmentIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = Array.from(new Set(appointmentIds));

  for (let offset = 0; offset < ids.length; offset += RPC_MAX_IDS) {
    const { data, error } = await client.rpc("get_appointment_customer_display", {
      p_tenant_id: tenantId,
      p_appointment_ids: ids.slice(offset, offset + RPC_MAX_IDS),
    });
    // A refused or failed lookup (no appointments.view, network) must not
    // take the calendar down: those rows keep the placeholder.
    if (error || !data) continue;
    for (const row of data) {
      names.set(row.appointment_id, row.customer_display_name);
    }
  }

  return names;
}
