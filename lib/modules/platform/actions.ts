"use server";

import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { redirect } from "next/navigation";

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
