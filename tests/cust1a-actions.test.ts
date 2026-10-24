/**
 * Faz CUST.1A — the import Server Actions with the Supabase client replaced by a recording fake. The RPCs are the
 * authorization and classification boundary (tested against the real database); here: the shape is validated before any
 * call, exactly the validated rows are passed, refusals become plain messages, and a malformed answer is never trusted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const requireUser = vi.fn();
const revalidatePath = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

import { commitCustomerImportAction, previewCustomerImportAction } from "@/lib/modules/customers/import-actions";

const TENANT = "11111111-1111-4111-8111-111111111111";
const rows = [{ row: 2, name: "Sentetik Kisi", phone: "0533 111 22 33", email: "" }];
const previewAnswer = {
  maxRows: 5000,
  summary: { total: 1, new: 1, matchExisting: 0, invalid: 0, ambiguous: 0, willFillPhone: 0, willFillEmail: 0 },
  rows: [{ row: 2, status: "NEW", reason: null, existingName: null, fillPhone: false, fillEmail: false }],
};
const commitAnswer = { summary: { total: 1, created: 1, matchExisting: 0, filledPhone: 0, filledEmail: 0, skippedInvalid: 0, skippedAmbiguous: 0 }, rows: [] };

beforeEach(() => {
  rpc.mockReset();
  requireUser.mockReset();
  revalidatePath.mockReset();
  requireUser.mockResolvedValue({ id: "user" });
});

describe("customer import actions", () => {
  it("require a signed-in user first", async () => {
    requireUser.mockRejectedValue(new Error("redirect to login"));
    await expect(previewCustomerImportAction(null, { tenantId: TENANT, tenantSlug: "s", rows })).rejects.toThrow("redirect to login");
    await expect(commitCustomerImportAction(null, { tenantId: TENANT, tenantSlug: "s", rows })).rejects.toThrow("redirect to login");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("pass exactly the validated rows; commit refreshes the customer list; preview does not", async () => {
    rpc.mockResolvedValueOnce({ data: previewAnswer, error: null });
    const p = await previewCustomerImportAction(null, { tenantId: TENANT, tenantSlug: "ornek", rows });
    expect(p.success).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("preview_customer_import", { p_tenant_id: TENANT, p_rows: rows });
    expect(revalidatePath).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({ data: commitAnswer, error: null });
    const c = await commitCustomerImportAction(null, { tenantId: TENANT, tenantSlug: "ornek", rows });
    expect(c.success).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("commit_customer_import", { p_tenant_id: TENANT, p_rows: rows });
    expect(revalidatePath).toHaveBeenCalledWith("/app/ornek/customers");
  });

  it("refuse a malformed request before the database: bad tenant id, no rows, too many rows, a non-numeric row number", async () => {
    const bad: unknown[] = [
      { tenantId: "x", tenantSlug: "s", rows },
      { tenantId: TENANT, tenantSlug: "s", rows: [] },
      { tenantId: TENANT, tenantSlug: "s", rows: Array.from({ length: 5001 }, (_, i) => ({ row: i + 1, name: "a", phone: "1", email: "" })) },
      { tenantId: TENANT, tenantSlug: "s", rows: [{ row: "2", name: "a", phone: "", email: "" }] },
      null,
    ];
    for (const input of bad) {
      expect((await previewCustomerImportAction(null, input)).success).toBe(false);
      expect((await commitCustomerImportAction(null, input)).success).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("map each refusal to a plain message and never show database text", async () => {
    const cases: [string, string][] = [
      ["CI011", "UNAUTHORIZED"],
      ["42501", "UNAUTHORIZED"],
      ["CI010", "UNAUTHENTICATED"],
      ["CI012", "VALIDATION"],
      ["XX000", "UNEXPECTED"],
    ];
    for (const [code, appCode] of cases) {
      rpc.mockResolvedValueOnce({ data: null, error: { code, message: 'relation "public.customers" violates something' } });
      const r = await commitCustomerImportAction(null, { tenantId: TENANT, tenantSlug: "s", rows });
      expect(r).toMatchObject({ success: false, error: { code: appCode } });
      expect(JSON.stringify(r)).not.toContain("customers");
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never trust a malformed answer: a preview whose summary disagrees with its rows is an error", async () => {
    rpc.mockResolvedValueOnce({ data: { ...previewAnswer, summary: { ...previewAnswer.summary, new: 9 } }, error: null });
    expect((await previewCustomerImportAction(null, { tenantId: TENANT, tenantSlug: "s", rows })).success).toBe(false);
    rpc.mockResolvedValueOnce({ data: { nope: true }, error: null });
    expect((await commitCustomerImportAction(null, { tenantId: TENANT, tenantSlug: "s", rows })).success).toBe(false);
  });
});
