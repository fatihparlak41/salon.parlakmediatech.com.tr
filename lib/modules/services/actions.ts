"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import {
  serviceProfileSchema,
  serviceBranchesSchema,
  serviceStaffSchema,
  serviceStatusSchema,
} from "./schemas";

/** RLS is the actual authorization boundary — see the identical comment in
 * lib/modules/staff/actions.ts. */
function mapWriteError(error: { code?: string; message: string } | null): ActionResult<never> {
  if (error?.code === "42501") {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  if (error?.code === "23505") {
    return fail("CONFLICT", "Bu kayıt zaten mevcut veya çakışıyor");
  }
  return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
}

export type CreateServiceInput = {
  tenantId: string;
  tenantSlug: string;
  name: string;
  category?: string;
  description?: string;
  durationMinutes: number;
  price: string;
  branchIds: string[];
};

export async function createServiceAction(
  _prevState: ActionResult<{ id: string }> | null,
  input: CreateServiceInput,
): Promise<ActionResult<{ id: string }>> {
  await requireUser();

  const parsed = serviceProfileSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .insert({
      tenant_id: input.tenantId,
      name: parsed.data.name,
      category: parsed.data.category || null,
      description: parsed.data.description || null,
      duration_minutes: parsed.data.durationMinutes,
      // Validated as an exact-decimal string above (regex, not coerce) so
      // malformed input is rejected before any float conversion; Postgres
      // numeric(10,2) is the source of truth from here on, this Number()
      // is just satisfying the generated client type for a single
      // realistic currency value, never used in arithmetic.
      price: Number(parsed.data.price),
    })
    .select("id")
    .single();

  if (error || !data) return mapWriteError(error);

  if (input.branchIds.length > 0) {
    const { error: branchError } = await supabase
      .from("service_branches")
      .insert(input.branchIds.map((branchId) => ({ service_id: data.id, branch_id: branchId })));
    if (branchError) {
      revalidatePath(`/app/${input.tenantSlug}/services`);
      return fail(
        "UNEXPECTED",
        "Hizmet oluşturuldu ancak şube ataması başarısız oldu — düzenleyerek tekrar deneyin",
      );
    }
  }

  revalidatePath(`/app/${input.tenantSlug}/services`);
  return ok({ id: data.id });
}

export type UpdateServiceProfileInput = {
  tenantSlug: string;
  serviceId: string;
  name: string;
  category?: string;
  description?: string;
  durationMinutes: number;
  price: string;
};

export async function updateServiceProfileAction(
  _prevState: ActionResult<null> | null,
  input: UpdateServiceProfileInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = serviceProfileSchema
    .omit({ branchIds: true })
    .safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({
      name: parsed.data.name,
      category: parsed.data.category || null,
      description: parsed.data.description || null,
      duration_minutes: parsed.data.durationMinutes,
      price: Number(parsed.data.price),
    })
    .eq("id", input.serviceId);

  if (error) return mapWriteError(error);

  revalidatePath(`/app/${input.tenantSlug}/services`);
  return ok(null);
}

export type UpdateServiceStatusInput = {
  tenantSlug: string;
  serviceId: string;
  status: "active" | "inactive";
};

export async function updateServiceStatusAction(
  _prevState: ActionResult<null> | null,
  input: UpdateServiceStatusInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = serviceStatusSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Geçersiz durum");

  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({ status: parsed.data.status })
    .eq("id", input.serviceId);

  if (error) return mapWriteError(error);

  revalidatePath(`/app/${input.tenantSlug}/services`);
  return ok(null);
}

export type UpdateServiceBranchesInput = {
  tenantSlug: string;
  serviceId: string;
  branchIds: string[];
};

export async function updateServiceBranchesAction(
  _prevState: ActionResult<null> | null,
  input: UpdateServiceBranchesInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = serviceBranchesSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Geçersiz şube listesi");

  const supabase = await createClient();
  const { error: deleteError } = await supabase
    .from("service_branches")
    .delete()
    .eq("service_id", input.serviceId);
  if (deleteError) return mapWriteError(deleteError);

  if (parsed.data.branchIds.length > 0) {
    const { error: insertError } = await supabase
      .from("service_branches")
      .insert(parsed.data.branchIds.map((branchId) => ({ service_id: input.serviceId, branch_id: branchId })));
    if (insertError) return mapWriteError(insertError);
  }

  revalidatePath(`/app/${input.tenantSlug}/services`);
  return ok(null);
}

export type UpdateServiceStaffInput = {
  tenantSlug: string;
  serviceId: string;
  staffMemberIds: string[];
};

/** The "who can perform this service" side of staff_services — same table,
 * same staff.manage RLS gate as updateStaffServicesAction in
 * lib/modules/staff/actions.ts (which writes the inverse, "what can this
 * staff member perform" direction). One relationship, one permission,
 * two ergonomic entry points — not two sources of truth. */
export async function updateServiceStaffAction(
  _prevState: ActionResult<null> | null,
  input: UpdateServiceStaffInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = serviceStaffSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Geçersiz personel listesi");

  const supabase = await createClient();
  const { error: deleteError } = await supabase
    .from("staff_services")
    .delete()
    .eq("service_id", input.serviceId);
  if (deleteError) return mapWriteError(deleteError);

  if (parsed.data.staffMemberIds.length > 0) {
    const { error: insertError } = await supabase
      .from("staff_services")
      .insert(parsed.data.staffMemberIds.map((staffMemberId) => ({ service_id: input.serviceId, staff_member_id: staffMemberId })));
    if (insertError) return mapWriteError(insertError);
  }

  revalidatePath(`/app/${input.tenantSlug}/services`);
  revalidatePath(`/app/${input.tenantSlug}/staff`);
  return ok(null);
}
