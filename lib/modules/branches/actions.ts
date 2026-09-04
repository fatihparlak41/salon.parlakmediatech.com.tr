"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { branchContactSchema } from "./schemas";
import { normalizeInstagramHandle, normalizeWhatsappPhone } from "./normalize";
import type { BranchContact } from "./queries";

export type UpdateBranchContactInput = {
  branchId: string;
  tenantSlug: string;
  address?: string;
  phone?: string;
  whatsappPhone?: string;
  instagramHandle?: string;
  locationUrl?: string;
};

/**
 * Faz 2I.2F (Batch A). Same shape as updateSelfServicePolicyAction
 * (lib/modules/settings/actions.ts): a direct authenticated UPDATE — RLS
 * is the actual authorization boundary (branches_update_settings_manage,
 * 20260816090004: settings.manage on the row's own tenant_id, already
 * tenant-isolated by construction). No new RPC: that policy already
 * covers these 3 new columns (an unqualified table grant covers every
 * column, including ones added after the grant existed — see the
 * migration's own comment), so a SECURITY DEFINER wrapper here would be
 * an unnecessary extra privileged codepath, not a safer one. No new
 * permission either — settings.manage already governs this exact
 * policy.
 *
 * Values are normalized here, strictly AFTER Zod has validated their
 * raw shape — so what's stored is always the clean canonical form
 * (e.g. "+905338741829", never "+90 533 874 18 29"), never a raw
 * un-normalized echo of whatever the owner typed. `.maybeSingle()` +
 * `data === null` is the ground-truth check: RLS blocks an unauthorized
 * write by matching zero rows, not by raising a Postgres error — same
 * pattern (and same comment) as every other RLS-gated write action in
 * this codebase.
 */
export async function updateBranchContactAction(
  _prevState: ActionResult<BranchContact> | null,
  input: UpdateBranchContactInput,
): Promise<ActionResult<BranchContact>> {
  await requireUser();

  const parsed = branchContactSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("branches")
    .update({
      address: parsed.data.address || null,
      phone: parsed.data.phone || null,
      whatsapp_phone: parsed.data.whatsappPhone ? normalizeWhatsappPhone(parsed.data.whatsappPhone) : null,
      instagram_handle: parsed.data.instagramHandle ? normalizeInstagramHandle(parsed.data.instagramHandle) : null,
      location_url: parsed.data.locationUrl || null,
    })
    .eq("id", parsed.data.branchId)
    .select("id, name, address, phone, whatsapp_phone, instagram_handle, location_url")
    .maybeSingle();

  if (error) {
    return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
  }
  if (!data) {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }

  revalidatePath(`/app/${parsed.data.tenantSlug}/settings`);
  revalidatePath(`/book/${parsed.data.tenantSlug}`);

  return ok({
    id: data.id,
    name: data.name,
    address: data.address,
    phone: data.phone,
    whatsappPhone: data.whatsapp_phone,
    instagramHandle: data.instagram_handle,
    locationUrl: data.location_url,
  });
}
