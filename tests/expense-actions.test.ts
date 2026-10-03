import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  getTenantAccess: vi.fn(),
  rpc: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: mocks.requireUser,
  getTenantAccess: mocks.getTenantAccess,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import {
  cancelExpenseAction,
  createExpenseAction,
  recordExpensePaymentAction,
  updateExpenseAction,
  voidExpensePaymentAction,
} from "@/lib/modules/expenses/actions";
import { EXPENSE_ERROR_MESSAGES } from "@/lib/modules/expenses/error-codes";

/**
 * Faz FIN.1B.1 — the five Server Actions against a fake Supabase client: the Zod gate, the exact RPC and argument mapping,
 * the tenant resolved server-side, the error mapping and revalidation on success only. No network, no database.
 */

const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SLUG = "bella-hair";
const EXPENSE_ID = "33333333-3333-4333-8333-333333333333";
const PAYMENT_ID = "44444444-4444-4444-8444-444444444444";
const KEY = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "55555555-5555-4555-8555-555555555555";
const PAID_AT = "2026-10-03T09:15:30.123Z";
const WRITE_OK = {
  expenseId: EXPENSE_ID,
  status: "open",
  version: 1,
  noop: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user-1" });
  mocks.getTenantAccess.mockResolvedValue({
    reason: "ok",
    tenant: { id: TENANT_ID, slug: SLUG },
  });
  mocks.createClient.mockResolvedValue({ rpc: mocks.rpc });
  mocks.rpc.mockResolvedValue({ data: WRITE_OK, error: null });
});

const createInput = {
  tenantSlug: SLUG,
  categoryKey: "rent",
  description: " Ekim kirası ",
  expenseDate: "2026-10-01",
  amount: "10000,00",
  idempotencyKey: KEY,
};

describe("createExpenseAction", () => {
  it("authenticates first, validates, and never reaches the database on invalid input", async () => {
    const out = await createExpenseAction(null, {
      ...createInput,
      amount: "1.250,50",
    });
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      success: false,
      error: {
        code: "VALIDATION",
        message: "Binlik ayırıcı kullanmayın; örn. 1250,50 yazın.",
      },
    });
    expect(mocks.getTenantAccess).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("resolves the tenant from the slug on the server and passes ITS id, never a client-supplied one", async () => {
    const forged = {
      ...createInput,
      tenantId: OTHER_TENANT,
    } as typeof createInput;
    const out = await createExpenseAction(null, forged);
    expect(out).toEqual({ success: true, data: WRITE_OK });
    expect(mocks.getTenantAccess).toHaveBeenCalledWith(SLUG);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0]!;
    expect(fn).toBe("create_expense");
    expect(args.p_tenant_id).toBe(TENANT_ID);
    expect(JSON.stringify(args)).not.toContain(OTHER_TENANT);
  });

  it("maps a minimal create to the exact RPC arguments (trimmed, 250,50 as a number, optionals undefined)", async () => {
    await createExpenseAction(null, { ...createInput, amount: "250,50" });
    expect(mocks.rpc).toHaveBeenCalledWith("create_expense", {
      p_tenant_id: TENANT_ID,
      p_category_key: "rent",
      p_description: "Ekim kirası",
      p_expense_date: "2026-10-01",
      p_amount: 250.5,
      p_idempotency_key: KEY,
      p_branch_id: undefined,
      p_vendor_name: undefined,
      p_due_date: undefined,
      p_note: undefined,
      p_initial_payment: undefined,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/app/${SLUG}/finance/expenses`,
    );
  });

  it("maps every optional field and the initial payment (snake_case keys, the dialog's paidAt untouched)", async () => {
    await createExpenseAction(null, {
      ...createInput,
      dueDate: "2026-10-05",
      branchId: BRANCH_ID,
      vendorName: " Mülk Sahibi ",
      note: " not ",
      initialPayment: {
        amount: "100,5",
        method: "card",
        paidAt: PAID_AT,
        note: " ilk ",
      },
    });
    const [, args] = mocks.rpc.mock.calls[0]!;
    expect(args).toMatchObject({
      p_branch_id: BRANCH_ID,
      p_vendor_name: "Mülk Sahibi",
      p_due_date: "2026-10-05",
      p_note: "not",
      p_initial_payment: {
        amount: 100.5,
        method: "card",
        paid_at: PAID_AT,
        note: "ilk",
      },
    });
  });

  it("sends a null initial-payment note as null and Genel (branchId null) as no branch", async () => {
    await createExpenseAction(null, {
      ...createInput,
      branchId: null,
      initialPayment: { amount: 1, method: "cash", paidAt: PAID_AT },
    });
    const [, args] = mocks.rpc.mock.calls[0]!;
    expect(args.p_branch_id).toBeUndefined();
    expect(args.p_initial_payment).toEqual({
      amount: 1,
      method: "cash",
      paid_at: PAID_AT,
      note: null,
    });
  });

  it("a slug that does not resolve for this user is UNAUTHORIZED with the FN002 message, no RPC, no revalidation", async () => {
    for (const reason of ["not_found", "unauthenticated"]) {
      mocks.getTenantAccess.mockResolvedValueOnce({ reason });
      const out = await createExpenseAction(null, createInput);
      expect(out).toEqual({
        success: false,
        error: { code: "UNAUTHORIZED", message: EXPENSE_ERROR_MESSAGES.FN002 },
      });
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("maps an RPC error to the stable code and the expense message, without revalidating", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "FN007", message: "raw english text" },
    });
    const out = await createExpenseAction(null, createInput);
    expect(out).toEqual({
      success: false,
      error: { code: "CONFLICT", message: EXPENSE_ERROR_MESSAGES.FN007 },
    });
    expect(JSON.stringify(out)).not.toContain("raw english");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("an unknown error code (FN010, PostgREST, anything) is the default message as UNEXPECTED", async () => {
    for (const code of ["FN010", "PGRST202", "42501", undefined]) {
      mocks.rpc.mockResolvedValueOnce({
        data: null,
        error: { code, message: "x" },
      });
      const out = await createExpenseAction(null, createInput);
      expect(out).toEqual({
        success: false,
        error: {
          code: "UNEXPECTED",
          message: "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.",
        },
      });
    }
  });

  it("an empty successful response is a failure, not a success with no data", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    const out = await createExpenseAction(null, createInput);
    expect(out.success).toBe(false);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("updateExpenseAction", () => {
  const input = {
    tenantSlug: SLUG,
    expenseId: EXPENSE_ID,
    expectedVersion: 4,
    categoryKey: "rent",
    description: "Kira",
    expenseDate: "2026-10-01",
    amount: 700,
  };

  it("maps the full state plus the expected version and revalidates the page", async () => {
    const out = await updateExpenseAction(null, {
      ...input,
      dueDate: "2026-10-05",
      branchId: BRANCH_ID,
      vendorName: "V",
      note: "N",
    });
    expect(out.success).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("update_expense", {
      p_expense_id: EXPENSE_ID,
      p_category_key: "rent",
      p_description: "Kira",
      p_expense_date: "2026-10-01",
      p_amount: 700,
      p_expected_version: 4,
      p_branch_id: BRANCH_ID,
      p_vendor_name: "V",
      p_due_date: "2026-10-05",
      p_note: "N",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/app/${SLUG}/finance/expenses`,
    );
    // an update never resolves a tenant: the RPC derives it from the expense
    expect(mocks.getTenantAccess).not.toHaveBeenCalled();
  });

  it("an omitted optional field is sent as undefined, which the full-state RPC reads as null (cleared)", async () => {
    await updateExpenseAction(null, input);
    const [, args] = mocks.rpc.mock.calls[0]!;
    expect(args.p_branch_id).toBeUndefined();
    expect(args.p_vendor_name).toBeUndefined();
    expect(args.p_due_date).toBeUndefined();
    expect(args.p_note).toBeUndefined();
  });

  it("rejects a missing or invalid expected version before any RPC", async () => {
    for (const expectedVersion of [undefined, 0, -3, 1.5]) {
      const out = await updateExpenseAction(null, {
        ...input,
        expectedVersion,
      } as typeof input);
      expect(out.success, String(expectedVersion)).toBe(false);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("surfaces a stale version as a CONFLICT with the FN013 message", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "FN013", message: "stale" },
    });
    const out = await updateExpenseAction(null, input);
    expect(out).toEqual({
      success: false,
      error: { code: "CONFLICT", message: EXPENSE_ERROR_MESSAGES.FN013 },
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("cancelExpenseAction", () => {
  it("maps the reason (trimmed) and revalidates", async () => {
    await cancelExpenseAction(null, {
      tenantSlug: SLUG,
      expenseId: EXPENSE_ID,
      reason: "  yanlış giriş ",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("cancel_expense", {
      p_expense_id: EXPENSE_ID,
      p_reason: "yanlış giriş",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/app/${SLUG}/finance/expenses`,
    );
  });

  it("requires a reason", async () => {
    const out = await cancelExpenseAction(null, {
      tenantSlug: SLUG,
      expenseId: EXPENSE_ID,
      reason: "   ",
    });
    expect(out).toEqual({
      success: false,
      error: { code: "VALIDATION", message: "İptal nedeni gerekli" },
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a payment blocks the cancel: FN011 is a CONFLICT with its own message", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "FN011", message: "x" },
    });
    const out = await cancelExpenseAction(null, {
      tenantSlug: SLUG,
      expenseId: EXPENSE_ID,
      reason: "r",
    });
    expect(out).toEqual({
      success: false,
      error: { code: "CONFLICT", message: EXPENSE_ERROR_MESSAGES.FN011 },
    });
  });
});

describe("recordExpensePaymentAction", () => {
  const input = {
    tenantSlug: SLUG,
    expenseId: EXPENSE_ID,
    amount: "250,50",
    method: "cash" as const,
    paidAt: PAID_AT,
    idempotencyKey: KEY,
  };

  it("forwards the dialog's key and instant unchanged and parses the comma amount", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ...WRITE_OK,
        paymentId: PAYMENT_ID,
        status: "partially_paid",
        version: 2,
      },
      error: null,
    });
    const out = await recordExpensePaymentAction(null, {
      ...input,
      note: " nakit ",
    });
    expect(out.success).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("record_expense_payment", {
      p_expense_id: EXPENSE_ID,
      p_amount: 250.5,
      p_method: "cash",
      p_paid_at: PAID_AT,
      p_note: "nakit",
      p_idempotency_key: KEY,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/app/${SLUG}/finance/expenses`,
    );
  });

  it("rejects an invalid method, instant or key before any RPC", async () => {
    for (const patch of [
      { method: "cheque" },
      { paidAt: "2026-10-03" },
      { idempotencyKey: "x" },
      { amount: "0" },
    ]) {
      const out = await recordExpensePaymentAction(null, {
        ...input,
        ...patch,
      } as typeof input);
      expect(out.success, JSON.stringify(patch)).toBe(false);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("an overpayment is a VALIDATION failure with the FN005 message", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "FN005", message: "x" },
    });
    const out = await recordExpensePaymentAction(null, input);
    expect(out).toEqual({
      success: false,
      error: { code: "VALIDATION", message: EXPENSE_ERROR_MESSAGES.FN005 },
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("voidExpensePaymentAction", () => {
  it("maps the payment id and the trimmed reason and revalidates", async () => {
    await voidExpensePaymentAction(null, {
      tenantSlug: SLUG,
      paymentId: PAYMENT_ID,
      reason: " hatalı ",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("void_expense_payment", {
      p_payment_id: PAYMENT_ID,
      p_reason: "hatalı",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/app/${SLUG}/finance/expenses`,
    );
  });

  it("requires a reason and surfaces a missing payment as FN009 NOT_FOUND", async () => {
    const out = await voidExpensePaymentAction(null, {
      tenantSlug: SLUG,
      paymentId: PAYMENT_ID,
      reason: "",
    });
    expect(out.success).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "FN009", message: "x" },
    });
    const missing = await voidExpensePaymentAction(null, {
      tenantSlug: SLUG,
      paymentId: PAYMENT_ID,
      reason: "r",
    });
    expect(missing).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: EXPENSE_ERROR_MESSAGES.FN009 },
    });
  });
});
