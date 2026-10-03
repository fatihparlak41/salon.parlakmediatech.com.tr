"use server";

import { revalidatePath } from "next/cache";
import { getTenantAccess, requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { expenseFailure, mapExpenseErrorCode } from "./error-codes";
import {
  cancelExpenseSchema,
  createExpenseSchema,
  recordExpensePaymentSchema,
  updateExpenseSchema,
  voidExpensePaymentSchema,
} from "./schemas";
import type { ExpensePaymentMethod, ExpenseWriteResult } from "./types";

/**
 * Faz FIN.1B.1 — the five expense Server Actions, all in the FIN.1A shape: requireUser, Zod parse, ONE RPC call, an
 * ActionResult, and revalidatePath on success. Every RPC failure carries a stable FN0nn code: it is mapped to the expense
 * module's own message (error-codes.ts), never to the raw text and never to the appointment finance wording.
 *
 * tenantSlug is the authorization-irrelevant routing key: createExpenseAction resolves the tenant from it server-side
 * through getTenantAccess (never a client-supplied tenant id); the other four act on an expense or payment id whose tenant
 * the RPC derives and checks itself, and use the slug only to pick the path to revalidate.
 */

const pathFor = (tenantSlug: string) => `/app/${tenantSlug}/finance/expenses`;

export type InitialExpensePaymentInput = {
  amount: number | string;
  method: ExpensePaymentMethod;
  paidAt: string;
  note?: string;
};

export type CreateExpenseInput = {
  tenantSlug: string;
  categoryKey: string;
  description: string;
  expenseDate: string;
  amount: number | string;
  dueDate?: string;
  /** null or omitted: Genel (no branch). */
  branchId?: string | null;
  vendorName?: string;
  note?: string;
  /** One create attempt = one key: the dialog fixes it at mount. */
  idempotencyKey: string;
  initialPayment?: InitialExpensePaymentInput;
};

/** Creates an expense, optionally with one initial payment in the SAME transaction (a payment failure rolls the expense back). */
export async function createExpenseAction(
  _prevState: ActionResult<ExpenseWriteResult> | null,
  input: CreateExpenseInput,
): Promise<ActionResult<ExpenseWriteResult>> {
  await requireUser();

  const parsed = createExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz gider",
    );
  }
  const data = parsed.data;

  // CLAUDE.md: never trust a client-supplied tenant. The slug is re-resolved against the session; a non-member and an
  // unknown slug get the same answer, so nothing confirms that a salon exists.
  const access = await getTenantAccess(data.tenantSlug);
  if (access.reason !== "ok")
    return fail("UNAUTHORIZED", mapExpenseErrorCode("FN002"));

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("create_expense", {
    p_tenant_id: access.tenant.id,
    p_category_key: data.categoryKey,
    p_description: data.description,
    p_expense_date: data.expenseDate,
    p_amount: data.amount,
    p_idempotency_key: data.idempotencyKey,
    p_branch_id: data.branchId ?? undefined,
    p_vendor_name: data.vendorName,
    p_due_date: data.dueDate,
    p_note: data.note,
    p_initial_payment: data.initialPayment
      ? {
          amount: data.initialPayment.amount,
          method: data.initialPayment.method,
          paid_at: data.initialPayment.paidAt,
          note: data.initialPayment.note ?? null,
        }
      : undefined,
  });

  if (error || !result) return expenseFailure(error);

  revalidatePath(pathFor(data.tenantSlug));
  return ok(result as unknown as ExpenseWriteResult);
}

export type UpdateExpenseInput = {
  tenantSlug: string;
  expenseId: string;
  /** The version the form was loaded with: a stale one is FN013. */
  expectedVersion: number;
  categoryKey: string;
  description: string;
  expenseDate: string;
  amount: number | string;
  dueDate?: string;
  branchId?: string | null;
  vendorName?: string;
  note?: string;
};

/** Full-state edit: every field is sent, an omitted optional one clears it. Nothing changed with a current version is a noop. */
export async function updateExpenseAction(
  _prevState: ActionResult<ExpenseWriteResult> | null,
  input: UpdateExpenseInput,
): Promise<ActionResult<ExpenseWriteResult>> {
  await requireUser();

  const parsed = updateExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz gider",
    );
  }
  const data = parsed.data;

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("update_expense", {
    p_expense_id: data.expenseId,
    p_category_key: data.categoryKey,
    p_description: data.description,
    p_expense_date: data.expenseDate,
    p_amount: data.amount,
    p_expected_version: data.expectedVersion,
    p_branch_id: data.branchId ?? undefined,
    p_vendor_name: data.vendorName,
    p_due_date: data.dueDate,
    p_note: data.note,
  });

  if (error || !result) return expenseFailure(error);

  revalidatePath(pathFor(data.tenantSlug));
  return ok(result as unknown as ExpenseWriteResult);
}

export type CancelExpenseInput = {
  tenantSlug: string;
  expenseId: string;
  reason: string;
};

export async function cancelExpenseAction(
  _prevState: ActionResult<ExpenseWriteResult> | null,
  input: CancelExpenseInput,
): Promise<ActionResult<ExpenseWriteResult>> {
  await requireUser();

  const parsed = cancelExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz iptal nedeni",
    );
  }

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("cancel_expense", {
    p_expense_id: parsed.data.expenseId,
    p_reason: parsed.data.reason,
  });

  if (error || !result) return expenseFailure(error);

  revalidatePath(pathFor(parsed.data.tenantSlug));
  return ok(result as unknown as ExpenseWriteResult);
}

export type RecordExpensePaymentInput = {
  tenantSlug: string;
  expenseId: string;
  amount: number | string;
  method: ExpensePaymentMethod;
  /** Fixed by the dialog at mount (with the key): a retried submit must send the identical payload. */
  paidAt: string;
  note?: string;
  idempotencyKey: string;
};

export async function recordExpensePaymentAction(
  _prevState: ActionResult<ExpenseWriteResult> | null,
  input: RecordExpensePaymentInput,
): Promise<ActionResult<ExpenseWriteResult>> {
  await requireUser();

  const parsed = recordExpensePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz ödeme",
    );
  }
  const data = parsed.data;

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("record_expense_payment", {
    p_expense_id: data.expenseId,
    p_amount: data.amount,
    p_method: data.method,
    p_paid_at: data.paidAt,
    p_note: data.note,
    p_idempotency_key: data.idempotencyKey,
  });

  if (error || !result) return expenseFailure(error);

  revalidatePath(pathFor(data.tenantSlug));
  return ok(result as unknown as ExpenseWriteResult);
}

export type VoidExpensePaymentInput = {
  tenantSlug: string;
  paymentId: string;
  reason: string;
};

export async function voidExpensePaymentAction(
  _prevState: ActionResult<ExpenseWriteResult> | null,
  input: VoidExpensePaymentInput,
): Promise<ActionResult<ExpenseWriteResult>> {
  await requireUser();

  const parsed = voidExpensePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz iptal nedeni",
    );
  }

  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("void_expense_payment", {
    p_payment_id: parsed.data.paymentId,
    p_reason: parsed.data.reason,
  });

  if (error || !result) return expenseFailure(error);

  revalidatePath(pathFor(parsed.data.tenantSlug));
  return ok(result as unknown as ExpenseWriteResult);
}
