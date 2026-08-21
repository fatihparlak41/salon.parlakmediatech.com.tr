"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { customerProfileSchema, customerStatusSchema } from "./schemas";

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
