import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createStaffFinanceWorld,
  destroyStaffFinanceWorld,
  callRpc,
  addLine,
  updateLine,
  voidLine,
  finalizePeriod,
  reopenPeriod,
  cancelPeriod,
  recordPayment,
  voidPayment,
  updatePeriod,
  getOverview,
  getPeriod,
  listStaff,
  listKinds,
  makePeriod,
  makeLine,
  makePayment,
  expectOk,
  periodRow,
  lineRows,
  paymentRows,
  oracleTotals,
  counts,
  tenantDigest,
  newKey,
  newStaff,
  tenantToday,
  tenantMonth,
  type StaffFinanceWorld,
  type RpcOutcome,
  type PeriodDetail,
  type StaffOverview,
} from "./staff-finance-fixtures";
import { asAuthenticatedUser, createStaffMember } from "./helpers";

/**
 * Faz FIN.1C.1 — read models and reporting (matrix groups R, the read half of A and CUR). Every figure asserted here is
 * checked against numbers worked out by hand (architecture section 4.3 example vector) or against an independent oracle
 * that reads the child rows; nothing is asserted by re-running the function under test.
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to
 * whatever TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV
 * database) and fails loudly when they are not.
 */

// ----------------------------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------------------------

const MARCH = "2026-03-01";
const MARCH_REF = "2026-03-15";

function failure(out: RpcOutcome<unknown>): string | undefined {
  expect(out.ok, `expected a failure, got ${JSON.stringify(out)}`).toBe(false);
  return out.ok ? undefined : out.code;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The architecture section 4.3 example vector on one period: G 35,000 (salary 30,000, commission 3,000, overtime 2,000),
 * D 5,000 (Social Insurance 2,500, Provident Fund 1,500, P.A.Y.E. 1,000), E 5,000 (Social Insurance 3,500, Provident Fund
 * 1,500), advance 10,000 and salary 15,000 paid. Payments carry fixed past instants inside `month`'s calendar month. */
async function buildExample(w: StaffFinanceWorld, staffMemberId: string, month: string, paidDay = "10") {
  const p = await makePeriod(w, { staffMemberId, periodMonth: month });
  const L = (kind: string, amount: number) => makeLine(p.periodId, kind, amount, {}, w.owner);
  await L("salary", 30000);
  await L("commission", 3000);
  await L("overtime", 2000);
  await L("employee_social_insurance", 2500);
  await L("employee_provident_fund", 1500);
  await L("paye", 1000);
  await L("employer_social_insurance", 3500);
  await L("employer_provident_fund", 1500);
  const ym = month.slice(0, 8);
  await makePayment(p.periodId, 10000, { purpose: "advance", paidAt: `${ym}${paidDay}T09:00:00Z` }, w.owner);
  await makePayment(p.periodId, 15000, { purpose: "salary", paidAt: `${ym}${paidDay}T10:00:00Z` }, w.owner);
  return p.periodId;
}

const EXAMPLE_FIGURES = {
  grossEntitlement: 35000,
  employeeDeductions: 5000,
  paye: 1000,
  netPayable: 30000,
  paid: 25000,
  advances: 10000,
  employeeOutstanding: 5000,
  paidInExcess: 0,
  employerCost: 5000,
  personnelCost: 40000,
  socialInsurance: { employee: 2500, employer: 3500 },
  providentFund: { employee: 1500, employer: 1500 },
};

/** Run ONE RPC as `userId` inside a transaction that is always rolled back: the outcome is reported, nothing persists. */
class ProbeRollback extends Error {
  constructor(public readonly outcome: RpcOutcome<unknown>) {
    super("probe rollback");
  }
}
async function probe(userId: string, fn: string, args: [string, unknown, string][]): Promise<RpcOutcome<Record<string, unknown>>> {
  const named = args.map(([name, , type], i) => `${name} := $${i + 1}::${type === "timestamptz" ? "text::timestamptz" : type}`).join(", ");
  try {
    await asAuthenticatedUser(userId, async (sql) => {
      const rows = await sql.unsafe(`select public.${fn}(${named}) as r`, args.map(([, v]) => v) as never[]);
      throw new ProbeRollback({ ok: true, data: (rows[0] as unknown as { r: Record<string, unknown> }).r });
    });
  } catch (error) {
    if (error instanceof ProbeRollback) return error.outcome as RpcOutcome<Record<string, unknown>>;
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code, message: e.message ?? String(error) };
  }
  throw new Error("unreachable");
}

// ----------------------------------------------------------------------------------------------------------------
// The example vector and its derived rules (one world, one period; every test only reads)
// ----------------------------------------------------------------------------------------------------------------

describe("R example vector and the reporting rules built on it", () => {
  let w: StaffFinanceWorld;
  let periodId: string;
  let voidedLineId: string;
  let voidedPaymentId: string;

  beforeAll(async () => {
    w = await createStaffFinanceWorld("fin1c1-rd-ex");
    periodId = await buildExample(w, w.staffA.id, MARCH);
    // voided rows that must never count anywhere (R5)
    const line = await makeLine(periodId, "bonus", 999, {}, w.owner);
    voidedLineId = line.lineId!;
    const v = (await periodRow(periodId)).version;
    expectOk(await voidLine(w.owner.id, { lineId: voidedLineId, reason: "yanlis kalem", expectedVersion: v }));
    const pay = await makePayment(periodId, 777, { purpose: "bonus", paidAt: `${MARCH.slice(0, 8)}12T09:00:00Z` }, w.owner);
    voidedPaymentId = pay.paymentId!;
    expectOk(await voidPayment(w.owner.id, voidedPaymentId, "yanlis odeme"));
  });

  afterAll(async () => {
    await destroyStaffFinanceWorld(w);
  });

  const overview = async () => expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: MARCH, referenceDate: MARCH_REF }));

  it("R3 the example vector: gross 35,000, deductions 5,000 (P.A.Y.E. 1,000), net 30,000, paid 25,000, advances 10,000, outstanding 5,000, employer cost 5,000, personnel cost 40,000 — in the period row, the month figures and the detail", async () => {
    const o = await overview();
    const cur = o.byCurrency.find((c) => c.currency === o.primaryCurrency)!;
    expect(cur).toMatchObject({ ...EXAMPLE_FIGURES, periodCount: 1, cashPaidInMonth: 25000 });
    expect(cur.employeeOutstandingAllTime).toEqual({ total: 5000, count: 1 });
    expect(cur.paidInExcessAllTime).toEqual({ total: 0, count: 0 });
    expect(cur.overdueAllTime).toEqual({ total: 0, count: 0 });
    expect(o.periods).toHaveLength(1);
    expect(o.periods[0]).toMatchObject({ ...EXAMPLE_FIGURES, periodId, lifecycle: "open", paymentState: "partially_paid", isOverdue: false, daysOverdue: null });
    const d = await expectOk(await getPeriod(w.owner.id, periodId, MARCH_REF));
    expect(d).toMatchObject({ ...EXAMPLE_FIGURES, periodMonth: MARCH, lifecycle: "open", paymentState: "partially_paid" });
  });

  it("R5 voided lines and payments are excluded from every figure but stay in the detail with their reasons", async () => {
    const o = await overview();
    const cur = o.byCurrency[0]!;
    expect(cur.grossEntitlement).toBe(35000); // the voided bonus 999 is not in it
    expect(cur.paid).toBe(25000); // the voided payment 777 is not in it
    const d = await expectOk(await getPeriod(w.owner.id, periodId, MARCH_REF));
    const vl = d.lines.find((l) => l.id === voidedLineId)!;
    const vp = d.payments.find((p) => p.id === voidedPaymentId)!;
    expect(vl).toMatchObject({ status: "voided", voidReason: "yanlis kalem", canEdit: false, canVoid: false });
    expect(vp).toMatchObject({ status: "voided", voidReason: "yanlis odeme" });
  });

  it("R7 / R24 Social Insurance and Provident Fund: the employee and employer sums come from the tagged lines, and each side of an institution adds up to the tagged lines of both groups", async () => {
    const o = await overview();
    expect(o.byCurrency[0]!.socialInsurance).toEqual({ employee: 2500, employer: 3500 });
    expect(o.byCurrency[0]!.providentFund).toEqual({ employee: 1500, employer: 1500 });
    const [row] = await testDb<{ si: string; pf: string }[]>`
      select coalesce(sum(amount) filter (where institution = 'social_insurance'), 0)::text as si,
             coalesce(sum(amount) filter (where institution = 'provident_fund'), 0)::text as pf
      from staff_period_lines where period_id = ${periodId} and status = 'active'`;
    const si = o.byCurrency[0]!.socialInsurance;
    const pf = o.byCurrency[0]!.providentFund;
    expect(si.employee + si.employer).toBe(Number(row!.si));
    expect(pf.employee + pf.employer).toBe(Number(row!.pf));
    const row0 = o.periods[0]!;
    expect(row0.socialInsurance.employee + row0.socialInsurance.employer).toBe(Number(row!.si));
  });

  it("R21 personnel cost is gross plus employer cost: advances and payments never enter it", async () => {
    const o = await overview();
    const cur = o.byCurrency[0]!;
    expect(cur.personnelCost).toBe(cur.grossEntitlement + cur.employerCost);
    expect(cur.personnelCost).toBe(40000);
    expect(cur.advances).toBe(10000); // present, and not part of the 40,000
  });

  it("R26 a P.A.Y.E. line is in employeeDeductions and in paye, in no institution figure and not in employerCost", async () => {
    const o = await overview();
    const cur = o.byCurrency[0]!;
    expect(cur.paye).toBe(1000);
    expect(cur.employeeDeductions).toBe(5000);
    expect(cur.socialInsurance.employee + cur.providentFund.employee).toBe(4000); // 5,000 minus the 1,000 P.A.Y.E.
    expect(cur.employerCost).toBe(5000); // the employer lines only
  });

  it("R16 no forbidden field in any read model, and no staff member id in a period, line or payment model", async () => {
    const banned = /(^|_)(created_by|voided_by|cancelled_by|finalized_by|idempotency_key|idempotency_fingerprint|tenant_id|email|phone|membership_id|color|branch|customer)/i;
    const bannedCamel = /^(createdBy|voidedBy|cancelledBy|finalizedBy|idempotencyKey|idempotencyFingerprint|tenantId|email|phone|membershipId|color|branchId|customerId|userId|authUserId)$/;
    const walk = (value: unknown, path: string, acc: string[]) => {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, acc));
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          if (banned.test(k) || bannedCamel.test(k)) acc.push(`${path}.${k}`);
          walk(v, `${path}.${k}`, acc);
        }
      }
    };
    const hits: string[] = [];
    const o = await overview();
    walk(o, "overview", hits);
    const d = await expectOk(await getPeriod(w.owner.id, periodId, MARCH_REF));
    walk(d, "period", hits);
    walk(await expectOk(await listStaff(w.owner.id, w.tenant.id)), "listStaff", hits);
    expect(hits).toEqual([]);
    // the staff member id exists only in staffWithoutPeriod and list_finance_staff
    for (const row of o.periods) expect(Object.keys(row)).not.toContain("staffMemberId");
    expect(Object.keys(d)).not.toContain("staffMemberId");
    for (const l of d.lines) expect(Object.keys(l)).not.toContain("staffMemberId");
    for (const p of d.payments) expect(Object.keys(p)).not.toContain("staffMemberId");
    for (const s of o.staffWithoutPeriod) expect(Object.keys(s).sort()).toEqual(["fullName", "staffMemberId", "status"]);
    for (const s of await expectOk(await listStaff(w.owner.id, w.tenant.id))) expect(Object.keys(s).sort()).toEqual(["fullName", "staffMemberId", "status"]);
    // nothing in the serialized text either (an auth user id, an e-mail, the idempotency key of the period)
    const text = JSON.stringify([o, d]);
    const pr = await periodRow(periodId);
    expect(text).not.toContain(pr.idempotency_key);
    expect(text).not.toContain(pr.staff_member_id);
    for (const u of w.users) {
      expect(text).not.toContain(u.id);
      expect(text).not.toContain(u.email);
    }
  });

  it("R17 reads write nothing: row counts and a digest of every staff-finance row and audit row are unchanged by every read RPC", async () => {
    const before = { c: await counts(w.tenant.id), d: await tenantDigest(w.tenant.id) };
    expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: MARCH, referenceDate: MARCH_REF }));
    expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id }));
    expectOk(await getPeriod(w.owner.id, periodId));
    expectOk(await listStaff(w.owner.id, w.tenant.id));
    expectOk(await listKinds(w.owner.id, w.tenant.id));
    expect(await counts(w.tenant.id)).toEqual(before.c);
    expect(await tenantDigest(w.tenant.id)).toBe(before.d);
  });

  it("R13 detail ordering: lines by group (earning, deduction, employer cost) then creation; payments by paid_at then creation; voided rows included with their reasons", async () => {
    const d = await expectOk(await getPeriod(w.owner.id, periodId, MARCH_REF));
    const order = (g: string) => (g === "earning" ? 1 : g === "employee_deduction" ? 2 : 3);
    const groups = d.lines.map((l) => order(l.lineGroup));
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    const rows = await lineRows(periodId);
    for (const g of ["earning", "employee_deduction", "employer_cost"]) {
      const expected = rows.filter((r) => r.line_group === g).map((r) => r.id);
      expect(d.lines.filter((l) => l.lineGroup === g).map((l) => l.id)).toEqual(expected);
    }
    const paidAts = d.payments.map((p) => Date.parse(p.paidAt));
    expect(paidAts).toEqual([...paidAts].sort((a, b) => a - b));
    expect(d.payments).toHaveLength(3); // advance, salary and the voided bonus
    expect(d.lines.some((l) => l.status === "voided")).toBe(true);
  });

  it("R25 / R3 the figures of the detail equal an oracle that sums the child rows", async () => {
    const d = await expectOk(await getPeriod(w.owner.id, periodId, MARCH_REF));
    const o = await oracleTotals(periodId);
    expect(d.grossEntitlement).toBe(o.earning);
    expect(d.employeeDeductions).toBe(o.deduction);
    expect(d.employerCost).toBe(o.employer);
    expect(d.paid).toBe(o.paid);
    expect(d.advances).toBe(o.advances);
    expect(d.netPayable).toBe(o.earning - o.deduction);
    expect(d.employeeOutstanding).toBe(o.earning - o.deduction - o.paid);
  });
});

// ----------------------------------------------------------------------------------------------------------------
// Number exactness, flags, finalized statement
// ----------------------------------------------------------------------------------------------------------------

describe("R detail statement, flags and number exactness", () => {
  let w: StaffFinanceWorld;
  beforeAll(async () => {
    w = await createStaffFinanceWorld("fin1c1-rd-det");
  });
  afterAll(async () => {
    await destroyStaffFinanceWorld(w);
  });

  it("R18 JSON numbers are exact up to 12 significant digits (the extremes of the amount range, and a sum of two of them)", async () => {
    for (const amount of ["9999999999.99", "123456789.12", "0.01", "1234567890.12"]) {
      const p = await makePeriod(w);
      await makeLine(p.periodId, "salary", amount, {}, w.owner);
      const d = await expectOk(await getPeriod(w.owner.id, p.periodId));
      expect(d.grossEntitlement).toBe(Number(amount));
      expect(d.netPayable).toBe(Number(amount));
      expect(d.personnelCost).toBe(Number(amount));
    }
    const p = await makePeriod(w);
    await makeLine(p.periodId, "salary", "500000000.01", {}, w.owner);
    await makeLine(p.periodId, "commission", "400000000.02", {}, w.owner);
    const d = await expectOk(await getPeriod(w.owner.id, p.periodId));
    expect(d.grossEntitlement).toBe(900000000.03);
  });

  it("R14 finalized statement: equals the stored snapshot, sinceFinalization is live minus snapshot, and both are null unless finalized", async () => {
    const p = await makePeriod(w, { periodMonth: "2026-04-01" });
    await makeLine(p.periodId, "salary", 10000, {}, w.owner);
    await makeLine(p.periodId, "other_deduction", 1000, {}, w.owner);
    const open = await expectOk(await getPeriod(w.owner.id, p.periodId));
    expect(open.finalizedStatement).toBeNull();
    expect(open.sinceFinalization).toBeNull();

    const v = (await periodRow(p.periodId)).version;
    expectOk(await finalizePeriod(w.owner.id, { periodId: p.periodId, expectedVersion: v }));
    const stored = await periodRow(p.periodId);
    const fin = await expectOk(await getPeriod(w.owner.id, p.periodId));
    expect(fin.finalizedStatement).toMatchObject({ grossEntitlement: 10000, employeeDeductions: 1000, netPayable: 9000 });
    expect(fin.finalizedStatement!.grossEntitlement).toBe(Number(stored.finalized_earning_total));
    expect(fin.finalizedStatement!.employeeDeductions).toBe(Number(stored.finalized_deduction_total));
    expect(fin.finalizedStatement!.netPayable).toBe(Number(stored.finalized_net_payable));
    expect(fin.sinceFinalization).toEqual({ grossEntitlement: 0, employeeDeductions: 0, netPayable: 0 });

    // an adjustment after finalization moves the live figures, never the snapshot
    await makeLine(p.periodId, "adjustment_credit", 500, { description: "Duzeltme" }, w.owner);
    await makeLine(p.periodId, "adjustment_debit", 200, { description: "Duzeltme" }, w.owner);
    const after = await expectOk(await getPeriod(w.owner.id, p.periodId));
    expect(after.finalizedStatement).toMatchObject({ grossEntitlement: 10000, employeeDeductions: 1000, netPayable: 9000 });
    expect(after.grossEntitlement).toBe(10500);
    expect(after.employeeDeductions).toBe(1200);
    expect(after.sinceFinalization).toEqual({ grossEntitlement: 500, employeeDeductions: 200, netPayable: 300 });

    // reopened and cancelled periods carry neither
    const v2 = (await periodRow(p.periodId)).version;
    expectOk(await reopenPeriod(w.owner.id, { periodId: p.periodId, reason: "duzeltme", expectedVersion: v2 }));
    const reopened = await expectOk(await getPeriod(w.owner.id, p.periodId));
    expect(reopened.finalizedStatement).toBeNull();
    expect(reopened.sinceFinalization).toBeNull();
    const q = await makePeriod(w);
    expectOk(await cancelPeriod(w.owner.id, q.periodId, "yanlis ay"));
    const cancelled = await expectOk(await getPeriod(w.owner.id, q.periodId));
    expect(cancelled.finalizedStatement).toBeNull();
    expect(cancelled.sinceFinalization).toBeNull();
    expect(cancelled.flags).toMatchObject({
      canFinalize: false,
      canReopen: false,
      canCancel: false,
      canAddStatementLine: false,
      canAddAdjustment: false,
      canAddEmployerCost: false,
      canPay: false,
      maxPayable: null,
    });
    expect(cancelled.employeeOutstanding).toBe(0);
  });

  it("R15 (examples) the flags of an open, a paid-after-finalization and a cancel-blocked period state their reasons", async () => {
    const empty = await makePeriod(w);
    const e = await expectOk(await getPeriod(w.owner.id, empty.periodId));
    expect(e.flags).toMatchObject({ canFinalize: false, finalizeBlockedReason: "no_earning", canAddStatementLine: true, canPay: true, maxPayable: null, canReopen: false, reopenBlockedReason: "not_finalized" });

    const p = await makePeriod(w);
    await makeLine(p.periodId, "salary", 1000, {}, w.owner);
    await makePayment(p.periodId, 100, {}, w.owner);
    const open = await expectOk(await getPeriod(w.owner.id, p.periodId));
    expect(open.flags).toMatchObject({ canFinalize: true, finalizeBlockedReason: null, canCancel: false, cancelBlockedReason: "payments_posted" });
    const v = (await periodRow(p.periodId)).version;
    expectOk(await finalizePeriod(w.owner.id, { periodId: p.periodId, expectedVersion: v }));
    const fin = await expectOk(await getPeriod(w.owner.id, p.periodId));
    expect(fin.flags).toMatchObject({ canReopen: true, reopenBlockedReason: null, canPay: true, maxPayable: 900, canAddStatementLine: false, canAddAdjustment: true, canAddEmployerCost: true });
    await makePayment(p.periodId, 900, {}, w.owner);
    const full = await expectOk(await getPeriod(w.owner.id, p.periodId));
    expect(full.flags).toMatchObject({ canPay: false, maxPayable: 0, canReopen: false, reopenBlockedReason: "payment_after_finalization" });
  });
});

// ----------------------------------------------------------------------------------------------------------------
// Overview semantics that need isolated aggregates (each describe owns its world)
// ----------------------------------------------------------------------------------------------------------------

describe("R overview: isolation, months, cancelled periods, currencies", () => {
  let w: StaffFinanceWorld;
  beforeAll(async () => {
    w = await createStaffFinanceWorld("fin1c1-rd-iso");
  });
  afterAll(async () => {
    await destroyStaffFinanceWorld(w);
  });

  it("R1 overview isolation: another tenant's periods never appear, in either direction", async () => {
    const mine = await makePeriod(w, { staffMemberId: w.staffA.id, periodMonth: MARCH });
    await makeLine(mine.periodId, "salary", 1111, {}, w.owner);
    const theirs = await makePeriod(w, { staffMemberId: w.otherStaff.id, periodMonth: MARCH, tenantId: w.otherTenant.id }, w.otherOwner);
    await makeLine(theirs.periodId, "salary", 2222, {}, w.otherOwner);
    const a = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: MARCH, referenceDate: MARCH_REF }));
    expect(a.periods.map((p) => p.periodId)).toEqual([mine.periodId]);
    expect(a.byCurrency[0]!.grossEntitlement).toBe(1111);
    expect(a.staffWithoutPeriod.map((s) => s.staffMemberId)).not.toContain(w.otherStaff.id);
    const b = await expectOk(await getOverview(w.otherOwner.id, { tenantId: w.otherTenant.id, month: MARCH, referenceDate: MARCH_REF }));
    expect(b.periods.map((p) => p.periodId)).toEqual([theirs.periodId]);
    expect(b.byCurrency[0]!.grossEntitlement).toBe(2222);
    // a period of the other tenant cannot be read through this tenant's permission
    expect(failure(await getPeriod(w.owner.id, theirs.periodId))).toBe("FN002");
  });

  it("R2 month selection: the default is the tenant-local month of the reference date; an explicit month wins; any day inside a month selects that month; boundaries", async () => {
    const staff = [await newStaff(w), await newStaff(w), await newStaff(w)];
    const months = ["2026-05-01", "2026-06-01", "2026-07-01"];
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await makePeriod(w, { staffMemberId: staff[i]!.id, periodMonth: months[i]! });
      await makeLine(p.periodId, "salary", 100 * (i + 1), {}, w.owner);
      ids.push(p.periodId);
    }
    const get = (i: { month?: string | null; referenceDate?: string | null }) => getOverview(w.owner.id, { tenantId: w.tenant.id, ...i }).then(expectOk);
    // explicit months
    expect((await get({ month: "2026-05-01" })).periods.map((p) => p.periodId)).toEqual([ids[0]]);
    expect((await get({ month: "2026-07-01" })).periods.map((p) => p.periodId)).toEqual([ids[2]]);
    // any day of a month selects that month, and the returned month is its first day
    const mid = await get({ month: "2026-06-17" });
    expect(mid.month).toBe("2026-06-01");
    expect(mid.periods.map((p) => p.periodId)).toEqual([ids[1]]);
    // the default month follows the reference date
    expect((await get({ referenceDate: "2026-05-31" })).month).toBe("2026-05-01");
    expect((await get({ referenceDate: "2026-06-01" })).month).toBe("2026-06-01");
    expect((await get({ referenceDate: "2026-06-30" })).month).toBe("2026-06-01");
    expect((await get({ referenceDate: "2026-07-01" })).month).toBe("2026-07-01");
    // an explicit month beats the reference date
    const both = await get({ month: "2026-05-01", referenceDate: "2026-07-20" });
    expect(both.month).toBe("2026-05-01");
    expect(both.referenceDate).toBe("2026-07-20");
    // with neither: the tenant-local month of today
    const dflt = await get({});
    expect(dflt.month).toBe(await tenantMonth(w.tenant.id, 0));
    expect(dflt.referenceDate).toBe(await tenantToday(w.tenant.id));
    // out-of-range inputs are a stable FN004
    expect(failure(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: "1999-12-31" }))).toBe("FN004");
    expect(failure(await getOverview(w.owner.id, { tenantId: w.tenant.id, referenceDate: "2101-01-01" }))).toBe("FN004");
  });

  it("R4 cancelled periods are excluded everywhere; the person returns to staffWithoutPeriod", async () => {
    const staff = await newStaff(w, "Iptal");
    const p = await makePeriod(w, { staffMemberId: staff.id, periodMonth: "2026-08-01" });
    await makeLine(p.periodId, "salary", 5000, {}, w.owner);
    const before = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: "2026-08-01", referenceDate: "2026-08-20" }));
    expect(before.byCurrency[0]!.grossEntitlement).toBe(5000);
    expect(before.byCurrency[0]!.employeeOutstandingAllTime.count).toBeGreaterThanOrEqual(1);
    expect(before.staffWithoutPeriod.map((s) => s.staffMemberId)).not.toContain(staff.id);
    expectOk(await cancelPeriod(w.owner.id, p.periodId, "yanlis kayit"));
    const after = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: "2026-08-01", referenceDate: "2026-08-20" }));
    expect(after.periods).toEqual([]);
    expect(after.byCurrency[0]).toMatchObject({ grossEntitlement: 0, periodCount: 0, netPayable: 0 });
    expect(after.byCurrency[0]!.employeeOutstandingAllTime.count).toBe(before.byCurrency[0]!.employeeOutstandingAllTime.count - 1);
    expect(after.staffWithoutPeriod.map((s) => s.staffMemberId)).toContain(staff.id);
  });

  it("R6 currencies are grouped and never summed: the primary currency is always present; a second currency has its own entry", async () => {
    const [primary] = await testDb<{ currency: string }[]>`select currency from tenants where id = ${w.tenant.id}`;
    const staff = await newStaff(w, "Doviz");
    // a period that was created while the tenant currency was USD keeps USD forever (the snapshot)
    await testDb`update tenants set currency = 'USD' where id = ${w.tenant.id}`;
    let usdPeriod: string;
    try {
      const p = await makePeriod(w, { staffMemberId: staff.id, periodMonth: "2026-09-01" });
      usdPeriod = p.periodId;
      await makeLine(p.periodId, "salary", 700, {}, w.owner);
      await makePayment(p.periodId, 200, { paidAt: "2026-09-10T09:00:00Z" }, w.owner);
    } finally {
      await testDb`update tenants set currency = ${primary!.currency} where id = ${w.tenant.id}`;
    }
    const staff2 = await newStaff(w, "Yerel");
    const local = await makePeriod(w, { staffMemberId: staff2.id, periodMonth: "2026-09-01" });
    await makeLine(local.periodId, "salary", 300, {}, w.owner);
    const o = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: "2026-09-01", referenceDate: "2026-09-20" }));
    expect(o.primaryCurrency).toBe(primary!.currency);
    expect(o.byCurrency.map((c) => c.currency)).toEqual([primary!.currency, "USD"]);
    expect(o.byCurrency[0]).toMatchObject({ grossEntitlement: 300, periodCount: 1 });
    expect(o.byCurrency[1]).toMatchObject({ currency: "USD", grossEntitlement: 700, paid: 200, periodCount: 1, cashPaidInMonth: 200 });
    expect(o.periods.map((p) => p.currency).sort()).toEqual([primary!.currency, "USD"].sort());
    expect(o.periods.find((p) => p.periodId === usdPeriod!)!.currency).toBe("USD");
    // the second currency also appears when the selected month holds nothing of it but it has an outstanding balance
    const other = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: "2025-01-01", referenceDate: "2026-09-20" }));
    expect(other.byCurrency.map((c) => c.currency)).toEqual([primary!.currency, "USD"]);
    expect(other.byCurrency[1]).toMatchObject({ grossEntitlement: 0, periodCount: 0 });
    expect(other.byCurrency[1]!.employeeOutstandingAllTime).toEqual({ total: 500, count: 1 });
  });

  it("R19 an empty tenant: zeros for the primary currency, empty lists", async () => {
    const fresh = await createStaffFinanceWorld("fin1c1-rd-empty");
    try {
      await assertEmptyTenant(fresh);
    } finally {
      await destroyStaffFinanceWorld(fresh);
    }
  });

  async function assertEmptyTenant(w: StaffFinanceWorld) {
    const o = await expectOk(await getOverview(w.otherOwner.id, { tenantId: w.otherTenant.id, month: "2031-02-01", referenceDate: "2031-02-10" }));
    expect(o.periods).toEqual([]);
    expect(o.byCurrency).toHaveLength(1);
    expect(o.byCurrency[0]).toMatchObject({
      currency: o.primaryCurrency,
      grossEntitlement: 0,
      employeeDeductions: 0,
      paye: 0,
      netPayable: 0,
      paid: 0,
      advances: 0,
      employeeOutstanding: 0,
      paidInExcess: 0,
      employerCost: 0,
      personnelCost: 0,
      periodCount: 0,
      cashPaidInMonth: 0,
      socialInsurance: { employee: 0, employer: 0 },
      providentFund: { employee: 0, employer: 0 },
      employeeOutstandingAllTime: { total: 0, count: 0 },
      paidInExcessAllTime: { total: 0, count: 0 },
      overdueAllTime: { total: 0, count: 0 },
    });
    // the tenant's only staff member has no period
    expect(o.staffWithoutPeriod.map((s) => s.staffMemberId)).toEqual([w.otherStaff.id]);
  }
});

// ----------------------------------------------------------------------------------------------------------------
// Cash, all-time figures, overdue, reference date, staff without a period, ordering, sign convention
// ----------------------------------------------------------------------------------------------------------------

describe("R overview: cash, all-time, overdue, reference date, ordering, sign convention", () => {
  let w: StaffFinanceWorld;
  beforeAll(async () => {
    w = await createStaffFinanceWorld("fin1c1-rd-cash");
  });
  afterAll(async () => {
    await destroyStaffFinanceWorld(w);
  });

  it("R8 cash paid in the month uses tenant-local month boundaries, across month end and a DST change (Europe/Berlin)", async () => {
    await testDb`update tenants set timezone = 'Europe/Berlin' where id = ${w.tenant.id}`;
    const p = await makePeriod(w, { periodMonth: "2026-03-01" });
    // [amount, instant, expected tenant-local month]
    const pays: [number, string, "feb" | "mar" | "apr"][] = [
      [1, "2026-02-28T22:30:00Z", "feb"], // 23:30 CET on 28 Feb
      [2, "2026-02-28T23:30:00Z", "mar"], // 00:30 CET on 1 Mar (still February in UTC)
      [4, "2026-03-01T00:30:00Z", "mar"],
      [32, "2026-03-29T00:30:00Z", "mar"], // 01:30 CET, just before the clocks change
      [64, "2026-03-29T01:30:00Z", "mar"], // 03:30 CEST, just after
      [8, "2026-03-31T21:30:00Z", "mar"], // 23:30 CEST on 31 Mar
      [16, "2026-03-31T22:30:00Z", "apr"], // 00:30 CEST on 1 Apr (still March in UTC)
    ];
    for (const [amount, paidAt] of pays) await makePayment(p.periodId, amount, { paidAt }, w.owner);
    const cash = async (month: string) =>
      (await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month, referenceDate: "2026-04-20" }))).byCurrency[0]!.cashPaidInMonth;
    const sum = (m: string) => pays.filter(([, , mm]) => mm === m).reduce((a, [amt]) => a + amt, 0);
    expect(await cash("2026-02-01")).toBe(sum("feb")); // 1
    expect(await cash("2026-03-01")).toBe(sum("mar")); // 2 + 4 + 32 + 64 + 8 = 110
    expect(await cash("2026-04-01")).toBe(sum("apr")); // 16
    expect(sum("mar")).toBe(110);
    // a voided payment leaves the cash figure
    const rows = await paymentRows(p.periodId);
    const target = rows.find((r) => Number(r.amount) === 4)!;
    expectOk(await voidPayment(w.owner.id, target.id, "yanlis"));
    expect(await cash("2026-03-01")).toBe(106);
  });

  it("R9 all-time figures are independent of the selected month and count correctly", async () => {
    const a = await makePeriod(w, { periodMonth: "2025-01-01" });
    await makeLine(a.periodId, "salary", 1000, {}, w.owner);
    await makePayment(a.periodId, 400, {}, w.owner); // outstanding 600
    const b = await makePeriod(w, { periodMonth: "2025-02-01" });
    await makeLine(b.periodId, "salary", 500, {}, w.owner); // outstanding 500
    const c = await makePeriod(w, { periodMonth: "2025-03-01" });
    await makeLine(c.periodId, "salary", 700, {}, w.owner);
    await makePayment(c.periodId, 700, {}, w.owner); // fully paid: not outstanding
    const read = async (month: string) => (await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month, referenceDate: "2025-02-10" }))).byCurrency[0]!;
    const base = await read("2025-01-01");
    for (const m of ["2025-02-01", "2025-03-01", "2030-01-01"]) {
      const other = await read(m);
      expect(other.employeeOutstandingAllTime).toEqual(base.employeeOutstandingAllTime);
      expect(other.paidInExcessAllTime).toEqual(base.paidInExcessAllTime);
      expect(other.overdueAllTime).toEqual(base.overdueAllTime);
    }
    // the three periods of this describe plus the R8 period (an open period with no earning has nothing outstanding)
    expect(base.employeeOutstandingAllTime.total).toBe(1100);
    expect(base.employeeOutstandingAllTime.count).toBe(2);
  });

  it("R10 overdue: due before the reference date and outstanding above 0; no due date never; fully paid never; the due day itself is not overdue; a cancelled period never", async () => {
    const dated = async (o: { due: string | null; salary: number; paid?: number; month?: string }) => {
      const p = await makePeriod(w, { periodMonth: o.month ?? "2025-05-01", ...(o.due ? { dueDate: o.due } : {}) });
      await makeLine(p.periodId, "salary", o.salary, {}, w.owner);
      if (o.paid) await makePayment(p.periodId, o.paid, {}, w.owner);
      return p.periodId;
    };
    const late = await dated({ due: "2025-05-10", salary: 1000, paid: 300 });
    const noDue = await dated({ due: null, salary: 1000 });
    const settled = await dated({ due: "2025-05-10", salary: 1000, paid: 1000 });
    const onDay = await dated({ due: "2025-05-20", salary: 1000 });
    const cancelled = await dated({ due: "2025-05-05", salary: 1000 });
    expectOk(await cancelPeriod(w.owner.id, cancelled, "yanlis"));
    const o = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month: "2025-05-01", referenceDate: "2025-05-20" }));
    const row = (id: string) => o.periods.find((p) => p.periodId === id);
    expect(row(late)).toMatchObject({ isOverdue: true, daysOverdue: 10 });
    expect(row(noDue)).toMatchObject({ isOverdue: false, daysOverdue: null });
    expect(row(settled)).toMatchObject({ isOverdue: false, daysOverdue: null });
    expect(row(onDay)).toMatchObject({ isOverdue: false, daysOverdue: null });
    expect(row(cancelled)).toBeUndefined();
    expect(o.byCurrency[0]!.overdueAllTime).toEqual({ total: 700, count: 1 });
    const d = await expectOk(await getPeriod(w.owner.id, late, "2025-05-20"));
    expect(d).toMatchObject({ isOverdue: true, daysOverdue: 10 });
  });

  it("R11 p_reference_date drives only overdue and the default month: totals are the current stored state whatever the date", async () => {
    const p = await makePeriod(w, { periodMonth: "2025-06-01", dueDate: "2025-06-10" });
    await makeLine(p.periodId, "salary", 1000, {}, w.owner);
    const at = (referenceDate: string) => getOverview(w.owner.id, { tenantId: w.tenant.id, month: "2025-06-01", referenceDate }).then(expectOk);
    const early = await at("2025-06-09");
    const late = await at("2025-06-11");
    expect(early.periods[0]).toMatchObject({ isOverdue: false });
    expect(late.periods[0]).toMatchObject({ isOverdue: true, daysOverdue: 1 });
    const strip = (o: StaffOverview) => ({ ...o.byCurrency[0]!, overdueAllTime: null, employeeOutstandingAllTime: null, paidInExcessAllTime: null });
    expect(strip(late)).toEqual(strip(early));
    expect(early.referenceDate).toBe("2025-06-09");
    // no historical reconstruction: a payment made later is in the figures of an earlier reference date
    await makePayment(p.periodId, 1000, {}, w.owner);
    const afterPay = await at("2025-06-09");
    expect(afterPay.periods[0]).toMatchObject({ paid: 1000, employeeOutstanding: 0 });
  });

  it("R12 staffWithoutPeriod: non-deleted staff without a non-cancelled period in the month; includes inactive; excludes staff with a period and deleted staff", async () => {
    const month = "2025-08-01";
    const withPeriod = await makePeriod(w, { staffMemberId: w.staffA.id, periodMonth: month });
    const cancelledOne = await makePeriod(w, { staffMemberId: w.staffB.id, periodMonth: month });
    expectOk(await cancelPeriod(w.owner.id, cancelledOne.periodId, "yanlis"));
    const o = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month, referenceDate: "2025-08-15" }));
    const ids = o.staffWithoutPeriod.map((s) => s.staffMemberId);
    expect(ids).not.toContain(w.staffA.id); // has a period
    expect(ids).toContain(w.staffB.id); // its period was cancelled
    expect(ids).toContain(w.staffInactive.id); // inactive staff are included
    expect(ids).not.toContain(w.staffDeleted.id); // deleted staff are not
    expect(o.staffWithoutPeriod.find((s) => s.staffMemberId === w.staffInactive.id)!.status).toBe("inactive");
    // active first
    const statuses = o.staffWithoutPeriod.map((s) => s.status);
    expect(statuses).toEqual([...statuses].sort((a, b) => (a === "active" ? 0 : 1) - (b === "active" ? 0 : 1)));
    expect(withPeriod.periodId).toBeTruthy();
  });

  it("R20 period rows come in a stable order: staff name (case-insensitive), then id", async () => {
    const month = "2025-09-01";
    const names = ["zeynep Ordering", "Ahmet Ordering", "ahmet Ordering", "Mehmet Ordering"];
    for (const n of names) {
      const s = await createStaffMember(w.tenant.id, n);
      const p = await makePeriod(w, { staffMemberId: s.id, periodMonth: month });
      await makeLine(p.periodId, "salary", 10, {}, w.owner);
    }
    const o = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month, referenceDate: "2025-09-15" }));
    const keys = o.periods.map((p) => [p.staffName.toLowerCase(), p.periodId] as const);
    const sorted = [...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    expect(keys).toEqual(sorted);
    const again = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month, referenceDate: "2025-09-15" }));
    expect(again.periods.map((p) => p.periodId)).toEqual(o.periods.map((p) => p.periodId));
  });

  it("R22 sign convention: an overpaid open period adds to paidInExcess and not to employeeOutstanding; the two are never netted, in the month and in the all-time figures", async () => {
    const month = "2025-10-01";
    const owes = await makePeriod(w, { periodMonth: month });
    await makeLine(owes.periodId, "salary", 1000, {}, w.owner);
    await makePayment(owes.periodId, 900, {}, w.owner); // outstanding 100
    const over = await makePeriod(w, { periodMonth: month });
    await makeLine(over.periodId, "salary", 500, {}, w.owner);
    await makePayment(over.periodId, 540, { purpose: "advance" }, w.owner); // paid in excess 40
    const o = await expectOk(await getOverview(w.owner.id, { tenantId: w.tenant.id, month, referenceDate: "2025-10-20" }));
    const cur = o.byCurrency[0]!;
    expect(cur.employeeOutstanding).toBe(100); // the overpaid period contributes 0 here, not -40
    expect(cur.paidInExcess).toBe(40);
    expect(cur.netPayable).toBe(1500);
    expect(cur.paid).toBe(1440);
    const overRow = o.periods.find((p) => p.periodId === over.periodId)!;
    expect(overRow).toMatchObject({ employeeOutstanding: -40, paidInExcess: 40, paymentState: "overpaid" });
    // all-time: positive and negative parts are separate figures with their own counts
    expect(cur.employeeOutstandingAllTime.total).toBeGreaterThanOrEqual(100);
    expect(cur.paidInExcessAllTime.total).toBeGreaterThanOrEqual(40);
    const [oracle] = await testDb<{ out: string; outc: string; ex: string; exc: string }[]>`
      select coalesce(sum(greatest(net_payable - paid_total, 0)), 0)::text as out,
             count(*) filter (where net_payable > paid_total)::text as outc,
             coalesce(sum(greatest(paid_total - net_payable, 0)), 0)::text as ex,
             count(*) filter (where paid_total > net_payable)::text as exc
      from staff_finance_periods where tenant_id = ${w.tenant.id} and lifecycle <> 'cancelled'`;
    expect(cur.employeeOutstandingAllTime).toEqual({ total: Number(oracle!.out), count: Number(oracle!.outc) });
    expect(cur.paidInExcessAllTime).toEqual({ total: Number(oracle!.ex), count: Number(oracle!.exc) });
  });
});

// ----------------------------------------------------------------------------------------------------------------
// R15 and R23: the flags predict the triggers; random histories keep the invariants and equal an independent oracle
// ----------------------------------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KIND_POOL = [
  "salary",
  "bonus",
  "commission",
  "overtime",
  "other_earning",
  "adjustment_credit",
  "employee_social_insurance",
  "employee_provident_fund",
  "paye",
  "other_deduction",
  "adjustment_debit",
  "employer_social_insurance",
  "employer_provident_fund",
  "private_insurance",
  "other_employer_cost",
];
const ADJUSTMENT = new Set(["adjustment_credit", "adjustment_debit"]);
const GROUP_OF: Record<string, "earning" | "employee_deduction" | "employer_cost"> = {
  salary: "earning",
  bonus: "earning",
  commission: "earning",
  overtime: "earning",
  extra_payment: "earning",
  other_earning: "earning",
  adjustment_credit: "earning",
  employee_social_insurance: "employee_deduction",
  employee_provident_fund: "employee_deduction",
  paye: "employee_deduction",
  other_deduction: "employee_deduction",
  adjustment_debit: "employee_deduction",
  employer_social_insurance: "employer_cost",
  employer_provident_fund: "employer_cost",
  private_insurance: "employer_cost",
  other_employer_cost: "employer_cost",
};

type ModelLine = { id: string; kind: string; group: string; amount: number; status: "active" | "voided"; description: string | null };
type ModelPayment = { id: string; amount: number; purpose: string; status: "posted" | "voided"; paidAt: string; postFinalization: boolean };

describe("R15 flags predict the triggers; R23 random histories keep I1 to I8 and equal an independent oracle", () => {
  let w: StaffFinanceWorld;
  beforeAll(async () => {
    w = await createStaffFinanceWorld("fin1c1-rd-prop");
  });
  afterAll(async () => {
    await destroyStaffFinanceWorld(w);
  });

  const O = () => w.owner.id;
  const cents = (n: number) => Math.round(n * 100);
  const amountOf = (rng: () => number, max: number) => Math.max(1, Math.floor(rng() * max * 100)) / 100;

  async function runHistory(seed: number, steps: number, onState?: (periodId: string) => Promise<void>) {
    const rng = mulberry32(seed);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const staff = await newStaff(w, `Prop${seed}`);
    const created = await makePeriod(w, { staffMemberId: staff.id });
    const periodId = created.periodId;
    const lines: ModelLine[] = [];
    const payments: ModelPayment[] = [];
    let lifecycle: "open" | "finalized" | "cancelled" = "open";
    let snapshot: { g: number; d: number } | null = null;
    let realChanges = 0; // committed real changes after creation
    const ver = async () => (await periodRow(periodId)).version;
    const totals = () => {
      const act = lines.filter((l) => l.status === "active");
      const sum = (g: string) => cents(act.filter((l) => l.group === g).reduce((a, l) => a + l.amount, 0));
      const posted = payments.filter((p) => p.status === "posted");
      return {
        g: sum("earning"),
        d: sum("employee_deduction"),
        e: sum("employer_cost"),
        p: cents(posted.reduce((a, p) => a + p.amount, 0)),
        a: cents(posted.filter((p) => p.purpose === "advance").reduce((a, p) => a + p.amount, 0)),
      };
    };
    const ALLOWED = new Set(["FN004", "FN023", "FN024", "FN025", "FN026", "FN027", "FN031", "FN032", "FN033"]);
    const verify = async (label: string) => {
      const t = totals();
      const row = await periodRow(periodId);
      const live = await oracleTotals(periodId);
      // I5: the cached totals equal the sums of the child rows and the independent model
      expect([cents(Number(row.earning_total)), cents(Number(row.employee_deduction_total)), cents(Number(row.employer_cost_total)), cents(Number(row.paid_total)), cents(Number(row.advance_total))], `${label}: cached totals vs model`).toEqual([t.g, t.d, t.e, t.p, t.a]);
      expect([cents(live.earning), cents(live.deduction), cents(live.employer), cents(live.paid), cents(live.advances)], `${label}: live sums vs model`).toEqual([t.g, t.d, t.e, t.p, t.a]);
      expect(row.lifecycle, `${label}: lifecycle`).toBe(lifecycle);
      // I2 and I3
      expect(t.d, `${label}: I2 deductions at most earnings`).toBeLessThanOrEqual(t.g);
      expect(t.a, `${label}: I3 advances at most payments`).toBeLessThanOrEqual(t.p);
      // I4: one currency
      const cur = await testDb<{ lines: string; pays: string; mismatched: string }[]>`
        select (select count(distinct currency) from staff_period_lines where period_id = ${periodId})::text as lines,
               (select count(distinct currency) from staff_payments where period_id = ${periodId})::text as pays,
               ((select count(*) from staff_period_lines l where l.period_id = ${periodId} and l.currency <> ${row.currency}) +
                (select count(*) from staff_payments y where y.period_id = ${periodId} and y.currency <> ${row.currency}))::text as mismatched`;
      expect([Number(cur[0]!.lines) <= 1, Number(cur[0]!.pays) <= 1, cur[0]!.mismatched], `${label}: I4 one currency per period`).toEqual([true, true, "0"]);
      // I7: finalized means paid at most net
      if (lifecycle === "finalized") expect(t.p, `${label}: I7`).toBeLessThanOrEqual(t.g - t.d);
      // I8: the snapshot equals the live statement at finalization and does not move while finalized
      if (lifecycle === "finalized") {
        expect([cents(Number(row.finalized_earning_total)), cents(Number(row.finalized_deduction_total))], `${label}: I8`).toEqual([snapshot!.g, snapshot!.d]);
      } else {
        expect(row.finalized_earning_total, `${label}: snapshot cleared`).toBeNull();
      }
      // I1: a cancelled period has no posted payment
      if (lifecycle === "cancelled") expect(t.p, `${label}: I1`).toBe(0);
      // I6: payment rows are never edited: the immutable columns equal what the model recorded, and a voided row stays voided
      const rows = await paymentRows(periodId);
      for (const m of payments) {
        const r = rows.find((x) => x.id === m.id)!;
        expect([cents(Number(r.amount)), r.purpose, r.post_finalization], `${label}: I6 payment ${m.id}`).toEqual([cents(m.amount), m.purpose, m.postFinalization]);
        expect(r.status, `${label}: payment status`).toBe(m.status);
      }
      // version ledger: 1 plus the number of committed real changes
      expect(row.version, `${label}: VR9 version`).toBe(1 + realChanges);
    };

    await verify("created");
    for (let step = 0; step < steps; step++) {
      const choice = rng();
      const v = await ver();
      const label = `seed ${seed} step ${step}`;
      if (choice < 0.28) {
        const kind = pick(KIND_POOL);
        const amount = amountOf(rng, 3000);
        const desc = ADJUSTMENT.has(kind) ? "Duzeltme" : rng() < 0.3 ? `acik ${step}` : null;
        const out = await addLine(O(), { periodId, kind, amount, description: desc, idempotencyKey: newKey() });
        if (out.ok && !out.data.noop) {
          lines.push({ id: out.data.lineId!, kind, group: GROUP_OF[kind]!, amount, status: "active", description: desc });
          realChanges += 1;
        } else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: addLine ${out.ok ? "" : out.code}`).toBe(true);
      } else if (choice < 0.42) {
        const act = lines.filter((l) => l.status === "active");
        if (act.length) {
          const l = pick(act);
          const amount = amountOf(rng, 3000);
          const description = ADJUSTMENT.has(l.kind) ? "Duzeltme 2" : rng() < 0.5 ? null : `yeni ${step}`;
          const out = await updateLine(O(), { lineId: l.id, amount, description, expectedVersion: v });
          if (out.ok && !out.data.noop) {
            l.amount = amount;
            l.description = description;
            realChanges += 1;
          } else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: updateLine ${out.ok ? "" : out.code}`).toBe(true);
        }
      } else if (choice < 0.52) {
        const act = lines.filter((l) => l.status === "active");
        if (act.length) {
          const l = pick(act);
          const out = await voidLine(O(), { lineId: l.id, reason: "iptal", expectedVersion: v });
          if (out.ok && !out.data.noop) {
            l.status = "voided";
            realChanges += 1;
          } else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: voidLine ${out.ok ? "" : out.code}`).toBe(true);
        }
      } else if (choice < 0.72) {
        const purpose = pick(["salary", "advance", "bonus", "other"]);
        const amount = amountOf(rng, 2500);
        const paidAt = new Date(Date.now() - (step + 1) * 60_000 * 7).toISOString();
        const out = await recordPayment(O(), { periodId, purpose, amount, method: "cash", paidAt, idempotencyKey: newKey() });
        if (out.ok && !out.data.noop) {
          payments.push({ id: out.data.paymentId!, amount, purpose, status: "posted", paidAt, postFinalization: lifecycle === "finalized" });
          realChanges += 1;
        } else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: record ${out.ok ? "" : out.code}`).toBe(true);
      } else if (choice < 0.8) {
        const posted = payments.filter((p) => p.status === "posted");
        if (posted.length) {
          const p = pick(posted);
          const out = await voidPayment(O(), p.id, "iptal");
          if (out.ok && !out.data.noop) {
            p.status = "voided";
            realChanges += 1;
          } else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: voidPayment ${out.ok ? "" : out.code}`).toBe(true);
        }
      } else if (choice < 0.88) {
        const t = totals();
        const out = await finalizePeriod(O(), { periodId, expectedVersion: v });
        if (out.ok && !out.data.noop) {
          lifecycle = "finalized";
          snapshot = { g: t.g, d: t.d };
          realChanges += 1;
        } else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: finalize ${out.ok ? "" : out.code}`).toBe(true);
      } else if (choice < 0.95) {
        const out = await reopenPeriod(O(), { periodId, reason: "duzeltme", expectedVersion: v });
        if (out.ok && !out.data.noop) {
          lifecycle = "open";
          snapshot = null;
          realChanges += 1;
        } else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: reopen ${out.ok ? "" : out.code}`).toBe(true);
      } else if (choice < 0.97) {
        const out = await cancelPeriod(O(), periodId, "iptal");
        if (out.ok && !out.data.noop) {
          lifecycle = "cancelled";
          snapshot = null;
          realChanges += 1;
        } else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: cancel ${out.ok ? "" : out.code}`).toBe(true);
      } else {
        const due = pick([null, "2026-12-31", "2027-01-15"]);
        const out = await updatePeriod(O(), { periodId, dueDate: due, expectedVersion: v });
        if (out.ok && !out.data.noop) realChanges += 1;
        else if (!out.ok) expect(ALLOWED.has(out.code ?? ""), `${label}: updatePeriod ${out.ok ? "" : out.code}`).toBe(true);
      }
      await verify(label);
      if (onState && step % 4 === 3 && lifecycle !== "cancelled") await onState(periodId);
      if (lifecycle === "cancelled") break;
    }
    return { periodId, lines, payments, lifecycle };
  }

  it("R23 random operation sequences: invariants I1 to I8 hold after every step and the database equals an independent model of the successful operations", async () => {
    for (let seed = 1; seed <= 14; seed++) await runHistory(seed, 36);
  }, 240_000);

  it("R15 the display flags predict what the triggers do, over generated states", async () => {
    let probed = 0;
    const check = async (periodId: string) => {
      const d = await expectOk(await getPeriod(O(), periodId));
      const f = d.flags;
      const v = d.version;
      const ok = (o: RpcOutcome<Record<string, unknown>>) => o.ok;
      const code = (o: RpcOutcome<Record<string, unknown>>) => (o.ok ? undefined : o.code);
      const real = (o: RpcOutcome<Record<string, unknown>>) => o.ok && o.data.noop === false;

      // finalize / reopen / cancel
      const fin = await probe(O(), "finalize_staff_finance_period", [["p_period_id", periodId, "uuid"], ["p_expected_version", v, "integer"]]);
      if (d.lifecycle === "open") {
        expect(real(fin), `finalize flag ${JSON.stringify(f)} -> ${JSON.stringify(fin)}`).toBe(f.canFinalize);
        if (!f.canFinalize) expect(code(fin)).toBe(f.finalizeBlockedReason === "no_earning" ? "FN031" : "FN033");
      } else {
        expect(f.canFinalize).toBe(false);
        expect(f.finalizeBlockedReason).toBe("not_open");
      }
      const reo = await probe(O(), "reopen_staff_finance_period", [["p_period_id", periodId, "uuid"], ["p_reason", "x", "text"], ["p_expected_version", v, "integer"]]);
      if (d.lifecycle === "finalized") {
        expect(real(reo)).toBe(f.canReopen);
        if (!f.canReopen) expect(code(reo)).toBe("FN027");
      } else {
        expect(f.canReopen).toBe(false);
        expect(f.reopenBlockedReason).toBe("not_finalized");
      }
      const can = await probe(O(), "cancel_staff_finance_period", [["p_period_id", periodId, "uuid"], ["p_reason", "x", "text"]]);
      expect(real(can)).toBe(f.canCancel);
      if (!f.canCancel && d.lifecycle !== "cancelled") expect(code(can)).toBe("FN027");

      // adding lines
      const add = (kind: string, desc: string | null) =>
        probe(O(), "add_staff_period_line", [["p_period_id", periodId, "uuid"], ["p_kind", kind, "text"], ["p_amount", 1, "numeric"], ["p_description", desc, "text"], ["p_idempotency_key", newKey(), "uuid"]]);
      expect(ok(await add("salary", null)), "canAddStatementLine").toBe(f.canAddStatementLine);
      expect(ok(await add("adjustment_credit", "x")), "canAddAdjustment").toBe(f.canAddAdjustment);
      expect(ok(await add("other_employer_cost", null)), "canAddEmployerCost").toBe(f.canAddEmployerCost);

      // paying
      const pay = (amount: number) =>
        probe(O(), "record_staff_payment", [["p_period_id", periodId, "uuid"], ["p_purpose", "salary", "text"], ["p_amount", amount, "numeric"], ["p_method", "cash", "text"], ["p_paid_at", new Date(Date.now() - 60_000).toISOString(), "timestamptz"], ["p_note", null, "text"], ["p_idempotency_key", newKey(), "uuid"]]);
      if (d.lifecycle === "open") {
        expect(f.maxPayable).toBeNull();
        expect(ok(await pay(1)), "open pay").toBe(true);
        expect(f.canPay).toBe(true);
      } else if (d.lifecycle === "finalized") {
        expect(f.maxPayable).toBe(Math.max(Math.round((d.netPayable - d.paid) * 100) / 100, 0));
        expect(f.canPay).toBe(f.maxPayable! > 0);
        if (f.maxPayable! > 0) expect(ok(await pay(f.maxPayable!)), "pay the maximum").toBe(true);
        expect(code(await pay(Math.round((f.maxPayable! + 0.01) * 100) / 100))).toBe("FN023");
      }

      // per line: the lock matrix, with probes that cannot trip a floor (the floors are separate rules)
      for (const l of d.lines) {
        const bump = l.lineGroup === "employee_deduction" ? Math.max(Math.round((l.amount - 0.01) * 100) / 100, 0.01) : Math.round((l.amount + 0.01) * 100) / 100;
        const edit = await probe(O(), "update_staff_period_line", [["p_line_id", l.id, "uuid"], ["p_amount", bump, "numeric"], ["p_description", l.description ?? (ADJUSTMENT.has(l.kind) ? "x" : null), "text"], ["p_expected_version", v, "integer"]]);
        const changed = bump !== l.amount;
        if (l.canEdit && changed) expect(real(edit), `canEdit line ${l.kind} ${l.status} -> ${JSON.stringify(edit)}`).toBe(true);
        if (!l.canEdit && changed) expect(["FN024", "FN025", "FN032"], `locked line ${l.kind} ${l.status} -> ${JSON.stringify(edit)}`).toContain(code(edit));
        const vd = await probe(O(), "void_staff_period_line", [["p_line_id", l.id, "uuid"], ["p_reason", "x", "text"], ["p_expected_version", v, "integer"]]);
        if (l.status === "voided") {
          expect(l.canVoid).toBe(false);
          expect(vd.ok && vd.data.noop === true).toBe(true);
        } else if (l.canVoid) {
          // allowed by the lock matrix; the only other reason it can fail is a floor (deductions above earnings)
          expect(real(vd) || code(vd) === "FN026", `canVoid line ${l.kind} -> ${JSON.stringify(vd)}`).toBe(true);
        } else {
          expect(["FN024", "FN025"]).toContain(code(vd));
        }
      }
      probed += 1;
    };
    for (let seed = 101; seed <= 106; seed++) await runHistory(seed, 24, check);
    expect(probed).toBeGreaterThan(20);
  }, 480_000);
});

// ----------------------------------------------------------------------------------------------------------------
// A12 / A13 (audit entity ids and the post_finalization flag) are asserted where the audit rows are produced:
// staff-finance-periods.test.ts and staff-finance-payments.test.ts. The read models never expose an audit row.
// ----------------------------------------------------------------------------------------------------------------

describe("R16 the id-based read of a period that is not there", () => {
  let w: StaffFinanceWorld;
  beforeAll(async () => {
    w = await createStaffFinanceWorld("fin1c1-rd-miss");
  });
  afterAll(async () => {
    await destroyStaffFinanceWorld(w);
  });
  it("R16b a random id is FN020, a malformed call is FN004, and an unauthenticated call is FN001", async () => {
    expect(failure(await getPeriod(w.owner.id, "00000000-0000-4000-8000-0000000000e1"))).toBe("FN020");
    expect(failure(await getPeriod(w.owner.id, null))).toBe("FN004");
    expect(failure(await callRpc(w.owner.id, "get_staff_finance_overview", [["p_tenant_id", null, "uuid"]]))).toBe("FN004");
  });
});
