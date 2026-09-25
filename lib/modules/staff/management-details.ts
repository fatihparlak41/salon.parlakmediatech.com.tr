import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Faz SAAS.1E.1 — staff_members.email / .phone / .tenant_membership_id are
 * column-restricted to staff.view / staff.manage holders (20260921132701):
 * every tenant member can read a staff member's name/status/colour for the
 * calendar, but not their contact details or login link (that is exactly
 * what Personel/Resepsiyon must not see — see the migration header). This
 * is the one path back to those three fields for an AUTHORIZED caller
 * (staff management screens) — one RPC call per screen load, never one per
 * row, the same convention as customer-display.ts.
 *
 * The generated RPC return type marks email/phone/tenant_membership_id as
 * non-null `string` (a Supabase codegen limitation for RETURNS TABLE), but
 * all three columns are genuinely nullable — treated as such here.
 */

export type StaffManagementDetail = {
  email: string | null;
  phone: string | null;
  tenantMembershipId: string | null;
};

/** The RPC refuses more than 500 ids per call; larger explicit sets are split. */
const RPC_MAX_IDS = 500;

type RpcClient = Pick<SupabaseClient<Database>, "rpc">;

function toDetail(row: { email: string | null; phone: string | null; tenant_membership_id: string | null }): StaffManagementDetail {
  return { email: row.email, phone: row.phone, tenantMembershipId: row.tenant_membership_id };
}

/**
 * `staffMemberIds` omitted (or undefined) means "every staff member of the
 * tenant" — the RPC's own default, one call. An explicit id list is
 * de-duplicated and chunked; a failed or refused chunk simply contributes no
 * entries (callers already treat a missing map entry as "unknown/hidden").
 */
export async function getStaffManagementDetails(
  client: RpcClient,
  tenantId: string,
  staffMemberIds?: readonly string[],
): Promise<Map<string, StaffManagementDetail>> {
  const result = new Map<string, StaffManagementDetail>();

  if (staffMemberIds === undefined) {
    const { data, error } = await client.rpc("get_staff_management_details", { p_tenant_id: tenantId });
    if (error || !data) return result;
    for (const row of data) result.set(row.staff_member_id, toDetail(row));
    return result;
  }

  const ids = Array.from(new Set(staffMemberIds));
  for (let offset = 0; offset < ids.length; offset += RPC_MAX_IDS) {
    const chunk = ids.slice(offset, offset + RPC_MAX_IDS);
    const { data, error } = await client.rpc("get_staff_management_details", { p_tenant_id: tenantId, p_staff_member_ids: chunk });
    if (error || !data) continue;
    for (const row of data) result.set(row.staff_member_id, toDetail(row));
  }
  return result;
}

/** Convenience for a single staff member — same RPC, one-row map. */
export async function getOneStaffManagementDetail(
  client: RpcClient,
  tenantId: string,
  staffMemberId: string,
): Promise<StaffManagementDetail | null> {
  const details = await getStaffManagementDetails(client, tenantId, [staffMemberId]);
  return details.get(staffMemberId) ?? null;
}

/**
 * The staff row (if any) linked to a given membership id, through
 * get_staff_link_for_membership (20260921132701). Free for the caller's own
 * membership id; staff.view/staff.manage required for anyone else's — see
 * that RPC's own comment. Kept in its own wrapper, the same isolation
 * customer-display.ts gives get_appointment_customer_display, so callers
 * with a "plain reads only, no direct .rpc()" contract on their own source
 * (lib/modules/dashboard/queries.ts) can still reach it.
 */
export async function getStaffLinkForMembership(
  client: RpcClient,
  tenantId: string,
  membershipId: string,
): Promise<{ id: string; fullName: string } | null> {
  const { data, error } = await client.rpc("get_staff_link_for_membership", {
    p_tenant_id: tenantId,
    p_membership_id: membershipId,
  });
  if (error || !data || data.length === 0) return null;
  return { id: data[0]!.staff_member_id, fullName: data[0]!.full_name };
}
