import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fail, ok, type ActionResult } from "@/lib/errors";

/**
 * Faz SAAS.1E.0 — the ONLY way the application changes which login a staff
 * member is attributed to.
 *
 * staff_members.tenant_membership_id can no longer be written through a
 * direct table write: the database refuses any write that CHANGES it unless
 * it comes from a SECURITY DEFINER function
 * (20260921061657_team_authority_hardening.sql). link_staff_membership /
 * unlink_staff_membership check, in the database itself, that the caller
 * holds staff.manage and has authority over the target login, that staff row
 * and membership belong to the same tenant and are live, that an existing
 * link is never overwritten, and that one login is attributed to at most one
 * staff row. Nothing here re-implements those rules — it only calls the
 * RPCs and maps their stable error codes.
 *
 * Takes an already-authenticated client as a parameter (same shape as
 * lib/modules/team/actions.ts's ...Core functions) so it is testable with a
 * real signed-in client outside a Next.js request.
 */

type AnySupabaseClient = SupabaseClient<Database>;

export function mapStaffLinkError(error: { code?: string; message: string } | null): ActionResult<never> {
  switch (error?.message) {
    case "staff_already_linked":
      return fail("CONFLICT", "Bu personel zaten bir hesaba bağlı — önce mevcut bağlantıyı kaldırın");
    case "membership_already_linked":
      return fail("CONFLICT", "Bu hesap zaten başka bir personele bağlı");
    case "staff_member_not_found":
    case "membership_not_found":
    case "staff_not_linked":
      return fail("NOT_FOUND", "Personel veya hesap bulunamadı");
    case "staff_manage_required":
    case "insufficient_authority":
      return fail("UNAUTHORIZED", "Bu hesabın personel bağlantısını değiştirmek için yetkiniz yok");
    default:
      break;
  }
  if (error?.code === "42501") {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  return fail("UNEXPECTED", "Hesap bağlantısı değiştirilemedi, lütfen tekrar deneyin");
}

/**
 * Makes the staff member's login link equal `desiredMembershipId` (null,
 * undefined or "" mean "no login"). "No change" is not a write. Changing a
 * link from A to B is unlink-then-link, because the database never
 * overwrites a link; if the second step is refused, A is put back so the
 * person is not silently left unlinked.
 */
export async function applyStaffMembershipLink(
  supabase: AnySupabaseClient,
  input: { staffMemberId: string; desiredMembershipId: string | null | undefined },
): Promise<ActionResult<null>> {
  const { data: staff, error: readError } = await supabase
    .from("staff_members")
    .select("tenant_id, tenant_membership_id")
    .eq("id", input.staffMemberId)
    .maybeSingle();

  if (readError) return mapStaffLinkError(readError);
  if (!staff) return fail("NOT_FOUND", "Personel bulunamadı");

  const desired = input.desiredMembershipId || null;
  const current = staff.tenant_membership_id;
  if (current === desired) return ok(null);

  if (current !== null) {
    const { error } = await supabase.rpc("unlink_staff_membership", {
      p_tenant_id: staff.tenant_id,
      p_staff_member_id: input.staffMemberId,
    });
    if (error) return mapStaffLinkError(error);
  }

  if (desired !== null) {
    const { error } = await supabase.rpc("link_staff_membership", {
      p_tenant_id: staff.tenant_id,
      p_staff_member_id: input.staffMemberId,
      p_membership_id: desired,
    });
    if (error) {
      if (current !== null) {
        await supabase.rpc("link_staff_membership", {
          p_tenant_id: staff.tenant_id,
          p_staff_member_id: input.staffMemberId,
          p_membership_id: current,
        });
      }
      return mapStaffLinkError(error);
    }
  }

  return ok(null);
}
