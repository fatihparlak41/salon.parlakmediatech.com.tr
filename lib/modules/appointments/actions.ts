"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { mapAppointmentErrorCode } from "./error-codes";
import { createAppointmentSchema, rescheduleAppointmentSchema, appointmentStatusSchema } from "./schemas";

/** Every appointment RPC failure carries a stable AP0nn code
 * (20260822090000) — map that, never the raw message. Falls back to a
 * generic message for anything else (e.g. a genuine network failure). */
function mapRpcError(error: { code?: string; message: string } | null): ActionResult<never> {
  return fail("UNEXPECTED", mapAppointmentErrorCode(error?.code));
}

export type CreateAppointmentInput = {
  tenantSlug: string;
  tenantId: string;
  branchId: string;
  customerId: string;
  items: { serviceId: string; staffMemberId: string; scheduledStartAt: string; sequence: number }[];
  notes?: string;
};

export async function createAppointmentAction(
  _prevState: ActionResult<{ id: string }> | null,
  input: CreateAppointmentInput,
): Promise<ActionResult<{ id: string }>> {
  await requireUser();

  const parsed = createAppointmentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_appointment", {
    p_tenant_id: parsed.data.tenantId,
    p_branch_id: parsed.data.branchId,
    p_customer_id: parsed.data.customerId,
    p_items: parsed.data.items.map((i) => ({
      service_id: i.serviceId,
      staff_member_id: i.staffMemberId,
      scheduled_start_at: i.scheduledStartAt,
      sequence: i.sequence,
    })),
    p_notes: parsed.data.notes || undefined,
    p_source: "salon_staff",
  });

  if (error || !data) return mapRpcError(error);

  revalidatePath(`/app/${input.tenantSlug}/appointments`);
  return ok({ id: data });
}

export type RescheduleAppointmentInput = {
  tenantSlug: string;
  appointmentId: string;
  items: { serviceId: string; staffMemberId: string; scheduledStartAt: string; sequence: number }[];
};

export async function rescheduleAppointmentAction(
  _prevState: ActionResult<null> | null,
  input: RescheduleAppointmentInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = rescheduleAppointmentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reschedule_appointment", {
    p_appointment_id: parsed.data.appointmentId,
    p_items: parsed.data.items.map((i) => ({
      service_id: i.serviceId,
      staff_member_id: i.staffMemberId,
      scheduled_start_at: i.scheduledStartAt,
      sequence: i.sequence,
    })),
  });

  if (error) return mapRpcError(error);

  revalidatePath(`/app/${input.tenantSlug}/appointments`);
  return ok(null);
}

export type UpdateAppointmentStatusInput = {
  tenantSlug: string;
  appointmentId: string;
  status: "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";
};

export async function updateAppointmentStatusAction(
  _prevState: ActionResult<null> | null,
  input: UpdateAppointmentStatusInput,
): Promise<ActionResult<null>> {
  await requireUser();

  const parsed = appointmentStatusSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", "Geçersiz durum");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_appointment_status", {
    p_appointment_id: parsed.data.appointmentId,
    p_new_status: parsed.data.status,
  });

  if (error) return mapRpcError(error);

  revalidatePath(`/app/${input.tenantSlug}/appointments`);
  return ok(null);
}
