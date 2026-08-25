"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { customerProfileSchema, customerStatusSchema } from "./schemas";
import { mapLinkErrorCode } from "./link-error-codes";
import { canonicalizeLinkCode, hashLinkCode } from "@/lib/modules/customer-account/link-code";

/** RLS is the actual authorization boundary — see the identical comment
 * in lib/modules/staff/actions.ts and lib/modules/services/actions.ts. */
function mapWriteError(error: { code?: string; message: string } | null): ActionResult<never> {
  if (error?.code === "42501") {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
}

export type CreateCustomerInput = {
  tenantId: string;
  tenantSlug: string;
  fullName: string;
  phone?: string;
  email?: string;
  notes?: string;
};

export async function createCustomerAction(
  _prevState: ActionResult<{ id: string }> | null,
  input: CreateCustomerInput,
): Promise<ActionResult<{ id: string }>> {
  await requireUser();

  const parsed = customerProfileSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .insert({
      tenant_id: input.tenantId,
      full_name: parsed.data.fullName,
      phone: parsed.data.phone || null,
      email: parsed.data.email || null,
      notes: parsed.data.notes || null,
    })
    .select("id")
    .single();

  if (error || !data) return mapWriteError(error);

  revalidatePath(`/app/${input.tenantSlug}/customers`);
  return ok({ id: data.id });
}

export type UpdateCustomerProfileInput = {
  tenantSlug: string;
  customerId: string;
  fullName: string;
  phone?: string;
  email?: string;
  notes?: string;
};

export async function updateCustomerProfileAction(
  _prevState: ActionResult<null> | null,
  input: UpdateCustomerProfileInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = customerProfileSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({
      full_name: parsed.data.fullName,
      phone: parsed.data.phone || null,
      email: parsed.data.email || null,
      notes: parsed.data.notes || null,
    })
    .eq("id", input.customerId);

  if (error) return mapWriteError(error);

  revalidatePath(`/app/${input.tenantSlug}/customers`);
  return ok(null);
}

/**
 * Faz 2G.3.2 — redeems a customer-generated pairing code against ONE
 * specific CRM row the staff member already has legitimate access to.
 * Canonicalizes and hashes the raw code here, in Node, exactly mirroring
 * link-code.ts's own generation-side logic — the raw code never reaches
 * the database, only its hash. If canonicalization fails (wrong length,
 * disallowed characters), this returns the identical generic failure
 * the RPC itself would produce for a wrong code, without spending a
 * round trip — the outcome is indistinguishable either way, matching
 * the enumeration-safety requirement.
 */
export type LinkCustomerAccountInput = {
  tenantSlug: string;
  customerId: string;
  rawCode: string;
};

export async function linkCustomerAccountAction(
  _prevState: ActionResult<null> | null,
  input: LinkCustomerAccountInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const canonical = canonicalizeLinkCode(input.rawCode);
  if (!canonical) {
    return fail("VALIDATION", mapLinkErrorCode("LK003"));
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("link_customer_account_with_code", {
    p_customer_id: input.customerId,
    p_code_hash: hashLinkCode(canonical),
  });

  if (error) {
    return fail("UNEXPECTED", mapLinkErrorCode(error.code));
  }

  revalidatePath(`/app/${input.tenantSlug}/customers`);
  return ok(null);
}

/**
 * Faz 2G.3.2 — the narrow correction path. The database function itself
 * structurally refuses anything but claimed_via='salon_assisted', so
 * there's no separate check needed here — this action is a thin
 * pass-through, matching cancelMyAppointmentAction's own established
 * "the RPC boundary is what actually enforces everything" shape.
 */
export type UnlinkCustomerAccountInput = {
  tenantSlug: string;
  customerId: string;
};

export async function unlinkCustomerAccountAction(
  _prevState: ActionResult<null> | null,
  input: UnlinkCustomerAccountInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase.rpc("unlink_salon_assisted_customer_account", {
    p_customer_id: input.customerId,
  });

  if (error) {
    return fail("UNEXPECTED", mapLinkErrorCode(error.code));
  }

  revalidatePath(`/app/${input.tenantSlug}/customers`);
  return ok(null);
}

export type UpdateCustomerStatusInput = {
  tenantSlug: string;
  customerId: string;
  status: "active" | "archived";
};

export async function updateCustomerStatusAction(
  _prevState: ActionResult<null> | null,
  input: UpdateCustomerStatusInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = customerStatusSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", "Geçersiz durum");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ status: parsed.data.status })
    .eq("id", input.customerId);

  if (error) return mapWriteError(error);

  revalidatePath(`/app/${input.tenantSlug}/customers`);
  return ok(null);
}
