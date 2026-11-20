import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  testDb,
  createStaffFinanceWorld,
  destroyStaffFinanceWorld,
  addLine,
  updateLine,
  voidLine,
  finalizePeriod,
  reopenPeriod,
  cancelPeriod,
  makePeriod,
  makeLine,
  makePayment,
  expectOk,
  periodRow,
  lineRows,
  staffAudit,
  periodDigest,
  newKey,
  KIND_CATALOG,
  EARNING_KINDS,
  DEDUCTION_KINDS,
  EMPLOYER_KINDS,
  ADJUSTMENT_KINDS,
  type StaffFinanceWorld,
  type RpcOutcome,
} from "./staff-finance-fixtures";

/**
 * Faz FIN.1C.1 — period lines (matrix groups V9-V16 / V26 / V28, I7-I14, L1-L10 / L14-L26, LN and the line half of A).
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to
 * whatever TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV
 * database) and fails loudly when they are not.
 */

type Tx = postgres.TransactionSql;

let world: StaffFinanceWorld;

beforeAll(async () => {
  world = await createStaffFinanceWorld("fin1c1-lin");
});

afterAll(async () => {
  await destroyStaffFinanceWorld(world);
});

const T = () => world.tenant.id;
const O = () => world.owner.id;

function failure(out: RpcOutcome<unknown>): string | undefined {
  expect(out.ok, `expected a failure, got ${JSON.stringify(out)}`).toBe(false);
  return out.ok ? undefined : out.code;
}

/** An open period that already holds an earning salary line. */
async function openWithSalary(amount: number | string = 100000) {
  const p = await makePeriod(world);
  const l = await makeLine(p.periodId, "salary", amount, { description: "Maaş" }, world.owner);
  return { periodId: p.periodId, salaryId: l.lineId! };
}

async function finalize(periodId: string) {
  const v = (await periodRow(periodId)).version;
  return expectOk(await finalizePeriod(O(), { periodId, expectedVersion: v }));
}

async function version(periodId: string) {
  return (await periodRow(periodId)).version;
}

/** Runs `fn` as the owner inside ONE transaction that is always rolled back, so a catalog experiment is never visible to
 * any other connection or test. */
async function rolledBack(fn: (sql: Tx) => Promise<void>): Promise<void> {
  const marker = new Error("rollback");
  try {
    await testDb.begin(async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: O(), role: "authenticated" })}, true),
                       set_config('request.jwt.claim.sub', ${O()}, true)`;
      await fn(sql);
      throw marker;
    });
  } catch (e) {
    if (e !== marker) throw e;
  }
}

// =================================================================================================================
// V — add_staff_period_line / update_staff_period_line validation
// =================================================================================================================
describe("V line validation", () => {
  it("V9 an unknown kind is FN030, a malformed kind FN004, an inactive kind FN030", async () => {
    const { periodId } = await openWithSalary();
    const digest = await periodDigest(periodId);
    expect(failure(await addLine(O(), { periodId, kind: "no_such_kind", amount: 10, idempotencyKey: newKey() }))).toBe("FN030");
    for (const kind of ["Bad Kind", "", "SALARY", "x"]) {
      expect(failure(await addLine(O(), { periodId, kind, amount: 10, idempotencyKey: newKey() })), kind).toBe("FN004");
    }
    expect(failure(await addLine(O(), { periodId, kind: null, amount: 10, idempotencyKey: newKey() }))).toBe("FN004");
    await rolledBack(async (sql) => {
      await sql`update staff_line_kinds set is_active = false where code = 'other_earning'`;
      await expect(
        sql.unsafe(`select public.add_staff_period_line(p_period_id := '${periodId}', p_kind := 'other_earning', p_amount := 10, p_idempotency_key := '${newKey()}')`),
      ).rejects.toMatchObject({ code: "FN030" });
    });
    expect(await periodDigest(periodId)).toBe(digest);
  });

  it.each([["0"], ["-1"], ["NaN"], ["Infinity"], ["-Infinity"], ["0.001"], ["1.005"], ["10000000000"], ["99999999999999.99"], [null]])(
    "V10 amount %s is FN004 with zero rows",
    async (amount) => {
      const { periodId } = await openWithSalary();
      const digest = await periodDigest(periodId);
      expect(failure(await addLine(O(), { periodId, kind: "bonus", amount, idempotencyKey: newKey() }))).toBe("FN004");
      expect(await periodDigest(periodId)).toBe(digest);
    },
  );

  it("V11 a description above 200 and an adjustment kind without a description are FN004", async () => {
    const { periodId } = await openWithSalary();
    expect(failure(await addLine(O(), { periodId, kind: "bonus", amount: 10, description: "x".repeat(201), idempotencyKey: newKey() }))).toBe("FN004");
    for (const description of [undefined, null, "", "   ", "\t\n"]) {
      expect(failure(await addLine(O(), { periodId, kind: "adjustment_credit", amount: 10, description, idempotencyKey: newKey() }))).toBe("FN004");
    }
    const ok = await expectOk(await addLine(O(), { periodId, kind: "adjustment_credit", amount: 10, description: "x".repeat(200), idempotencyKey: newKey() }));
    expect(ok.noop).toBe(false);
  });

  it("V12 / LN10 the 101st line is FN004, voided lines count toward the cap", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 1000000, {}, world.owner);
    const ids: string[] = [];
    for (let i = 1; i < 100; i++) {
      const r = await makeLine(p.periodId, "other_employer_cost", 1, {}, world.owner);
      ids.push(r.lineId!);
    }
    expect(await lineRows(p.periodId)).toHaveLength(100);
    const digest = await periodDigest(p.periodId);
    expect(failure(await addLine(O(), { periodId: p.periodId, kind: "bonus", amount: 1, idempotencyKey: newKey() }))).toBe("FN004");
    // a voided line still counts
    const v = await version(p.periodId);
    await expectOk(await voidLine(O(), { lineId: ids[0]!, reason: "iptal", expectedVersion: v }));
    expect(failure(await addLine(O(), { periodId: p.periodId, kind: "bonus", amount: 1, idempotencyKey: newKey() }))).toBe("FN004");
    expect(await lineRows(p.periodId)).toHaveLength(100);
    expect(await periodDigest(p.periodId)).not.toBe(digest); // only the void changed it
  });

  it("V13 a null or omitted key is FN004", async () => {
    const { periodId } = await openWithSalary();
    expect(failure(await addLine(O(), { periodId, kind: "bonus", amount: 10, idempotencyKey: null }))).toBe("FN004");
    expect(failure(await addLine(O(), { periodId, kind: "bonus", amount: 10 }))).toBe("FN004");
  });

  it("V14 a deduction line on a period with an earning total of 0 is FN026", async () => {
    const p = await makePeriod(world);
    const digest = await periodDigest(p.periodId);
    expect(failure(await addLine(O(), { periodId: p.periodId, kind: "other_deduction", amount: 1, idempotencyKey: newKey() }))).toBe("FN026");
    expect(await periodDigest(p.periodId)).toBe(digest);
  });

  it("V15 a deduction that makes D exceed G is FN026; one that equals G succeeds", async () => {
    const { periodId } = await openWithSalary(1000);
    expect(failure(await addLine(O(), { periodId, kind: "other_deduction", amount: 1000.01, idempotencyKey: newKey() }))).toBe("FN026");
    const ok = await expectOk(await addLine(O(), { periodId, kind: "other_deduction", amount: 1000, idempotencyKey: newKey() }));
    expect(ok.paymentState).toBe("nothing_due");
    expect((await periodRow(periodId)).net_payable).toBe("0.00");
  });

  it("V16 an employer-cost line on a period with an earning total of 0 succeeds (no floor applies)", async () => {
    const p = await makePeriod(world);
    const out = await expectOk(await addLine(O(), { periodId: p.periodId, kind: "employer_social_insurance", amount: 3500, idempotencyKey: newKey() }));
    expect(out.noop).toBe(false);
    expect((await periodRow(p.periodId)).employer_cost_total).toBe("3500.00");
  });

  it("V26 a paye line is accepted as a manual employee deduction with the typed amount", async () => {
    const { periodId } = await openWithSalary(5000);
    const out = await expectOk(await addLine(O(), { periodId, kind: "paye", amount: 1000, description: "FIN.1C stopaj", idempotencyKey: newKey() }));
    const lines = await lineRows(periodId);
    const paye = lines.find((l) => l.id === out.lineId)!;
    expect([paye.line_group, paye.institution, paye.calculation_source, paye.amount]).toEqual(["employee_deduction", null, "manual", "1000.00"]);
    expect((await periodRow(periodId)).employee_deduction_total).toBe("1000.00");
  });

  it("V28 update_staff_period_line: a description above 200 and an adjustment line with the description cleared are FN004", async () => {
    const { periodId, salaryId } = await openWithSalary();
    const v = await version(periodId);
    expect(failure(await updateLine(O(), { lineId: salaryId, amount: 100000, description: "x".repeat(201), expectedVersion: v }))).toBe("FN004");
    const adj = await makeLine(periodId, "adjustment_credit", 50, { description: "düzeltme" }, world.owner);
    const v2 = await version(periodId);
    for (const description of [null, "", "   "]) {
      expect(failure(await updateLine(O(), { lineId: adj.lineId!, amount: 50, description, expectedVersion: v2 }))).toBe("FN004");
    }
    expect(failure(await updateLine(O(), { lineId: adj.lineId!, amount: 50, expectedVersion: v2 }))).toBe("FN004");
  });
});

// =================================================================================================================
// I — add-line idempotency
// =================================================================================================================
describe("I add-line idempotency", () => {
  it("I7 a replay is a noop with the existing line id, zero writes and zero audit", async () => {
    const { periodId } = await openWithSalary();
    const input = { periodId, kind: "bonus", amount: 250, description: "Prim", idempotencyKey: newKey() };
    const first = await expectOk(await addLine(O(), input));
    const digest = await periodDigest(periodId);
    const audit = (await staffAudit(T())).length;
    const again = await expectOk(await addLine(O(), input));
    expect(again).toEqual({ ...first, noop: true });
    expect(await periodDigest(periodId)).toBe(digest);
    expect((await staffAudit(T())).length).toBe(audit);
  });

  it("I8a-d / I12 the same key with a different period, kind, amount or description is FN007", async () => {
    const a = await openWithSalary();
    const b = await openWithSalary();
    const base = { periodId: a.periodId, kind: "bonus", amount: "30000.00", description: "Prim", idempotencyKey: newKey() };
    await expectOk(await addLine(O(), base));
    const digest = await periodDigest(a.periodId);
    const variants = [
      { ...base, periodId: b.periodId }, // I8a / I12: another period of the same tenant
      { ...base, kind: "commission" }, // I8b
      { ...base, amount: "30000.01" }, // I8c
      { ...base, description: "Başka" }, // I8d
      { ...base, description: undefined }, // description dropped
    ];
    for (const v of variants) {
      expect(failure(await addLine(O(), v))).toBe("FN007");
    }
    expect(await periodDigest(a.periodId)).toBe(digest);
  });

  it("I8e a whitespace-only description and an absent one are the same payload (noop)", async () => {
    const { periodId } = await openWithSalary();
    const key = newKey();
    const first = await expectOk(await addLine(O(), { periodId, kind: "bonus", amount: 5, description: "   ", idempotencyKey: key }));
    const second = await expectOk(await addLine(O(), { periodId, kind: "bonus", amount: 5, idempotencyKey: key }));
    expect([second.noop, second.lineId]).toEqual([true, first.lineId]);
    const third = await expectOk(await addLine(O(), { periodId, kind: "bonus", amount: 5, description: "\t", idempotencyKey: key }));
    expect(third.noop).toBe(true);
  });

  it("I9 the amount representations 250.5, 250.50 and 250.500 are the same payload", async () => {
    const { periodId } = await openWithSalary();
    const key = newKey();
    const first = await expectOk(await addLine(O(), { periodId, kind: "bonus", amount: "250.5", idempotencyKey: key }));
    for (const amount of ["250.50", "250.500", 250.5]) {
      const r = await expectOk(await addLine(O(), { periodId, kind: "bonus", amount, idempotencyKey: key }));
      expect([r.noop, r.lineId]).toEqual([true, first.lineId]);
    }
    expect((await lineRows(periodId)).filter((l) => l.kind === "bonus")).toHaveLength(1);
  });

  it("I10 a replay after the line was edited or voided is a noop", async () => {
    const { periodId } = await openWithSalary();
    const input = { periodId, kind: "bonus", amount: 100, description: "Prim", idempotencyKey: newKey() };
    const first = await expectOk(await addLine(O(), input));
    await expectOk(await updateLine(O(), { lineId: first.lineId!, amount: 150, description: "Prim (düz.)", expectedVersion: first.version }));
    expect((await expectOk(await addLine(O(), input))).noop).toBe(true);
    const v = await version(periodId);
    await expectOk(await voidLine(O(), { lineId: first.lineId!, reason: "iptal", expectedVersion: v }));
    const again = await expectOk(await addLine(O(), input));
    expect([again.noop, again.lineId]).toEqual([true, first.lineId]);
  });

  it("I11 a replay after the period was finalized or cancelled is a noop", async () => {
    const { periodId } = await openWithSalary();
    const input = { periodId, kind: "private_insurance", amount: 100, idempotencyKey: newKey() };
    const first = await expectOk(await addLine(O(), input));
    await finalize(periodId);
    const afterFinalize = await expectOk(await addLine(O(), input));
    expect([afterFinalize.noop, afterFinalize.lineId, afterFinalize.lifecycle]).toEqual([true, first.lineId, "finalized"]);
    await expectOk(await cancelPeriod(O(), periodId, "iptal"));
    const afterCancel = await expectOk(await addLine(O(), input));
    expect([afterCancel.noop, afterCancel.lifecycle]).toEqual([true, "cancelled"]);
  });

  it("I14 a pipe inside a description does not shift a boundary", async () => {
    const { periodId } = await openWithSalary();
    const key = newKey();
    const input = { periodId, kind: "adjustment_credit", amount: "0.05", description: "Düzeltme | komisyon", idempotencyKey: key };
    const first = await expectOk(await addLine(O(), input));
    expect((await expectOk(await addLine(O(), input))).lineId).toBe(first.lineId);
    expect(failure(await addLine(O(), { ...input, description: "Düzeltme | komisyon2" }))).toBe("FN007");
    expect(failure(await addLine(O(), { ...input, description: "Düzeltme" }))).toBe("FN007");
  });
});

// =================================================================================================================
// L — the lock matrix at line level
// =================================================================================================================
describe("L line lifecycle and the lock matrix", () => {
  it.each(KIND_CATALOG.map((k) => [k[0]]))("L1 / VR2 open: add the %s kind succeeds and bumps the version by one", async (kind) => {
    const { periodId } = await openWithSalary();
    const v = await version(periodId);
    const out = await expectOk(
      await addLine(O(), { periodId, kind, amount: 100, description: "Test", idempotencyKey: newKey() }),
    );
    expect([out.noop, out.version]).toEqual([false, v + 1]);
    const stored = (await lineRows(periodId)).find((l) => l.id === out.lineId)!;
    const catalog = KIND_CATALOG.find((k) => k[0] === kind)!;
    expect([stored.line_group, stored.institution]).toEqual([catalog[1], catalog[2]]);
    expect(stored.post_finalization).toBe(false);
  });

  it("L2 / L3 open: edit the amount of, and void, a line of each group", async () => {
    const { periodId } = await openWithSalary();
    const lines: Record<string, string> = {};
    for (const kind of ["bonus", "other_deduction", "private_insurance"]) {
      lines[kind] = (await makeLine(periodId, kind, 100, {}, world.owner)).lineId!;
    }
    for (const [kind, id] of Object.entries(lines)) {
      const v = await version(periodId);
      const edit = await expectOk(await updateLine(O(), { lineId: id, amount: 200, expectedVersion: v }));
      expect([kind, edit.version]).toEqual([kind, v + 1]);
      expect((await lineRows(periodId)).find((l) => l.id === id)!.amount).toBe("200.00");
    }
    for (const [kind, id] of Object.entries(lines)) {
      const v = await version(periodId);
      const voided = await expectOk(await voidLine(O(), { lineId: id, reason: "iptal", expectedVersion: v }));
      expect([kind, voided.version]).toEqual([kind, v + 1]);
      expect((await lineRows(periodId)).find((l) => l.id === id)!.status).toBe("voided");
    }
  });

  it.each([...EARNING_KINDS, ...DEDUCTION_KINDS].map((k) => [k]))(
    "L4 finalized: adding the %s kind is FN024",
    async (kind) => {
      const { periodId } = await openWithSalary();
      await finalize(periodId);
      const digest = await periodDigest(periodId);
      expect(failure(await addLine(O(), { periodId, kind, amount: 5, description: "Test", idempotencyKey: newKey() }))).toBe("FN024");
      expect(await periodDigest(periodId)).toBe(digest);
    },
  );

  it.each(ADJUSTMENT_KINDS.map((k) => [k]))("L5 finalized: %s with a description succeeds, flagged post_finalization, snapshot unchanged", async (kind) => {
    const { periodId } = await openWithSalary(10000);
    const fin = await finalize(periodId);
    const snapshot = (await periodRow(periodId)).finalized_net_payable;
    const out = await expectOk(await addLine(O(), { periodId, kind, amount: 100, description: "Düzeltme", idempotencyKey: newKey() }));
    expect(out.version).toBe(fin.version + 1);
    const stored = (await lineRows(periodId)).find((l) => l.id === out.lineId)!;
    expect(stored.post_finalization).toBe(true);
    expect((await periodRow(periodId)).finalized_net_payable).toBe(snapshot);
  });

  it.each(EMPLOYER_KINDS.map((k) => [k]))("L6 finalized: adding the %s employer-cost kind succeeds (+1, one audit event, flagged)", async (kind) => {
    const { periodId } = await openWithSalary();
    const fin = await finalize(periodId);
    const before = (await staffAudit(T(), "finance.staff_line_added")).length;
    const out = await expectOk(await addLine(O(), { periodId, kind, amount: 100, idempotencyKey: newKey() }));
    expect(out.version).toBe(fin.version + 1);
    expect((await lineRows(periodId)).find((l) => l.id === out.lineId)!.post_finalization).toBe(true);
    expect((await staffAudit(T(), "finance.staff_line_added")).length).toBe(before + 1);
  });

  it("L7 finalized: editing the amount of an earning or deduction line is FN024; of an employer-cost line it succeeds (+1, audited)", async () => {
    const p = await makePeriod(world);
    const sal = await makeLine(p.periodId, "salary", 10000, {}, world.owner);
    const ded = await makeLine(p.periodId, "paye", 500, {}, world.owner);
    const emp = await makeLine(p.periodId, "private_insurance", 300, {}, world.owner);
    const fin = await finalize(p.periodId);
    const digest = await periodDigest(p.periodId);
    for (const id of [sal.lineId!, ded.lineId!]) {
      expect(failure(await updateLine(O(), { lineId: id, amount: 1, expectedVersion: fin.version }))).toBe("FN024");
    }
    expect(await periodDigest(p.periodId)).toBe(digest);
    const audits = (await staffAudit(T(), "finance.staff_line_updated")).length;
    const ok = await expectOk(await updateLine(O(), { lineId: emp.lineId!, amount: 350, expectedVersion: fin.version }));
    expect(ok.version).toBe(fin.version + 1);
    expect((await staffAudit(T(), "finance.staff_line_updated")).length).toBe(audits + 1);
  });

  it("L8 finalized: voiding an earning or deduction line is FN024; an employer-cost line succeeds (+1, audited)", async () => {
    const p = await makePeriod(world);
    const sal = await makeLine(p.periodId, "salary", 10000, {}, world.owner);
    const ded = await makeLine(p.periodId, "paye", 500, {}, world.owner);
    const emp = await makeLine(p.periodId, "private_insurance", 300, {}, world.owner);
    const fin = await finalize(p.periodId);
    const digest = await periodDigest(p.periodId);
    for (const id of [sal.lineId!, ded.lineId!]) {
      expect(failure(await voidLine(O(), { lineId: id, reason: "iptal", expectedVersion: fin.version }))).toBe("FN024");
    }
    expect(await periodDigest(p.periodId)).toBe(digest);
    const audits = (await staffAudit(T(), "finance.staff_line_voided")).length;
    const ok = await expectOk(await voidLine(O(), { lineId: emp.lineId!, reason: "iptal", expectedVersion: fin.version }));
    expect(ok.version).toBe(fin.version + 1);
    expect((await staffAudit(T(), "finance.staff_line_voided")).length).toBe(audits + 1);
  });

  it("L9 / L10 finalized: an adjustment line can be neither edited nor voided; after a reopen it can", async () => {
    const { periodId } = await openWithSalary(10000);
    const fin = await finalize(periodId);
    const adj = await expectOk(await addLine(O(), { periodId, kind: "adjustment_credit", amount: 100, description: "Düzeltme", idempotencyKey: newKey() }));
    const v = adj.version;
    expect(failure(await updateLine(O(), { lineId: adj.lineId!, amount: 200, description: "Düzeltme", expectedVersion: v }))).toBe("FN024");
    expect(failure(await voidLine(O(), { lineId: adj.lineId!, reason: "iptal", expectedVersion: v }))).toBe("FN024");
    const reopened = await expectOk(await reopenPeriod(O(), { periodId, reason: "düzelt", expectedVersion: v }));
    expect(reopened.version).toBe(v + 1);
    const voided = await expectOk(await voidLine(O(), { lineId: adj.lineId!, reason: "iptal", expectedVersion: reopened.version }));
    expect(voided.version).toBe(reopened.version + 1);
    expect(fin.version).toBeLessThan(v);
  });

  it("L14 open: lowering the salary below the paid total is allowed and the period becomes overpaid", async () => {
    const { periodId, salaryId } = await openWithSalary(1000);
    await makePayment(periodId, 800, {}, world.owner);
    const v = await version(periodId);
    const out = await expectOk(await updateLine(O(), { lineId: salaryId, amount: 500, description: "Maaş", expectedVersion: v }));
    expect(out.paymentState).toBe("overpaid");
  });

  it("L15 finalized: an adjustment_debit that would put the net below the payments is FN026; one that leaves it equal succeeds", async () => {
    const { periodId } = await openWithSalary(1000);
    await makePayment(periodId, 600, {}, world.owner);
    await finalize(periodId);
    const digest = await periodDigest(periodId);
    expect(failure(await addLine(O(), { periodId, kind: "adjustment_debit", amount: 400.01, description: "Düzeltme", idempotencyKey: newKey() }))).toBe("FN026");
    expect(await periodDigest(periodId)).toBe(digest);
    const ok = await expectOk(await addLine(O(), { periodId, kind: "adjustment_debit", amount: 400, description: "Düzeltme", idempotencyKey: newKey() }));
    expect(ok.paymentState).toBe("paid");
  });

  it("L16 open: raising a deduction so that D exceeds G is FN026", async () => {
    const { periodId } = await openWithSalary(1000);
    const ded = await makeLine(periodId, "other_deduction", 400, {}, world.owner);
    const v = await version(periodId);
    expect(failure(await updateLine(O(), { lineId: ded.lineId!, amount: 1000.01, expectedVersion: v }))).toBe("FN026");
    expect((await expectOk(await updateLine(O(), { lineId: ded.lineId!, amount: 1000, expectedVersion: v }))).noop).toBe(false);
    // lowering the earning below the deductions through an edit or a void is FN026 as well
    const sal = (await lineRows(periodId)).find((l) => l.kind === "salary")!;
    const v2 = await version(periodId);
    expect(failure(await updateLine(O(), { lineId: sal.id, amount: 999, description: "Maaş", expectedVersion: v2 }))).toBe("FN026");
    expect(failure(await voidLine(O(), { lineId: sal.id, reason: "iptal", expectedVersion: v2 }))).toBe("FN026");
  });

  it("L17 editing a voided line is FN032 (a noop edit is a noop)", async () => {
    const { periodId } = await openWithSalary();
    const bonus = await makeLine(periodId, "bonus", 100, {}, world.owner);
    const v = await version(periodId);
    const voided = await expectOk(await voidLine(O(), { lineId: bonus.lineId!, reason: "iptal", expectedVersion: v }));
    expect(failure(await updateLine(O(), { lineId: bonus.lineId!, amount: 200, expectedVersion: voided.version }))).toBe("FN032");
    expect((await expectOk(await updateLine(O(), { lineId: bonus.lineId!, amount: 100, expectedVersion: voided.version }))).noop).toBe(true);
    const again = await expectOk(await voidLine(O(), { lineId: bonus.lineId!, reason: "tekrar", expectedVersion: voided.version }));
    expect([again.noop, again.version]).toEqual([true, voided.version]);
  });

  it("L18 employer-cost lines of any size never affect N, P or the floors", async () => {
    const { periodId } = await openWithSalary(1000);
    const before = await periodRow(periodId);
    await makeLine(periodId, "employer_social_insurance", "9999999999.99", {}, world.owner);
    const after = await periodRow(periodId);
    expect([after.net_payable, after.paid_total, after.employee_deduction_total]).toEqual([before.net_payable, before.paid_total, before.employee_deduction_total]);
    expect(after.employer_cost_total).toBe("9999999999.99");
    await finalize(periodId);
    // a total above the supported column range is a stable FN004 (never a raw numeric overflow) and writes nothing
    const v = await version(periodId);
    expect(failure(await addLine(O(), { periodId, kind: "other_employer_cost", amount: 1, idempotencyKey: newKey() }))).toBe("FN004");
    expect(await version(periodId)).toBe(v);
  });

  it("L19 / VR4 / VR5 description edit while open: description-only +1 with before/after audit; the same value is a noop; clearing works on a normal line only", async () => {
    const { periodId, salaryId } = await openWithSalary(1000);
    const v0 = await version(periodId);
    const audits = async () => (await staffAudit(T(), "finance.staff_line_updated", salaryId)).length;
    const a0 = await audits();
    const e1 = await expectOk(await updateLine(O(), { lineId: salaryId, amount: 1000, description: "Yeni açıklama", expectedVersion: v0 }));
    expect([e1.noop, e1.version]).toEqual([false, v0 + 1]);
    expect(await audits()).toBe(a0 + 1);
    const [ev] = (await staffAudit(T(), "finance.staff_line_updated", salaryId)).slice(-1);
    expect(ev!.before).toEqual({ amount: 1000, description: "Maaş" });
    expect(ev!.after).toMatchObject({ amount: 1000, description: "Yeni açıklama", kind: "salary", period_id: periodId, post_finalization: false });
    // the same description again: a noop with no bump and no audit
    const e2 = await expectOk(await updateLine(O(), { lineId: salaryId, amount: 1000, description: "Yeni açıklama", expectedVersion: e1.version }));
    expect([e2.noop, e2.version]).toEqual([true, e1.version]);
    expect(await audits()).toBe(a0 + 1);
    // clearing succeeds on a normal line (and stores null)
    const e3 = await expectOk(await updateLine(O(), { lineId: salaryId, amount: 1000, description: null, expectedVersion: e2.version }));
    expect([e3.noop, e3.version]).toEqual([false, e1.version + 1]);
    expect((await lineRows(periodId)).find((l) => l.id === salaryId)!.description).toBeNull();
    const [ev3] = (await staffAudit(T(), "finance.staff_line_updated", salaryId)).slice(-1);
    expect(ev3!.before).toEqual({ amount: 1000, description: "Yeni açıklama" });
    expect(ev3!.after).toMatchObject({ amount: 1000, description: null });
    // clearing an adjustment line is FN004
    const adj = await makeLine(periodId, "adjustment_debit", 10, { description: "d" }, world.owner);
    expect(failure(await updateLine(O(), { lineId: adj.lineId!, amount: 10, description: null, expectedVersion: await version(periodId) }))).toBe("FN004");
  });

  it("L20 / L21 changing a line's kind and un-voiding a line are FN032 (raw SQL)", async () => {
    const { periodId } = await openWithSalary();
    const bonus = await makeLine(periodId, "bonus", 100, {}, world.owner);
    const v = await version(periodId);
    await expect(
      testDb.unsafe(`update staff_period_lines set kind = 'commission' where id = '${bonus.lineId}'`),
    ).rejects.toMatchObject({ code: "FN032" });
    await expectOk(await voidLine(O(), { lineId: bonus.lineId!, reason: "iptal", expectedVersion: v }));
    await expect(
      testDb.unsafe(`update staff_period_lines set status = 'active', voided_at = null, voided_by = null, void_reason = null where id = '${bonus.lineId}'`),
    ).rejects.toMatchObject({ code: "FN032" });
  });

  it("L22 an edit with a stale expected version is FN013 and writes nothing", async () => {
    const { periodId, salaryId } = await openWithSalary();
    const v = await version(periodId);
    const digest = await periodDigest(periodId);
    expect(failure(await updateLine(O(), { lineId: salaryId, amount: 5, expectedVersion: v - 1 }))).toBe("FN013");
    expect(failure(await updateLine(O(), { lineId: salaryId, amount: 5, expectedVersion: v + 1 }))).toBe("FN013");
    expect(await periodDigest(periodId)).toBe(digest);
  });

  it("L23 / VR16 every employer-cost adjustment after finalization (add, edit, void) is exactly one bump and one audit event", async () => {
    const { periodId } = await openWithSalary();
    const fin = await finalize(periodId);
    const events = async () => (await staffAudit(T())).filter((e) => (e.after as { period_id?: string } | null)?.period_id === periodId).length;
    const e0 = await events();
    const add = await expectOk(await addLine(O(), { periodId, kind: "employer_social_insurance", amount: 100, idempotencyKey: newKey() }));
    expect([add.version, await events()]).toEqual([fin.version + 1, e0 + 1]);
    const edit = await expectOk(await updateLine(O(), { lineId: add.lineId!, amount: 120, expectedVersion: add.version }));
    expect([edit.version, await events()]).toEqual([add.version + 1, e0 + 2]);
    const del = await expectOk(await voidLine(O(), { lineId: add.lineId!, reason: "iptal", expectedVersion: edit.version }));
    expect([del.version, await events()]).toEqual([edit.version + 1, e0 + 3]);
  });

  it("L24 finalized: editing the description of an earning or deduction line is FN024; of an employer-cost line it succeeds (+1, audited with before and after)", async () => {
    const p = await makePeriod(world);
    const sal = await makeLine(p.periodId, "salary", 10000, { description: "Maaş" }, world.owner);
    const ded = await makeLine(p.periodId, "paye", 500, { description: "Stopaj" }, world.owner);
    const emp = await makeLine(p.periodId, "private_insurance", 300, { description: "Sigorta" }, world.owner);
    const fin = await finalize(p.periodId);
    const digest = await periodDigest(p.periodId);
    expect(failure(await updateLine(O(), { lineId: sal.lineId!, amount: 10000, description: "Başka", expectedVersion: fin.version }))).toBe("FN024");
    expect(failure(await updateLine(O(), { lineId: ded.lineId!, amount: 500, description: "Başka", expectedVersion: fin.version }))).toBe("FN024");
    expect(await periodDigest(p.periodId)).toBe(digest);
    const ok = await expectOk(await updateLine(O(), { lineId: emp.lineId!, amount: 300, description: "Sigorta (güncel)", expectedVersion: fin.version }));
    expect(ok.version).toBe(fin.version + 1);
    const [ev] = (await staffAudit(T(), "finance.staff_line_updated", emp.lineId!)).slice(-1);
    expect(ev!.before).toEqual({ amount: 300, description: "Sigorta" });
    expect(ev!.after).toMatchObject({ amount: 300, description: "Sigorta (güncel)", post_finalization: false });
  });

  it("L25 cancelled: editing the amount or the description of a line is FN025", async () => {
    const { periodId, salaryId } = await openWithSalary();
    const c = await expectOk(await cancelPeriod(O(), periodId, "iptal"));
    const digest = await periodDigest(periodId);
    expect(failure(await updateLine(O(), { lineId: salaryId, amount: 5, description: "Maaş", expectedVersion: c.version }))).toBe("FN025");
    expect(failure(await updateLine(O(), { lineId: salaryId, amount: 100000, description: "Başka", expectedVersion: c.version }))).toBe("FN025");
    expect(await periodDigest(periodId)).toBe(digest);
  });

  it("L26 an amount and a description changed in one call: one bump, one audit event with both before and after; a stale version is FN013", async () => {
    const { periodId, salaryId } = await openWithSalary(1000);
    const v = await version(periodId);
    expect(failure(await updateLine(O(), { lineId: salaryId, amount: 2000, description: "Yeni", expectedVersion: v - 1 }))).toBe("FN013");
    const before = (await staffAudit(T(), "finance.staff_line_updated", salaryId)).length;
    const out = await expectOk(await updateLine(O(), { lineId: salaryId, amount: 2000, description: "Yeni", expectedVersion: v }));
    expect([out.version, out.noop]).toEqual([v + 1, false]);
    const events = await staffAudit(T(), "finance.staff_line_updated", salaryId);
    expect(events).toHaveLength(before + 1);
    const ev = events[events.length - 1]!;
    expect(ev.before).toEqual({ amount: 1000, description: "Maaş" });
    expect(ev.after).toMatchObject({ amount: 2000, description: "Yeni" });
  });
});

// =================================================================================================================
// LN — line semantics
// =================================================================================================================
describe("LN line semantics", () => {
  it("LN1 / LN2 group and institution are copied from the catalog for all 16 kinds; the institution tag exists only on the four SI and PF kinds", async () => {
    const { periodId } = await openWithSalary();
    for (const [kind, group, institution] of KIND_CATALOG) {
      if (kind === "salary") continue;
      await makeLine(periodId, kind, 10, { description: "Test" }, world.owner);
      expect(
        (await lineRows(periodId)).filter((l) => l.kind === kind).map((l) => [l.line_group, l.institution]),
        kind,
      ).toEqual([[group, institution]]);
    }
    const tagged = (await lineRows(periodId)).filter((l) => l.institution !== null).map((l) => l.kind).sort();
    expect(tagged).toEqual(["employee_provident_fund", "employee_social_insurance", "employer_provident_fund", "employer_social_insurance"]);
  });

  it("LN3 the example vector: G 35,000, D 5,000, E 5,000, net 30,000", async () => {
    const p = await makePeriod(world);
    for (const [kind, amount] of [
      ["salary", 30000], ["commission", 3000], ["overtime", 2000],
      ["employee_social_insurance", 2500], ["employee_provident_fund", 1500], ["paye", 1000],
      ["employer_social_insurance", 3500], ["employer_provident_fund", 1500],
    ] as const) {
      await makeLine(p.periodId, kind, amount, {}, world.owner);
    }
    const row = await periodRow(p.periodId);
    expect([row.earning_total, row.employee_deduction_total, row.employer_cost_total, row.net_payable]).toEqual([
      "35000.00", "5000.00", "5000.00", "30000.00",
    ]);
  });

  it("LN4 voided lines are excluded from the totals", async () => {
    const { periodId } = await openWithSalary(1000);
    const bonus = await makeLine(periodId, "bonus", 500, {}, world.owner);
    expect((await periodRow(periodId)).earning_total).toBe("1500.00");
    await expectOk(await voidLine(O(), { lineId: bonus.lineId!, reason: "iptal", expectedVersion: await version(periodId) }));
    expect((await periodRow(periodId)).earning_total).toBe("1000.00");
  });

  it("LN5 adjustment_credit counts as earning and adjustment_debit as an employee deduction", async () => {
    const { periodId } = await openWithSalary(1000);
    await makeLine(periodId, "adjustment_credit", 100, { description: "d" }, world.owner);
    await makeLine(periodId, "adjustment_debit", 40, { description: "d" }, world.owner);
    const row = await periodRow(periodId);
    expect([row.earning_total, row.employee_deduction_total, row.net_payable]).toEqual(["1100.00", "40.00", "1060.00"]);
  });

  it("LN6 the amount has two decimals and a minimum of 0.01", async () => {
    const { periodId } = await openWithSalary();
    expect((await expectOk(await addLine(O(), { periodId, kind: "bonus", amount: "0.01", idempotencyKey: newKey() }))).noop).toBe(false);
    expect(failure(await addLine(O(), { periodId, kind: "bonus", amount: "0.001", idempotencyKey: newKey() }))).toBe("FN004");
    expect(failure(await addLine(O(), { periodId, kind: "bonus", amount: "0", idempotencyKey: newKey() }))).toBe("FN004");
  });

  it("LN7 the description is optional except for adjustments", async () => {
    const { periodId } = await openWithSalary();
    const out = await expectOk(await addLine(O(), { periodId, kind: "bonus", amount: 5, idempotencyKey: newKey() }));
    expect((await lineRows(periodId)).find((l) => l.id === out.lineId)!.description).toBeNull();
    expect(failure(await addLine(O(), { periodId, kind: "adjustment_debit", amount: 5, idempotencyKey: newKey() }))).toBe("FN004");
  });

  it("LN8 calculation_source is always manual (CHECK)", async () => {
    const { periodId } = await openWithSalary();
    const [row] = await testDb<{ tenant_id: string; currency: string }[]>`select tenant_id, currency from staff_finance_periods where id = ${periodId}`;
    await expect(
      testDb.unsafe(
        `insert into staff_period_lines (tenant_id, period_id, currency, kind, line_group, amount, calculation_source, idempotency_key, idempotency_fingerprint)
         values ('${row!.tenant_id}', '${periodId}', '${row!.currency}', 'bonus', 'earning', 1, 'rule_engine', '${newKey()}', '${"a".repeat(32)}')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("LN9 a catalog change after a line exists leaves the line's snapshot alone and applies to new lines only (rolled back)", async () => {
    const { periodId } = await openWithSalary(1000);
    const bonus = await makeLine(periodId, "bonus", 100, {}, world.owner);
    await rolledBack(async (sql) => {
      await sql`update staff_line_kinds set line_group = 'employer_cost' where code = 'bonus'`;
      const [kept] = await sql<{ line_group: string }[]>`select line_group from staff_period_lines where id = ${bonus.lineId!}`;
      expect(kept!.line_group).toBe("earning");
      const out = await sql.unsafe(
        `select public.add_staff_period_line(p_period_id := '${periodId}', p_kind := 'bonus', p_amount := 7, p_idempotency_key := '${newKey()}') as r`,
      );
      const lineId = (out[0] as unknown as { r: { lineId: string } }).r.lineId;
      const [fresh] = await sql<{ line_group: string }[]>`select line_group from staff_period_lines where id = ${lineId}`;
      expect(fresh!.line_group).toBe("employer_cost");
    });
    expect((await lineRows(periodId)).find((l) => l.id === bonus.lineId)!.line_group).toBe("earning");
  });

  it("LN11 the formulas derive from the group: in a scratch catalog, moving a kind to another group moves its new lines between the totals (rolled back)", async () => {
    const { periodId } = await openWithSalary(1000);
    await rolledBack(async (sql) => {
      await sql`update staff_line_kinds set line_group = 'employee_deduction' where code = 'other_earning'`;
      await sql.unsafe(
        `select public.add_staff_period_line(p_period_id := '${periodId}', p_kind := 'other_earning', p_amount := 40, p_idempotency_key := '${newKey()}')`,
      );
      const [row] = await sql<{ g: string; d: string }[]>`select earning_total::text as g, employee_deduction_total::text as d from staff_finance_periods where id = ${periodId}`;
      expect([row!.g, row!.d]).toEqual(["1000.00", "40.00"]);
    });
    const row = await periodRow(periodId);
    expect(row.employee_deduction_total).toBe("0.00");
  });

  it("LN12 description normalization on add and edit: whitespace trimmed, blank becomes null, 200 characters accepted, 201 rejected", async () => {
    const { periodId } = await openWithSalary();
    const a = await expectOk(await addLine(O(), { periodId, kind: "bonus", amount: 5, description: "  \t Prim \n ", idempotencyKey: newKey() }));
    expect((await lineRows(periodId)).find((l) => l.id === a.lineId)!.description).toBe("Prim");
    const b = await expectOk(await addLine(O(), { periodId, kind: "bonus", amount: 5, description: "x".repeat(200), idempotencyKey: newKey() }));
    expect((await lineRows(periodId)).find((l) => l.id === b.lineId)!.description).toHaveLength(200);
    expect(failure(await addLine(O(), { periodId, kind: "bonus", amount: 5, description: "x".repeat(201), idempotencyKey: newKey() }))).toBe("FN004");
    // edit: trimmed, blank becomes null, 200 accepted, 201 rejected
    let v = await version(periodId);
    const e1 = await expectOk(await updateLine(O(), { lineId: a.lineId!, amount: 5, description: "   Yeni   ", expectedVersion: v }));
    expect((await lineRows(periodId)).find((l) => l.id === a.lineId)!.description).toBe("Yeni");
    const e2 = await expectOk(await updateLine(O(), { lineId: a.lineId!, amount: 5, description: "\t \n", expectedVersion: e1.version }));
    expect((await lineRows(periodId)).find((l) => l.id === a.lineId)!.description).toBeNull();
    expect(failure(await updateLine(O(), { lineId: a.lineId!, amount: 5, description: "y".repeat(201), expectedVersion: e2.version }))).toBe("FN004");
    v = e2.version;
    expect((await expectOk(await updateLine(O(), { lineId: a.lineId!, amount: 5, description: "y".repeat(200), expectedVersion: v }))).noop).toBe(false);
  });
});

// =================================================================================================================
// A — line audit
// =================================================================================================================
describe("A line audit", () => {
  it("A2 / A12 / A13 each add writes one finance.staff_line_added with the specified payload and entity; a replay writes none", async () => {
    const { periodId } = await openWithSalary();
    const key = newKey();
    const input = { periodId, kind: "employee_social_insurance", amount: 2500, idempotencyKey: key };
    const out = await expectOk(await addLine(O(), input));
    await expectOk(await addLine(O(), input));
    const events = await staffAudit(T(), "finance.staff_line_added", out.lineId!);
    expect(events).toHaveLength(1);
    expect(events[0]!.entity_type).toBe("staff_period_line");
    expect(events[0]!.actor_user_id).toBe(O());
    expect(events[0]!.before).toBeNull();
    expect(events[0]!.after).toEqual({
      period_id: periodId, kind: "employee_social_insurance", line_group: "employee_deduction", amount: 2500,
      currency: "TRY", post_finalization: false,
    });
    await finalize(periodId);
    const post = await expectOk(await addLine(O(), { periodId, kind: "employer_social_insurance", amount: 10, idempotencyKey: newKey() }));
    const [pe] = await staffAudit(T(), "finance.staff_line_added", post.lineId!);
    expect(pe!.after).toMatchObject({ post_finalization: true });
  });

  it("A3 a line update writes one finance.staff_line_updated; a no-op writes none", async () => {
    const { periodId, salaryId } = await openWithSalary(1000);
    const v = await version(periodId);
    const before = (await staffAudit(T(), "finance.staff_line_updated", salaryId)).length;
    await expectOk(await updateLine(O(), { lineId: salaryId, amount: 1200, description: "Maaş", expectedVersion: v }));
    await expectOk(await updateLine(O(), { lineId: salaryId, amount: 1200, description: "Maaş", expectedVersion: v + 1 }));
    const events = await staffAudit(T(), "finance.staff_line_updated", salaryId);
    expect(events).toHaveLength(before + 1);
    const ev = events[events.length - 1]!;
    expect(ev.before).toEqual({ amount: 1000 }); // the description did not change: no description keys
    expect(ev.after).toMatchObject({ amount: 1200 });
    expect(ev.after).not.toHaveProperty("description");
  });

  it("A4 a line void writes one event with the reason", async () => {
    const { periodId } = await openWithSalary();
    const bonus = await makeLine(periodId, "bonus", 100, {}, world.owner);
    await expectOk(await voidLine(O(), { lineId: bonus.lineId!, reason: "yanlış satır", expectedVersion: await version(periodId) }));
    const events = await staffAudit(T(), "finance.staff_line_voided", bonus.lineId!);
    expect(events).toHaveLength(1);
    expect(events[0]!.before).toEqual({ status: "active" });
    expect(events[0]!.after).toMatchObject({ status: "voided", reason: "yanlış satır", kind: "bonus", amount: 100, period_id: periodId });
  });

  it("A8 refused line actions write no audit rows", async () => {
    const { periodId, salaryId } = await openWithSalary();
    const before = (await staffAudit(T())).length;
    expect(failure(await addLine(O(), { periodId, kind: "no_such_kind", amount: 1, idempotencyKey: newKey() }))).toBe("FN030");
    expect(failure(await updateLine(O(), { lineId: salaryId, amount: 5, expectedVersion: 999 }))).toBe("FN013");
    await finalize(periodId);
    const mid = (await staffAudit(T())).length;
    expect(failure(await addLine(O(), { periodId, kind: "bonus", amount: 1, idempotencyKey: newKey() }))).toBe("FN024");
    expect(failure(await voidLine(O(), { lineId: salaryId, reason: "x", expectedVersion: await version(periodId) }))).toBe("FN024");
    expect((await staffAudit(T())).length).toBe(mid);
    expect(mid).toBe(before + 1); // only the finalize
  });

  it("A10 no note, name or email in any payload; a description appears only as before and after text of a line update", async () => {
    const p = await makePeriod(world);
    const sal = await makeLine(p.periodId, "salary", 1000, { description: "GİZLİ-AÇIKLAMA" }, world.owner);
    await makePayment(p.periodId, 100, { note: "GİZLİ-NOT" }, world.owner);
    await expectOk(await updateLine(O(), { lineId: sal.lineId!, amount: 1000, description: "GİZLİ-YENİ", expectedVersion: await version(p.periodId) }));
    const events = (await staffAudit(T())).filter(
      (e) => e.entity_id === p.periodId || (e.after as { period_id?: string } | null)?.period_id === p.periodId,
    );
    expect(events.length).toBeGreaterThan(3);
    for (const e of events) {
      const text = JSON.stringify([e.before, e.after]);
      expect(text, e.action).not.toContain("GİZLİ-NOT");
      expect(text, e.action).not.toMatch(/@/);
      expect(text, e.action).not.toContain("Personel");
      if (e.action !== "finance.staff_line_updated") expect(text, e.action).not.toContain("GİZLİ-AÇIKLAMA");
    }
    const update = events.find((e) => e.action === "finance.staff_line_updated")!;
    expect(JSON.stringify([update.before, update.after])).toContain("GİZLİ-AÇIKLAMA");
    expect(JSON.stringify([update.before, update.after])).toContain("GİZLİ-YENİ");
  });
});
