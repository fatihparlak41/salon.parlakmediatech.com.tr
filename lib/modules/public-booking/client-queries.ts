import { createClient } from "@/lib/supabase/client";

/**
 * Browser-side calls to the 3 public booking READ RPCs
 * (20260822150500_public_booking_functions.sql). Deliberately the same
 * createClient() every other client-side query in this codebase uses —
 * not a special "force anon" client. Supabase Auth session storage is
 * per-browser-origin, not per-route, so a staff member who is logged
 * into /app/their-salon and opens /book/their-salon in the same browser
 * would have their session attached regardless; these RPCs are granted
 * to both anon and authenticated for exactly this reason (see the
 * migration's header comment), so this client works identically either
 * way. Every function here returns a best-effort parsed shape; these
 * read RPCs never throw for "just not bookable" states, only ever
 * resolve to an empty/false result (see error-codes.ts for the one
 * function that does throw).
 *
 * create_guest_booking (the mutation) is NOT called from here as of
 * Phase 2F.2 — anon/authenticated no longer have EXECUTE on it at all
 * (20260822170000). The only path to it now is the server-side gateway,
 * lib/modules/public-booking/actions.ts's submitGuestBookingAction,
 * which verifies Turnstile before ever reaching the database.
 */

export type PublicBookingService = {
  id: string;
  name: string;
  category: string | null;
  durationMinutes: number;
  // A genuine JSON number here, not a string: this comes from
  // jsonb_build_object('price', s.price, ...) inside the RPC, which
  // serializes `numeric` as a JSON number — unlike a plain PostgREST
  // column response, where numeric normally arrives as a string.
  price: number;
};

export type PublicBookingBranch = {
  id: string;
  name: string;
  address: string | null;
  services: PublicBookingService[];
};

export type PublicBookingContext =
  | { bookable: false }
  | {
      bookable: true;
      salon: { name: string; slug: string; timezone: string };
      branches: PublicBookingBranch[];
    };

export type PublicBookingStaffOption = { id: string; fullName: string };

export type GuestBookingConfirmation = {
  appointmentReference: string;
  branchName: string;
  serviceName: string;
  staffName: string;
  scheduledStartAt: string;
  durationMinutes: number;
  price: number; // see PublicBookingService.price — same jsonb_build_object numeric-serialization behavior
  tenantTimezone: string;
  // Faz 2G.3.1 — whether this booking opted into account linking AND a
  // claim capability was actually issued (email present, not an
  // authenticated booker — see gateway.ts). Safe to expose: reveals
  // nothing beyond "you may want to check your email", never anything
  // about the claim secret/row itself. BookingWizard uses this only to
  // show/hide a short note on the success screen.
  claimIssued: boolean;
};

export async function fetchPublicBookingContext(tenantSlug: string): Promise<PublicBookingContext> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_public_booking_context", { p_tenant_slug: tenantSlug });
  if (error || !data) return { bookable: false };
  return data as unknown as PublicBookingContext;
}

export async function fetchPublicEligibleStaff(
  tenantSlug: string,
  branchId: string,
  serviceId: string,
): Promise<PublicBookingStaffOption[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_public_eligible_staff", {
    p_tenant_slug: tenantSlug,
    p_branch_id: branchId,
    p_service_id: serviceId,
  });
  if (error || !data) return [];
  return data as unknown as PublicBookingStaffOption[];
}

/** staffMemberId: undefined/null means "Personel fark etmez" — resolved
 * server-side, never guessed client-side (see the migration's "any
 * staff" loop in create_guest_booking). */
export async function fetchPublicAvailabilitySlots(
  tenantSlug: string,
  branchId: string,
  serviceId: string,
  dateStr: string,
  staffMemberId?: string | null,
): Promise<string[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_public_availability_slots", {
    p_tenant_slug: tenantSlug,
    p_branch_id: branchId,
    p_service_id: serviceId,
    p_date: dateStr,
    p_staff_member_id: staffMemberId ?? undefined,
  });
  if (error || !data) return [];
  return data as unknown as string[];
}

