import "server-only";
import { createClient } from "@/lib/supabase/server";

export type AccountProfile = {
  fullName: string | null;
  phone: string | null;
  email: string;
};

export type MyAppointmentService = {
  serviceName: string;
  staffName: string;
  durationMinutes: number;
  price: number;
};

export type MyAppointment = {
  appointmentId: string;
  tenantName: string;
  tenantSlug: string;
  tenantTimezone: string;
  branchName: string;
  status: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  services: MyAppointmentService[];
};

/**
 * Both RPCs derive identity exclusively from auth.uid() inside the
 * database (20260822190000) — no id is ever passed as a parameter here,
 * matching the same "never trust a client-supplied id" rule every other
 * query in this codebase follows (see lib/auth/session.ts's own header
 * comment). A null/error result collapses to a safe empty value rather
 * than throwing — this module's callers are Server Components rendering
 * a clean empty state, not places that need a thrown AppError.
 */
export async function getMyAccountProfile(): Promise<AccountProfile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_account_profile");
  if (error || !data) return null;
  return data as unknown as AccountProfile;
}

export async function getMyAppointments(): Promise<MyAppointment[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_appointments");
  if (error || !data) return [];
  return data as unknown as MyAppointment[];
}
