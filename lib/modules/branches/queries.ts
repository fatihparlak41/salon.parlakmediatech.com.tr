import "server-only";
import { createClient } from "@/lib/supabase/server";

export type BranchContact = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  whatsappPhone: string | null;
  instagramHandle: string | null;
  locationUrl: string | null;
};

/**
 * Powers the owner-settings "İletişim ve Sosyal Medya" section — every
 * (non-deleted) branch for the tenant, gated by the existing
 * branches_select_member RLS policy (any tenant member can read; only
 * settings.manage can write, see actions.ts — same split as every other
 * settings query/action pair in this codebase). Ordered is_primary
 * desc, name — same convention as get_public_booking_context's own
 * branch ordering (20260822150500), so a single-branch tenant's one row
 * is always first regardless of which API returned it.
 */
export async function getOwnerManagedBranches(tenantId: string): Promise<BranchContact[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("branches")
    .select("id, name, address, phone, whatsapp_phone, instagram_handle, location_url")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .order("name");

  if (error || !data) return [];

  return data.map((b) => ({
    id: b.id,
    name: b.name,
    address: b.address,
    phone: b.phone,
    whatsappPhone: b.whatsapp_phone,
    instagramHandle: b.instagram_handle,
    locationUrl: b.location_url,
  }));
}
