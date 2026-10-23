"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { parseOnboardingStatus, type OnboardingStatus } from "./model";
import { hoursInputSchema, mappingInputSchema, profileInputSchema, serviceRowsSchema, staffRowsSchema } from "./schemas";

/**
 * Faz LAUNCH.1C — Server Actions of the guided setup. Each one validates the SHAPE, calls exactly one RPC and maps
 * the refusal; the RPC is the whole authorization and validation boundary (tenant-scoped permission checks inside),
 * so nothing here widens access. Database text never reaches the user.
 */

export type StepResult = { status: OnboardingStatus; created?: number; skipped?: number };

function mapError(error: { code?: string; message?: string }): ActionResult<never> {
  switch (error.code) {
    case "OB010":
      return fail("UNAUTHENTICATED", "Oturumunuz kapanmış, lütfen tekrar giriş yapın");
    case "OB011":
    case "42501":
      return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
    case "OB004":
      return fail("CONFLICT", "Salon şu anda aktif değil");
    case "OB012":
      return fail("VALIDATION", "Girdiğiniz bilgiler kabul edilmedi, lütfen kontrol edin");
    default:
      return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
  }
}

function finish(tenantSlug: string, data: unknown): ActionResult<StepResult> {
  revalidatePath(`/app/${tenantSlug}`, "layout");
  const record = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  // bulk RPCs answer { created, skipped, status }; the others answer the status itself
  const statusRaw = "status" in record && record.status !== undefined ? record.status : data;
  const status = parseOnboardingStatus(statusRaw);
  if (!status) return fail("UNEXPECTED", "Kurulum durumu okunamadı, sayfayı yenileyin");
  return ok({
    status,
    created: typeof record.created === "number" ? record.created : undefined,
    skipped: typeof record.skipped === "number" ? record.skipped : undefined,
  });
}

export async function saveSalonProfileAction(
  _prev: ActionResult<StepResult> | null,
  input: unknown,
): Promise<ActionResult<StepResult>> {
  await requireUser();
  const parsed = profileInputSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_salon_profile", {
    p_tenant_id: parsed.data.tenantId,
    p_name: parsed.data.name,
    p_timezone: parsed.data.timezone,
    p_currency: parsed.data.currency,
    p_phone: parsed.data.phone,
    p_address: parsed.data.address ?? "",
  });
  if (error) return mapError(error);
  return finish(parsed.data.tenantSlug, data);
}

export async function addServicesAction(
  _prev: ActionResult<StepResult> | null,
  input: unknown,
): Promise<ActionResult<StepResult>> {
  await requireUser();
  const parsed = serviceRowsSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("onboarding_add_services", {
    p_tenant_id: parsed.data.tenantId,
    p_items: parsed.data.items.map((i) => ({
      name: i.name,
      category: i.category ?? "",
      durationMinutes: i.durationMinutes,
      price: i.price,
    })),
  });
  if (error) return mapError(error);
  return finish(parsed.data.tenantSlug, data);
}

export async function addStaffAction(
  _prev: ActionResult<StepResult> | null,
  input: unknown,
): Promise<ActionResult<StepResult>> {
  await requireUser();
  const parsed = staffRowsSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("onboarding_add_staff", {
    p_tenant_id: parsed.data.tenantId,
    p_items: parsed.data.items.map((i) => ({ fullName: i.fullName, phone: i.phone ?? "" })),
  });
  if (error) return mapError(error);
  return finish(parsed.data.tenantSlug, data);
}

export async function applyWeeklyHoursAction(
  _prev: ActionResult<StepResult> | null,
  input: unknown,
): Promise<ActionResult<StepResult>> {
  await requireUser();
  const parsed = hoursInputSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("onboarding_apply_weekly_hours", {
    p_tenant_id: parsed.data.tenantId,
    p_staff_ids: parsed.data.staffIds,
    p_days: parsed.data.days,
  });
  if (error) return mapError(error);
  return finish(parsed.data.tenantSlug, data);
}

export async function setStaffServicesAction(
  _prev: ActionResult<StepResult> | null,
  input: unknown,
): Promise<ActionResult<StepResult>> {
  await requireUser();
  const parsed = mappingInputSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("onboarding_set_staff_services", {
    p_tenant_id: parsed.data.tenantId,
    p_assignments: parsed.data.assignments,
  });
  if (error) return mapError(error);
  return finish(parsed.data.tenantSlug, data);
}
