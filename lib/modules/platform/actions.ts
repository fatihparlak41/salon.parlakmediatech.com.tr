"use server";

import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { approveTenantOwnerSchema, revokeTenantOwnerApprovalSchema } from "./schemas";
import { mapApprovalError } from "./approval-errors";

const TENANT_STATUSES = ["trial", "active", "suspended", "canceled"] as const;

export async function updateTenantStatusAction(
  formData: FormData,
): Promise<void> {
  await requirePlatformAdmin();

  const tenantId = formData.get("tenantId");
  const status = formData.get("status");

  if (
    typeof tenantId !== "string" ||
    typeof status !== "string" ||
    !TENANT_STATUSES.includes(status as (typeof TENANT_STATUSES)[number])
  ) {
    throw new Error("invalid form input");
  }

  const supabase = await createClient();
  // Allowed by the tenants UPDATE policy for platform_admin (see
  // 20260815120016_rls_policies_identity.sql) — RLS re-checks this
  // server-side regardless of the requirePlatformAdmin() call above.
  const { error } = await supabase
    .from("tenants")
    .update({ status })
    .eq("id", tenantId);

  if (error) {
    throw new Error("status update failed");
  }

  redirect("/super-admin");
}

/**
 * Faz LAUNCH.1A — approve an e-mail address to create ONE salon (the owner
 * -approval gate on create_tenant). requirePlatformAdmin() is only the page
 * door; the RPC re-checks that the caller is a platform OWNER, so a
 * support-level admin who reaches this action is refused by the database.
 */
export async function approveTenantOwnerAction(
  _prevState: ActionResult<{ email: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ email: string }>> {
  await requirePlatformAdmin();

  const parsed = approveTenantOwnerSchema.safeParse({
    email: formData.get("email"),
    note: formData.get("note") ?? "",
    validDays: formData.get("validDays") ?? "30",
  });
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_approve_tenant_owner", {
    p_email: parsed.data.email,
    p_note: parsed.data.note ? parsed.data.note : undefined,
    p_valid_days: parsed.data.validDays,
  });
  if (error) return mapApprovalError(error);

  revalidatePath("/super-admin");
  return ok({ email: data?.[0]?.email ?? parsed.data.email });
}

export async function revokeTenantOwnerApprovalAction(
  _prevState: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  await requirePlatformAdmin();

  const parsed = revokeTenantOwnerApprovalSchema.safeParse({ approvalId: formData.get("approvalId") });
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz istek");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_revoke_tenant_owner_approval", {
    p_approval_id: parsed.data.approvalId,
  });
  if (error) return mapApprovalError(error);

  revalidatePath("/super-admin");
  return ok(null);
}
