"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import {
  staffProfileSchema,
  staffBranchesSchema,
  staffServicesSchema,
  staffScheduleSchema,
  staffExceptionSchema,
  staffStatusSchema,
} from "./schemas";

/** RLS is the actual authorization boundary for all of these (plain
 * table grants gated by has_permission() policies, 20260819052317 etc.)
 * — no separate hasPermission() pre-check here, just a clean mapping of
 * whatever Postgres rejects the write with. 42501 = insufficient_privilege,
 * the RLS-denial code. */
function mapWriteError(error: { code?: string; message: string } | null): ActionResult<never> {
  if (error?.code === "42501") {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  if (error?.code === "23505") {
    return fail("CONFLICT", "Bu kayıt zaten mevcut veya çakışıyor");
  }
  return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
}

export type CreateStaffInput = {
  tenantId: string;
  tenantSlug: string;
  fullName: string;
  email?: string;
  phone?: string;
  branchIds: string[];
  tenantMembershipId?: string;
};

export async function createStaffMemberAction(
  _prevState: ActionResult<{ id: string }> | null,
  input: CreateStaffInput,
): Promise<ActionResult<{ id: string }>> {
  await requireUser();

  const parsed = staffProfileSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_members")
    .insert({
      tenant_id: input.tenantId,
      full_name: parsed.data.fullName,
      email: parsed.data.email || null,
      phone: parsed.data.phone || null,
      tenant_membership_id: parsed.data.tenantMembershipId || null,
    })
    .select("id")
    .single();

  if (error || !data) {
    return mapWriteError(error);
  }

  if (input.branchIds.length > 0) {
    const { error: branchError } = await supabase
      .from("staff_branches")
      .insert(input.branchIds.map((branchId) => ({ staff_member_id: data.id, branch_id: branchId })));
    if (branchError) {
      revalidatePath(`/app/${input.tenantSlug}/staff`);
      return fail(
        "UNEXPECTED",
        "Personel oluşturuldu ancak şube ataması başarısız oldu — düzenleyerek tekrar deneyin",
      );
    }
  }

  revalidatePath(`/app/${input.tenantSlug}/staff`);
  return ok({ id: data.id });
}

export type UpdateStaffProfileInput = {
  tenantSlug: string;
  staffMemberId: string;
  fullName: string;
  email?: string;
  phone?: string;
  tenantMembershipId?: string;
};

export async function updateStaffProfileAction(
  _prevState: ActionResult<null> | null,
  input: UpdateStaffProfileInput,
): Promise<ActionResult<null>> {
  await requireUser();

  // staffProfileSchema also requires branchIds (the create-flow shape) —
  // updates never send that field, so validate against the same schema
  // minus that one field rather than a second near-duplicate schema.
  const parsed = staffProfileSchema.omit({ branchIds: true }).safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("staff_members")
    .update({
      full_name: parsed.data.fullName,
      email: parsed.data.email || null,
      phone: parsed.data.phone || null,
      tenant_membership_id: parsed.data.tenantMembershipId || null,
    })
    .eq("id", input.staffMemberId);

  if (error) return mapWriteError(error);

  revalidatePath(`/app/${input.tenantSlug}/staff`);
  return ok(null);
}

export type UpdateStaffStatusInput = {
  tenantSlug: string;
  staffMemberId: string;
  status: "active" | "inactive";
};

export async function updateStaffStatusAction(
  _prevState: ActionResult<null> | null,
  input: UpdateStaffStatusInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = staffStatusSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", "Geçersiz durum");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("staff_members")
    .update({ status: parsed.data.status })
    .eq("id", input.staffMemberId);

  if (error) return mapWriteError(error);

  revalidatePath(`/app/${input.tenantSlug}/staff`);
  return ok(null);
}

export type UpdateStaffBranchesInput = {
  tenantSlug: string;
  staffMemberId: string;
  branchIds: string[];
};

/** Full replace, same semantics as reschedule_appointment's item list —
 * the caller always sends the complete desired set, not a diff. */
export async function updateStaffBranchesAction(
  _prevState: ActionResult<null> | null,
  input: UpdateStaffBranchesInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = staffBranchesSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", "Geçersiz şube listesi");
  }

  const supabase = await createClient();
  const { error: deleteError } = await supabase
    .from("staff_branches")
    .delete()
    .eq("staff_member_id", input.staffMemberId);
  if (deleteError) return mapWriteError(deleteError);

  if (parsed.data.branchIds.length > 0) {
    const { error: insertError } = await supabase
      .from("staff_branches")
      .insert(parsed.data.branchIds.map((branchId) => ({ staff_member_id: input.staffMemberId, branch_id: branchId })));
    if (insertError) return mapWriteError(insertError);
  }

  revalidatePath(`/app/${input.tenantSlug}/staff`);
  return ok(null);
}

export type UpdateStaffServicesInput = {
  tenantSlug: string;
  staffMemberId: string;
  serviceIds: string[];
};

export async function updateStaffServicesAction(
  _prevState: ActionResult<null> | null,
  input: UpdateStaffServicesInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = staffServicesSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", "Geçersiz hizmet listesi");
  }

  const supabase = await createClient();
  const { error: deleteError } = await supabase
    .from("staff_services")
    .delete()
    .eq("staff_member_id", input.staffMemberId);
  if (deleteError) return mapWriteError(deleteError);

  if (parsed.data.serviceIds.length > 0) {
    const { error: insertError } = await supabase
      .from("staff_services")
      .insert(parsed.data.serviceIds.map((serviceId) => ({ staff_member_id: input.staffMemberId, service_id: serviceId })));
    if (insertError) return mapWriteError(insertError);
  }

  revalidatePath(`/app/${input.tenantSlug}/staff`);
  return ok(null);
}

export type UpdateStaffScheduleInput = {
  tenantSlug: string;
  tenantId: string;
  staffMemberId: string;
  rows: { weekday: number; branchId: string | null; startTime: string; endTime: string }[];
};

export async function updateStaffScheduleAction(
  _prevState: ActionResult<null> | null,
  input: UpdateStaffScheduleInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = staffScheduleSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz çalışma programı");
  }

  const supabase = await createClient();
  // staff_schedules only has SELECT/INSERT/UPDATE grants — no DELETE
  // (20260819052446) — so "full replace" here soft-deletes the old rows
  // via the table's existing deleted_at column instead of hard-deleting.
  // Reads already filter deleted_at is null (queries.ts) and the unique
  // constraints are partial on deleted_at is null, so this is a drop-in
  // substitute, not a workaround, and it happens to preserve schedule
  // history for free.
  const { error: deleteError } = await supabase
    .from("staff_schedules")
    .update({ deleted_at: new Date().toISOString() })
    .eq("staff_member_id", input.staffMemberId)
    .is("deleted_at", null);
  if (deleteError) return mapWriteError(deleteError);

  if (parsed.data.rows.length > 0) {
    const { error: insertError } = await supabase.from("staff_schedules").insert(
      parsed.data.rows.map((r) => ({
        tenant_id: input.tenantId,
        staff_member_id: input.staffMemberId,
        branch_id: r.branchId,
        weekday: r.weekday,
        start_time: r.startTime,
        end_time: r.endTime,
      })),
    );
    if (insertError) return mapWriteError(insertError);
  }

  revalidatePath(`/app/${input.tenantSlug}/staff`);
  return ok(null);
}

export type CreateStaffExceptionInput = {
  tenantSlug: string;
  tenantId: string;
  staffMemberId: string;
  exceptionDate: string;
  type: "unavailable" | "custom_hours";
  startTime?: string;
  endTime?: string;
  reason?: string;
};

export async function createStaffExceptionAction(
  _prevState: ActionResult<null> | null,
  input: CreateStaffExceptionInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = staffExceptionSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz istisna");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("staff_schedule_exceptions").insert({
    tenant_id: input.tenantId,
    staff_member_id: input.staffMemberId,
    exception_date: parsed.data.exceptionDate,
    type: parsed.data.type,
    start_time: parsed.data.startTime || null,
    end_time: parsed.data.endTime || null,
    reason: parsed.data.reason || null,
  });

  if (error) {
    if (error.code === "23505") {
      return fail("CONFLICT", "Bu tarih için zaten bir istisna tanımlı");
    }
    return mapWriteError(error);
  }

  revalidatePath(`/app/${input.tenantSlug}/staff`);
  return ok(null);
}

export async function deleteStaffExceptionAction(
  tenantSlug: string,
  exceptionId: string,
): Promise<ActionResult<null>> {
  await requireUser();

  const supabase = await createClient();
  // Same reason as updateStaffScheduleAction above: staff_schedule_exceptions
  // has no DELETE grant either, and the partial unique index
  // (staff_member_id, exception_date) where deleted_at is null already
  // makes soft-delete behave exactly like a real removal for booking
  // purposes — a new exception for the same date becomes insertable again.
  const { error } = await supabase
    .from("staff_schedule_exceptions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", exceptionId);

  if (error) return mapWriteError(error);

  revalidatePath(`/app/${tenantSlug}/staff`);
  return ok(null);
}
