import { createClient } from "@/lib/supabase/client";

/**
 * Browser-side call to the one customer reschedule READ RPC
 * (20260823205200). Same createClient() every other client-side query
 * in this codebase uses. Advisory only — never trusted as a hold, see
 * that migration's own header. Never throws for "not eligible right
 * now" reasons (ownership/status/policy/cutoff) or an invalid date,
 * only ever resolves to an empty list, same convention as
 * fetchPublicAvailabilitySlots.
 */
export async function fetchMyRescheduleSlots(appointmentId: string, dateStr: string): Promise<string[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_my_reschedule_slots", {
    p_appointment_id: appointmentId,
    p_date: dateStr,
  });
  if (error || !data) return [];
  return data as unknown as string[];
}
