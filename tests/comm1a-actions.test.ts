/**
 * Faz COMM.1A — the rule-setting Server Action with the Supabase client replaced by a recording fake: validated before the
 * database, exactly the validated values passed, refusals become plain messages (no database text).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const requireUser = vi.fn();
const revalidatePath = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

import { setCommissionRuleAction } from "@/lib/modules/commission/actions";

const T = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const V = "33333333-3333-4333-8333-333333333333";
const base = { tenantId: T, tenantSlug: "ornek", staffId: S, serviceId: V, kind: "percentage", value: 20, effectiveFrom: null };

beforeEach(() => {
  rpc.mockReset();
  requireUser.mockReset();
  revalidatePath.mockReset();
  requireUser.mockResolvedValue({ id: "u" });
});

describe("setCommissionRuleAction", () => {
  it("requires a signed-in user first", async () => {
    requireUser.mockRejectedValue(new Error("redirect to login"));
    await expect(setCommissionRuleAction(null, base)).rejects.toThrow("redirect to login");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes exactly the validated values and refreshes the page; 'none' passes no value", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    expect((await setCommissionRuleAction(null, { ...base, effectiveFrom: "2026-10-01" })).success).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("set_commission_rule", { p_tenant_id: T, p_staff_id: S, p_service_id: V, p_kind: "percentage", p_value: 20, p_effective_from: "2026-10-01" });
    expect(revalidatePath).toHaveBeenCalledWith("/app/ornek/finance/commission");
    await setCommissionRuleAction(null, { ...base, kind: "none", value: null });
    expect(rpc).toHaveBeenLastCalledWith("set_commission_rule", { p_tenant_id: T, p_staff_id: S, p_service_id: V, p_kind: "none" });
  });

  it("refuses malformed input before the database: bad ids, kind, value, date, none with a value, a value without a kind that takes one, percentage over 100", async () => {
    const bad = [
      { ...base, tenantId: "x" }, { ...base, staffId: "x" }, { ...base, serviceId: "x" }, { ...base, kind: "salary" },
      { ...base, value: -1 }, { ...base, value: 1000000 }, { ...base, effectiveFrom: "yesterday" },
      { ...base, kind: "none", value: 5 }, { ...base, kind: "fixed", value: null }, { ...base, value: 100.5 }, null,
    ];
    for (const input of bad) expect((await setCommissionRuleAction(null, input)).success, JSON.stringify(input)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps each refusal to a plain message and never shows database text", async () => {
    const cases: [string, string][] = [["CM001", "UNAUTHENTICATED"], ["CM002", "UNAUTHORIZED"], ["42501", "UNAUTHORIZED"], ["CM003", "NOT_FOUND"], ["CM004", "VALIDATION"], ["XX000", "UNEXPECTED"]];
    for (const [code, appCode] of cases) {
      rpc.mockResolvedValueOnce({ data: null, error: { code, message: 'relation "public.staff_commission_rules" broke' } });
      const r = await setCommissionRuleAction(null, base);
      expect(r).toMatchObject({ success: false, error: { code: appCode } });
      expect(JSON.stringify(r)).not.toContain("staff_commission_rules");
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
