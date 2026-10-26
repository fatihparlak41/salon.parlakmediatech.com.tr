// @vitest-environment jsdom
/**
 * Faz COMM.1A — the app side: strict parsing of the database answers, the presentation, and the Server Action. Isolated: Supabase
 * throws, actions mocked where needed. All names, rates and amounts are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommissionDetailView, CommissionSummaryView } from "@/components/commission/commission-view";
import { CommissionRulesPanel } from "@/components/commission/commission-rules";
import { describeRule, parseCommissionDetail, parseCommissionRules, parseCommissionSummary, parseRuleValue } from "@/lib/modules/commission/model";
import { setCommissionRuleAction } from "@/lib/modules/commission/actions";
import { fail, ok } from "@/lib/errors";

const rpc = vi.fn();
const requireUser = vi.fn();
const revalidatePath = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => { throw new Error("no real client"); }) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
const refresh = vi.fn();
vi.mock("@/lib/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const summaryRaw = () => ({
  from: "2026-10-10", to: "2026-10-10", timezone: "Europe/Nicosia", currency: "TRY",
  staff: [
    { staffId: "11111111-1111-4111-8111-111111111111", displayName: "Ahmet", completedServices: 2, completedAppointments: 2, serviceAmount: 1000.1, commissionAmount: 101.01 },
    { staffId: "22222222-2222-4222-8222-222222222222", displayName: "Can", completedServices: 1, completedAppointments: 1, serviceAmount: 200, commissionAmount: 0 },
  ],
  totals: { completedServices: 3, serviceAmount: 1200.1, commissionAmount: 101.01 },
});
const detailRaw = () => ({
  from: "2026-10-10", to: "2026-10-10", currency: "TRY", displayName: "Ahmet", hasMore: false,
  total: { serviceAmount: 1000.1, commissionAmount: 101.01, rows: 2 },
  rows: [
    { date: "2026-10-10", service: "Boya", serviceValue: 1000, rule: { kind: "percentage", percentage: 10, fixedAmount: null }, commission: 100, saleDiscount: true },
    { date: "2026-10-10", service: "Kucuk Islem", serviceValue: 0.1, rule: { kind: "fixed", percentage: null, fixedAmount: 1.01 }, commission: 1.01, saleDiscount: false },
  ],
});

afterEach(() => cleanup());
beforeEach(() => {
  rpc.mockReset();
  requireUser.mockReset();
  requireUser.mockResolvedValue({ id: "u" });
  revalidatePath.mockReset();
  refresh.mockReset();
});

describe("parsing", () => {
  it("accepts consistent answers; totals must be the sum of the people / rows in integer cents", () => {
    expect(parseCommissionSummary(summaryRaw())!.totals.commissionAmount).toBe(101.01);
    expect(parseCommissionDetail(detailRaw())!.rows).toHaveLength(2);
    const bad = summaryRaw();
    bad.totals.commissionAmount = 101.02;
    expect(parseCommissionSummary(bad)).toBeNull();
    const bad2 = detailRaw();
    bad2.total.commissionAmount = 100;
    expect(parseCommissionDetail(bad2)).toBeNull();
    const bad3 = summaryRaw();
    bad3.totals.completedServices = 4;
    expect(parseCommissionSummary(bad3)).toBeNull();
  });

  it("a truncated detail (hasMore) is not cross-checked against its rows; a complete one is", () => {
    const d = detailRaw();
    d.hasMore = true;
    d.rows = d.rows.slice(0, 1);
    expect(parseCommissionDetail(d)).not.toBeNull();
  });

  it("refuses negative amounts, a rule that does not match its kind, a percentage above 100, malformed input", () => {
    const neg = summaryRaw();
    neg.staff[0]!.commissionAmount = -1;
    expect(parseCommissionSummary(neg)).toBeNull();
    for (const rule of [{ kind: "percentage", percentage: null, fixedAmount: null }, { kind: "percentage", percentage: 101, fixedAmount: null }, { kind: "fixed", percentage: 5, fixedAmount: 1 }, { kind: "none", percentage: 5, fixedAmount: null }, { kind: "salary", percentage: null, fixedAmount: null }]) {
      const d = detailRaw();
      d.rows[0]!.rule = rule as never;
      expect(parseCommissionDetail(d), JSON.stringify(rule)).toBeNull();
    }
    for (const b of [null, "x", [], {}]) {
      expect(parseCommissionSummary(b)).toBeNull();
      expect(parseCommissionDetail(b)).toBeNull();
      expect(parseCommissionRules(b)).toBeNull();
    }
  });

  it("rules list: only percentage / fixed rules, people and services as {id, name}", () => {
    const ok = { today: "2026-10-10", rules: [{ staffId: "a", staffName: "Ahmet", serviceId: "b", serviceName: "Boya", kind: "fixed", percentage: null, fixedAmount: 250, effectiveFrom: "2026-01-01" }], staff: [{ id: "a", name: "Ahmet" }], services: [{ id: "b", name: "Boya" }] };
    expect(parseCommissionRules(ok)!.rules[0]!.kind).toBe("fixed");
    expect(parseCommissionRules({ ...ok, rules: [{ ...ok.rules[0], kind: "none", fixedAmount: null }] })).toBeNull();
  });

  it("rule value input: comma or dot, at most 2 decimals, non-negative; describeRule words", () => {
    expect(parseRuleValue("12,5")).toBe(12.5);
    expect(parseRuleValue("250")).toBe(250);
    for (const bad of ["", "abc", "-1", "1.234", "1e3", "12,5,1", "1 000"]) expect(parseRuleValue(bad), bad).toBeNull();
    expect(describeRule({ kind: "percentage", percentage: 20, fixedAmount: null }, "TRY")).toBe("%20");
    expect(describeRule({ kind: "percentage", percentage: 12.5, fixedAmount: null }, "TRY")).toBe("%12,5");
    expect(describeRule({ kind: "fixed", percentage: null, fixedAmount: 250 }, "TRY")).toBe("250,00 TRY sabit");
    expect(describeRule({ kind: "none", percentage: null, fixedAmount: null }, "TRY")).toBe("Komisyon yok");
  });
});

describe("presentation", () => {
  it("summary: people with completed services, amount and commission, a total row, the basis stated; a person without a rule shows 0,00", () => {
    const { container } = render(<CommissionSummaryView summary={parseCommissionSummary(summaryRaw())!} basePath="/app/x/finance/commission" selectedStaffId={null} query="from=2026-10-10&to=2026-10-10" />);
    const table = container.querySelector('[data-testid="commission-table"]')!;
    expect(table.textContent).toContain("Ahmet");
    expect(table.textContent).toContain("101,01 TRY");
    expect(table.textContent).toContain("1.200,10 TRY");
    const can = [...table.querySelectorAll("tbody tr")].find((r) => r.textContent!.includes("Can"))!;
    expect(can.textContent).toContain("0,00 TRY");
    expect(container.textContent).toContain("tahsilat yöntemi ve ödeme durumu komisyonu değiştirmez");
    expect(container.textContent).toContain("Bu bir bordro değildir");
    expect(container.querySelector("a")!.getAttribute("href")).toContain("staff=11111111-1111-4111-8111-111111111111");
  });

  it("an empty range says so", () => {
    const empty = parseCommissionSummary({ ...summaryRaw(), staff: [], totals: { completedServices: 0, serviceAmount: 0, commissionAmount: 0 } })!;
    const { container } = render(<CommissionSummaryView summary={empty} basePath="/x" selectedStaffId={null} query="" />);
    expect(container.textContent).toContain("Bu aralıkta tamamlanan işlem yok.");
  });

  it("detail: date, service, value, rule and commission per row; the sale-discount note; no customer data", () => {
    const { container } = render(<CommissionDetailView detail={parseCommissionDetail(detailRaw())!} />);
    const text = container.textContent!;
    expect(text).toContain("10.10.2026");
    expect(text).toContain("%10");
    expect(text).toContain("1,01 TRY sabit");
    expect(text).toContain("(satışta indirim var, düşülmedi)");
    expect(text).toContain("101,01 TRY");
    expect(container.innerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe("rules panel", () => {
  const rules = parseCommissionRules({ today: "2026-10-10", rules: [], staff: [{ id: "11111111-1111-4111-8111-111111111111", name: "Ahmet" }], services: [{ id: "33333333-3333-4333-8333-333333333333", name: "Boya" }] })!;
  vi.mock("@/lib/modules/commission/actions", () => ({ setCommissionRuleAction: vi.fn() }));

  it("without finance.manage the form does not exist; with no rules it says everyone earns 0,00", () => {
    const { container } = render(<CommissionRulesPanel tenantId="t" tenantSlug="s" rules={rules} currency="TRY" canManage={false} />);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("komisyon 0,00");
  });

  it("validates before calling, sends exactly what was typed, refreshes on success and shows the server's refusal", async () => {
    const act = vi.mocked(setCommissionRuleAction);
    act.mockResolvedValueOnce(ok(null));
    render(<CommissionRulesPanel tenantId="11111111-1111-4111-8111-aaaaaaaaaaaa" tenantSlug="s" rules={rules} currency="TRY" canManage />);
    fireEvent.change(screen.getByLabelText("Yüzde"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Kuralı kaydet" }));
    expect(screen.getByRole("alert").textContent).toBe("Yüzde 0 ile 100 arasında olmalı.");
    expect(act).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Yüzde"), { target: { value: "12,5" } });
    fireEvent.click(screen.getByRole("button", { name: "Kuralı kaydet" }));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(act.mock.calls[0]![1]).toEqual({
      tenantId: "11111111-1111-4111-8111-aaaaaaaaaaaa", tenantSlug: "s",
      staffId: "11111111-1111-4111-8111-111111111111", serviceId: "33333333-3333-4333-8333-333333333333",
      kind: "percentage", value: 12.5, effectiveFrom: null,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    act.mockResolvedValueOnce(fail("UNAUTHORIZED", "Komisyon kuralı değiştirme yetkiniz yok"));
    fireEvent.click(screen.getByRole("button", { name: "Kuralı kaydet" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Komisyon kuralı değiştirme yetkiniz yok");
  });

  it("'no commission' sends no value; a fixed rule sends the amount", async () => {
    const act = vi.mocked(setCommissionRuleAction);
    act.mockResolvedValue(ok(null));
    render(<CommissionRulesPanel tenantId="11111111-1111-4111-8111-aaaaaaaaaaaa" tenantSlug="s" rules={rules} currency="TRY" canManage />);
    fireEvent.change(screen.getByLabelText("Komisyon türü"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Kuralı kaydet" }));
    await waitFor(() => expect(act).toHaveBeenCalled());
    expect(act.mock.calls.at(-1)![1]).toMatchObject({ kind: "none", value: null });
    fireEvent.change(screen.getByLabelText("Komisyon türü"), { target: { value: "fixed" } });
    fireEvent.change(screen.getByLabelText("Tutar (TRY)"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Kuralı kaydet" }));
    await waitFor(() => expect(act.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(act.mock.calls.at(-1)![1]).toMatchObject({ kind: "fixed", value: 250 });
  });
});
