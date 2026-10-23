"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { fail, type ActionResult } from "@/lib/errors";
import { requireUser } from "@/lib/auth/session";
import { createTenantSchema } from "./schemas";
import { TENANT_PROVISIONING_NOT_APPROVED_MESSAGE, isTenantProvisioningNotApprovedError } from "./provisioning";

/**
 * Client validates the slug against lib/tenancy/reserved-slugs.ts (fast
 * feedback); this re-validates the same rule server-side before ever
 * calling the RPC. The RPC (private.create_tenant_with_owner) re-checks
 * format + a reserved-word list again at the database layer — the final,
 * non-bypassable gate. See that migration's comment for why all three
 * layers exist.
 */
export async function createTenantAction(
  _prevState: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = createTenantSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });

  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz form",
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_tenant", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
  });

  if (error) {
    // Faz LAUNCH.1A: the database refuses everyone without an owner approval
    // (or a platform-admin row) before it looks at the slug, so this is also
    // the answer for an unapproved caller who typed an already-taken slug.
    if (isTenantProvisioningNotApprovedError(error)) {
      return fail("UNAUTHORIZED", TENANT_PROVISIONING_NOT_APPROVED_MESSAGE);
    }
    if (error.code === "23505") {
      return fail("CONFLICT", "Bu adres zaten kullanımda");
    }
    return fail("UNEXPECTED", "Salon oluşturulamadı, lütfen tekrar deneyin");
  }

  redirect(`/app/${parsed.data.slug}`);
}
