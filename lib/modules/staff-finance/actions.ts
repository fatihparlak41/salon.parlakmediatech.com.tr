"use server";

import { revalidatePath } from "next/cache";
import { getTenantAccess, requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { mapStaffFinanceErrorCode, staffFinanceFailure } from "./error-codes";
import {
  addStaffLineSchema,
  cancelStaffPeriodSchema,
  createStaffPeriodSchema,
  finalizeStaffPeriodSchema,
  recordStaffPaymentSchema,
  reopenStaffPeriodSchema,
  updateStaffLineSchema,
  updateStaffPeriodSchema,
  voidStaffLineSchema,
  voidStaffPaymentSchema,
} from "./schemas";
import type { StaffPaymentMethod, StaffPaymentPurpose, StaffWriteResult } from "./types";

/**
 * Faz FIN.1C.1 — the ten personnel-ledger Server Actions, all in the FIN.1A / FIN.1B.1 shape: requireUser, Zod parse, ONE RPC
 * call, an ActionResult, and revalidatePath on success. Every RPC failure carries a stable FN0nn code: it is mapped to this
 * module's own message (error-codes.ts), never to the raw text and never to another module's wording. A rejected call returns
 * a failed ActionResult instead of throwing, so the page and the open dialog stay intact (the FIN.1B.1 rehearsal defect).
 *
 * tenantSlug is the authorization-irrelevant routing key: createStaffPeriodAction resolves the tenant from it server-side
 * through getTenantAccess (never a client-supplied tenant id); the other nine act on a period, line or payment id whose tenant
 * the RPC derives and checks itself, and use the slug only to pick the path to revalidate. No action logs an amount, a name or a
 * note, and none returns a file: there is no export in FIN.1C.1.
 */

const pathFor = (tenantSlug: string) => `/app/${tenantSlug}/finance/staff`;
const validationMessage = (parsed: { error: { issues: { message?: string }[] } }, fallback: string) => parsed.error.issues[0]?.message ?? fallback;

export type CreateStaffPeriodInput = {
  tenantSlug: string;
  staffMemberId: string;
  /** The first day of the month, YYYY-MM-01. */
  periodMonth: string;
  dueDate?: string;
  /** One create attempt = one key: the dialog fixes it at mount. */
  idempotencyKey: string;
};

export async function createStaffPeriodAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: CreateStaffPeriodInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = createStaffPeriodSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz dönem"));
  const data = parsed.data;

  // CLAUDE.md: never trust a client-supplied tenant. The slug is re-resolved against the session; a non-member and an
  // unknown slug get the same answer, so nothing confirms that a salon exists.
  const access = await getTenantAccess(data.tenantSlug);
  if (access.reason !== "ok") return fail("UNAUTHORIZED", mapStaffFinanceErrorCode("FN002"));

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("create_staff_finance_period", {
    p_tenant_id: access.tenant.id,
    p_staff_member_id: data.staffMemberId,
    p_period_month: data.periodMonth,
    p_idempotency_key: data.idempotencyKey,
    p_due_date: data.dueDate,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type UpdateStaffPeriodInput = {
  tenantSlug: string;
  periodId: string;
  /** Omitted or blank clears the due date. */
  dueDate?: string;
  /** The version the form was loaded with: a stale one is FN013. */
  expectedVersion: number;
};

export async function updateStaffPeriodAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: UpdateStaffPeriodInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = updateStaffPeriodSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz dönem"));
  const data = parsed.data;

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("update_staff_finance_period", {
    p_period_id: data.periodId,
    // The RPC takes the due date as a required (nullable) argument: null clears it. The generated type calls it a plain string.
    p_due_date: (data.dueDate ?? null) as unknown as string,
    p_expected_version: data.expectedVersion,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type AddStaffLineInput = {
  tenantSlug: string;
  periodId: string;
  kind: string;
  amount: number | string;
  description?: string;
  idempotencyKey: string;
};

export async function addStaffLineAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: AddStaffLineInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = addStaffLineSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz kalem"));
  const data = parsed.data;

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("add_staff_period_line", {
    p_period_id: data.periodId,
    p_kind: data.kind,
    p_amount: data.amount,
    p_description: data.description,
    p_idempotency_key: data.idempotencyKey,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type UpdateStaffLineInput = {
  tenantSlug: string;
  lineId: string;
  amount: number | string;
  /** The desired description: omitted or blank clears it. */
  description?: string;
  expectedVersion: number;
};

/** Edits the amount AND the description of a line as the desired state. Nothing changed with a current version is a noop. */
export async function updateStaffLineAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: UpdateStaffLineInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = updateStaffLineSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz kalem"));
  const data = parsed.data;

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("update_staff_period_line", {
    p_line_id: data.lineId,
    p_amount: data.amount,
    p_description: data.description,
    p_expected_version: data.expectedVersion,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type VoidStaffLineInput = { tenantSlug: string; lineId: string; reason: string; expectedVersion: number };

export async function voidStaffLineAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: VoidStaffLineInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = voidStaffLineSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz iptal nedeni"));

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("void_staff_period_line", {
    p_line_id: parsed.data.lineId,
    p_reason: parsed.data.reason,
    p_expected_version: parsed.data.expectedVersion,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(parsed.data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type FinalizeStaffPeriodInput = { tenantSlug: string; periodId: string; expectedVersion: number };

export async function finalizeStaffPeriodAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: FinalizeStaffPeriodInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = finalizeStaffPeriodSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz dönem"));

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("finalize_staff_finance_period", {
    p_period_id: parsed.data.periodId,
    p_expected_version: parsed.data.expectedVersion,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(parsed.data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type ReopenStaffPeriodInput = { tenantSlug: string; periodId: string; reason: string; expectedVersion: number };

export async function reopenStaffPeriodAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: ReopenStaffPeriodInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = reopenStaffPeriodSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz neden"));

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("reopen_staff_finance_period", {
    p_period_id: parsed.data.periodId,
    p_reason: parsed.data.reason,
    p_expected_version: parsed.data.expectedVersion,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(parsed.data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type CancelStaffPeriodInput = { tenantSlug: string; periodId: string; reason: string };

export async function cancelStaffPeriodAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: CancelStaffPeriodInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = cancelStaffPeriodSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz iptal nedeni"));

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("cancel_staff_finance_period", {
    p_period_id: parsed.data.periodId,
    p_reason: parsed.data.reason,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(parsed.data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type RecordStaffPaymentInput = {
  tenantSlug: string;
  periodId: string;
  purpose: StaffPaymentPurpose;
  amount: number | string;
  method: StaffPaymentMethod;
  /** Fixed by the dialog at mount (with the key): a retried submit must send the identical payload. */
  paidAt: string;
  note?: string;
  idempotencyKey: string;
};

export async function recordStaffPaymentAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: RecordStaffPaymentInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = recordStaffPaymentSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz ödeme"));
  const data = parsed.data;

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("record_staff_payment", {
    p_period_id: data.periodId,
    p_purpose: data.purpose,
    p_amount: data.amount,
    p_method: data.method,
    p_paid_at: data.paidAt,
    p_note: data.note,
    p_idempotency_key: data.idempotencyKey,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}

export type VoidStaffPaymentInput = { tenantSlug: string; paymentId: string; reason: string };

export async function voidStaffPaymentAction(
  _prevState: ActionResult<StaffWriteResult> | null,
  input: VoidStaffPaymentInput,
): Promise<ActionResult<StaffWriteResult>> {
  await requireUser();

  const parsed = voidStaffPaymentSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", validationMessage(parsed, "Geçersiz iptal nedeni"));

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("void_staff_payment", {
    p_payment_id: parsed.data.paymentId,
    p_reason: parsed.data.reason,
  });

  if (error || !result) return staffFinanceFailure(error);

  revalidatePath(pathFor(parsed.data.tenantSlug));
  return ok(result as unknown as StaffWriteResult);
}
