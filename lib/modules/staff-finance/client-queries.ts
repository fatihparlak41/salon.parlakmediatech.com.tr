/**
 * Faz FIN.1C.1 — client mirror of the period detail read model, called straight from the browser (a pure read: nothing to gate
 * behind requireUser or revalidatePath). The detail sheet fetches get_staff_finance_period when it opens and again after every
 * mutation. The RPC itself is the authority: finance.staff_view required, curated jsonb with no user ids and no staff member
 * id. A failure comes back as { ok: false, code } so the caller can show the module's own message with a retry.
 */
import { createClient } from "@/lib/supabase/client";
import type { StaffPeriodDetail, StaffReadResult } from "./types";

export async function fetchStaffPeriodDetail(
  periodId: string,
  referenceDate: string,
): Promise<StaffReadResult<StaffPeriodDetail>> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_staff_finance_period", {
    p_period_id: periodId,
    p_reference_date: referenceDate,
  });
  if (error || !data) return { ok: false, code: error?.code ?? null };
  return { ok: true, data: data as unknown as StaffPeriodDetail };
}
