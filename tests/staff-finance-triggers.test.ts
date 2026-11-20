import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createStaffFinanceWorld,
  destroyStaffFinanceWorld,
  makePeriod,
  makeLine,
  makePayment,
  finalizePeriod,
  cancelPeriod,
  expectOk,
  periodRow,
  lineRows,
  paymentRows,
  oracleTotals,
  newKey,
  newStaff,
  EARNING_KINDS,
  DEDUCTION_KINDS,
  EMPLOYER_KINDS,
  ADJUSTMENT_KINDS,
  type StaffFinanceWorld,
} from "./staff-finance-fixtures";

/**
 * Faz FIN.1C.1 — trigger invariants T1 to T4 (matrix group TR), exercised with direct SQL as the privileged test
 * connection: the database is the authority even when a future trusted code path writes the tables directly.
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to
 * whatever TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV
 * database) and fails loudly when they are not.
 */

let world: StaffFinanceWorld;

beforeAll(async () => {
  world = await createStaffFinanceWorld("fin1c1-trg");
});

afterAll(async () => {
  await destroyStaffFinanceWorld(world);
});

const O = () => world.owner;

/** The SQLSTATE of a rejected statement (undefined when it succeeded). */
async function codeOf(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

const sql = (text: string) => testDb.unsafe(text);

type RawLine = {
  kind: string;
  amount: number | string;
  description?: string | null;
  lineGroup?: string;
  institution?: string | null;
  status?: string;
  postFinalization?: boolean;
};

/** Inserts a line with raw SQL (no RPC rules); the classification comes from the catalog unless overridden. */
async function rawLine(periodId: string, l: RawLine): Promise<string> {
  const [p] = await testDb<{ tenant_id: string; currency: string; lifecycle: string }[]>`
    select tenant_id, currency, lifecycle from staff_finance_periods where id = ${periodId}`;
  const [k] = await testDb<{ line_group: string; institution: string | null }[]>`
    select line_group, institution from staff_line_kinds where code = ${l.kind}`;
  const group = l.lineGroup ?? k?.line_group ?? "earning";
  const institution = l.institution === undefined ? (k?.institution ?? null) : l.institution;
  const [row] = await testDb<{ id: string }[]>`
    insert into staff_period_lines (tenant_id, period_id, currency, kind, line_group, institution, amount, description,
                                    status, post_finalization, idempotency_key, idempotency_fingerprint)
    values (${p!.tenant_id}, ${periodId}, ${p!.currency}, ${l.kind}, ${group}, ${institution}, ${l.amount},
            ${l.description ?? null}, ${l.status ?? "active"}, ${l.postFinalization ?? p!.lifecycle === "finalized"},
            ${newKey()}, ${"b".repeat(32)})
    returning id`;
  return row!.id;
}

type RawPayment = {
  purpose?: string;
  method?: string;
  amount: number | string;
  status?: string;
  postFinalization?: boolean;
};

async function rawPayment(periodId: string, y: RawPayment): Promise<string> {
  const [p] = await testDb<{ tenant_id: string; currency: string; lifecycle: string }[]>`
    select tenant_id, currency, lifecycle from staff_finance_periods where id = ${periodId}`;
  const [row] = await testDb<{ id: string }[]>`
    insert into staff_payments (tenant_id, period_id, currency, purpose, method, amount, status, post_finalization, idempotency_key)
    values (${p!.tenant_id}, ${periodId}, ${p!.currency}, ${y.purpose ?? "salary"}, ${y.method ?? "cash"}, ${y.amount},
            ${y.status ?? "posted"}, ${y.postFinalization ?? p!.lifecycle === "finalized"}, ${newKey()})
    returning id`;
  return row!.id;
}

/** The raw finalize: lifecycle plus finalized_at plus the snapshot of the CURRENT cached statement. */
const finalizeSql = (periodId: string) => `
  update staff_finance_periods
  set lifecycle = 'finalized', finalized_at = now(),
      finalized_earning_total = earning_total, finalized_deduction_total = employee_deduction_total,
      finalized_net_payable = earning_total - employee_deduction_total
  where id = '${periodId}'`;

const reopenSql = (periodId: string) => `
  update staff_finance_periods
  set lifecycle = 'open', finalized_at = null, finalized_by = null,
      finalized_earning_total = null, finalized_deduction_total = null, finalized_net_payable = null
  where id = '${periodId}'`;

const cancelSql = (periodId: string) => `
  update staff_finance_periods
  set lifecycle = 'cancelled', cancelled_at = now(), cancel_reason = 'raw',
      finalized_at = null, finalized_by = null,
      finalized_earning_total = null, finalized_deduction_total = null, finalized_net_payable = null
  where id = '${periodId}'`;

/** A period with a salary of `amount` (open). */
async function openPeriod(amount = 1000) {
  const p = await makePeriod(world);
  await makeLine(p.periodId, "salary", amount, {}, O());
  return p.periodId;
}

async function finalizedPeriod(amount = 1000) {
  const id = await openPeriod(amount);
  await sql(finalizeSql(id));
  return id;
}

const insertPeriodSql = (extraColumns = "", extraValues = "") => async () => {
  const staff = await newStaff(world);
  return testDb.unsafe(
    `insert into staff_finance_periods (tenant_id, staff_member_id, staff_display_name, period_month, currency,
        idempotency_key, idempotency_fingerprint${extraColumns})
     values ('${world.tenant.id}', '${staff.id}', 'x', '2026-02-01', 'TRY', '${newKey()}', '${"c".repeat(32)}'${extraValues})`,
  );
};

describe("TR period invariants (T1)", () => {
  it("TR1 / T1.1 a period cannot be inserted non-open, with a version other than 1, with a total, or with finalization, snapshot or cancellation data (FN032)", async () => {
    const cases: [string, string][] = [
      [", lifecycle", ", 'finalized'"],
      [", lifecycle", ", 'cancelled'"],
      [", version", ", 2"],
      [", earning_total", ", 5"],
      [", employee_deduction_total", ", 1"],
      [", employer_cost_total", ", 1"],
      [", paid_total", ", 1"],
      [", advance_total", ", 1"],
      [", content_revision", ", 1"],
      [", finalized_at", ", now()"],
      [", finalized_earning_total", ", 1"],
      [", finalized_deduction_total", ", 1"],
      [", finalized_net_payable", ", 1"],
      [", cancelled_at", ", now()"],
      [", cancel_reason", ", 'x'"],
    ];
    for (const [cols, vals] of cases) {
      expect(await codeOf(insertPeriodSql(cols, vals)()), cols + vals).toBe("FN032");
    }
    expect(await codeOf(insertPeriodSql()())).toBeUndefined();
  });

  it("TR2 / T1.2 immutable period columns: tenant, staff member, name, month, currency, keys and creation data (FN032)", async () => {
    const p = await makePeriod(world);
    const other = await newStaff(world);
    const sets = [
      `tenant_id = '${world.otherTenant.id}'`,
      `staff_member_id = '${other.id}'`,
      `staff_display_name = 'başka'`,
      `period_month = '2026-08-01'`,
      `currency = 'USD'`,
      `idempotency_key = '${newKey()}'`,
      `idempotency_fingerprint = '${"d".repeat(32)}'`,
      `created_by = null`,
      `created_at = now() - interval '1 day'`,
    ];
    for (const set of sets) {
      expect(await codeOf(sql(`update staff_finance_periods set ${set} where id = '${p.periodId}'`)), set).toBe("FN032");
    }
  });

  it("TR3 / T1.3 a writer that sets the version is rejected (FN032)", async () => {
    const p = await makePeriod(world);
    expect(await codeOf(sql(`update staff_finance_periods set version = 99 where id = '${p.periodId}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_finance_periods set version = version + 1, due_date = '2026-10-09' where id = '${p.periodId}'`))).toBe("FN032");
    expect((await periodRow(p.periodId)).version).toBe(1);
  });

  it("TR4 / T1.4 any tracked change on a cancelled period is FN025; an UPDATE that changes nothing is allowed", async () => {
    const p = await makePeriod(world);
    await expectOk(await cancelPeriod(O().id, p.periodId, "iptal"));
    for (const set of ["due_date = '2026-10-09'", "lifecycle = 'open'", "cancel_reason = 'başka'"]) {
      expect(await codeOf(sql(`update staff_finance_periods set ${set} where id = '${p.periodId}'`)), set).toBe("FN025");
    }
    const v = (await periodRow(p.periodId)).version;
    expect(await codeOf(sql(`update staff_finance_periods set due_date = due_date where id = '${p.periodId}'`))).toBeUndefined();
    expect((await periodRow(p.periodId)).version).toBe(v);
  });

  it("TR5 / T1.5 / T1.8 illegal transitions and state-bound data are FN032 (cancelled to anything is FN025 by T1.4, which comes first)", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 100, {}, O());
    expect(await codeOf(sql(`update staff_finance_periods set lifecycle = 'foo' where id = '${p.periodId}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_finance_periods set finalized_at = now() where id = '${p.periodId}'`))).toBe("FN032"); // open to open with finalization data
    expect(await codeOf(sql(`update staff_finance_periods set cancelled_at = now() where id = '${p.periodId}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_finance_periods set lifecycle = 'cancelled' where id = '${p.periodId}'`))).toBe("FN032"); // no cancelled_at / reason
    expect(await codeOf(sql(`update staff_finance_periods set lifecycle = 'finalized' where id = '${p.periodId}'`))).toBe("FN032"); // no snapshot
    const fin = await finalizedPeriod();
    expect(await codeOf(sql(`update staff_finance_periods set finalized_at = now() + interval '1 minute' where id = '${fin}'`))).toBe("FN032");
    const dead = await makePeriod(world);
    await expectOk(await cancelPeriod(O().id, dead.periodId, "iptal"));
    expect(await codeOf(sql(`update staff_finance_periods set lifecycle = 'open', cancelled_at = null, cancelled_by = null, cancel_reason = null where id = '${dead.periodId}'`))).toBe("FN025");
  });

  it("TR6 / T1.6 finalizing with an earning total of 0 is FN031", async () => {
    const p = await makePeriod(world);
    expect(await codeOf(sql(finalizeSql(p.periodId)))).toBe("FN031");
    const q = await makePeriod(world);
    await makeLine(q.periodId, "private_insurance", 100, {}, O());
    expect(await codeOf(sql(finalizeSql(q.periodId)))).toBe("FN031");
  });

  it("TR7 / T1.7 finalizing with posted payments above the net (advances counted) is FN033; exactly the net succeeds; the net plus 0.01 fails", async () => {
    const exact = await openPeriod(1000);
    await rawPayment(exact, { purpose: "advance", amount: 1000 });
    expect(await codeOf(sql(finalizeSql(exact)))).toBeUndefined();
    expect((await periodRow(exact)).lifecycle).toBe("finalized");
    const over = await openPeriod(1000);
    await rawPayment(over, { purpose: "advance", amount: 1000.01 });
    expect(await codeOf(sql(finalizeSql(over)))).toBe("FN033");
    expect((await periodRow(over)).lifecycle).toBe("open");
    const split = await openPeriod(1000);
    await rawPayment(split, { purpose: "advance", amount: 600 });
    await rawPayment(split, { purpose: "salary", amount: 400.01 });
    expect(await codeOf(sql(finalizeSql(split)))).toBe("FN033");
    // a voided payment does not count
    await sql(`update staff_payments set status = 'voided', voided_at = now(), void_reason = 'x' where period_id = '${split}' and purpose = 'salary'`);
    expect(await codeOf(sql(finalizeSql(split)))).toBeUndefined();
  });

  it("TR8 / T1.8 the snapshot must equal the live statement, cannot change while finalized, and must be cleared by a reopen and a cancel (FN032)", async () => {
    const p = await openPeriod(1000);
    expect(
      await codeOf(
        sql(`update staff_finance_periods set lifecycle = 'finalized', finalized_at = now(), finalized_earning_total = 999,
             finalized_deduction_total = 0, finalized_net_payable = 999 where id = '${p}'`),
      ),
    ).toBe("FN032");
    await sql(finalizeSql(p));
    expect(await codeOf(sql(`update staff_finance_periods set finalized_earning_total = 1, finalized_net_payable = 1 where id = '${p}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_finance_periods set finalized_by = '${O().id}' where id = '${p}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_finance_periods set lifecycle = 'open', finalized_at = null where id = '${p}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_finance_periods set lifecycle = 'cancelled', cancelled_at = now(), cancel_reason = 'x' where id = '${p}'`))).toBe("FN032");
    expect(await codeOf(sql(reopenSql(p)))).toBeUndefined();
  });

  it("TR9 / T1.9 a reopen is blocked by a posted payment flagged post_finalization; payments recorded before do not block; voiding the flagged ones unblocks", async () => {
    const before = await openPeriod(1000);
    await rawPayment(before, { amount: 300 });
    await sql(finalizeSql(before));
    expect(await codeOf(sql(reopenSql(before)))).toBeUndefined();
    const p = await finalizedPeriod(1000);
    const flagged = await rawPayment(p, { amount: 100 });
    expect((await paymentRows(p)).find((r) => r.id === flagged)!.post_finalization).toBe(true);
    expect(await codeOf(sql(reopenSql(p)))).toBe("FN027");
    await sql(`update staff_payments set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${flagged}'`);
    expect(await codeOf(sql(reopenSql(p)))).toBeUndefined();
  });

  it("TR10 / T1.10 a cancel with a posted payment of any purpose is FN027", async () => {
    for (const purpose of ["salary", "advance", "bonus", "other"]) {
      const p = await openPeriod(1000);
      await rawPayment(p, { purpose, amount: 10 });
      expect(await codeOf(sql(cancelSql(p))), purpose).toBe("FN027");
    }
    const ok = await openPeriod(1000);
    expect(await codeOf(sql(cancelSql(ok)))).toBeUndefined();
  });

  it("TR11 / T1.11 a direct update of a cached total to a wrong value is FN032", async () => {
    const p = await openPeriod(1000);
    for (const set of [
      "earning_total = 5",
      "employee_deduction_total = 0.01",
      "employer_cost_total = 7",
      "paid_total = 1",
      "advance_total = 1",
    ]) {
      expect(await codeOf(sql(`update staff_finance_periods set ${set} where id = '${p}'`)), set).toBe("FN032");
    }
    const row = await periodRow(p);
    expect(row.earning_total).toBe("1000.00");
  });

  it("TR12 / T1.12 deductions above earnings are FN026 in any lifecycle; paid above the net is FN026 once finalized and allowed while open", async () => {
    const open = await openPeriod(1000);
    await expect(rawLine(open, { kind: "other_deduction", amount: 1000.01 })).rejects.toMatchObject({ code: "FN026" });
    const fin = await finalizedPeriod(1000);
    await rawPayment(fin, { amount: 700 });
    await expect(rawLine(fin, { kind: "adjustment_debit", amount: 300.01, description: "d" })).rejects.toMatchObject({ code: "FN026" });
    await expect(rawLine(fin, { kind: "adjustment_debit", amount: 300, description: "d" })).resolves.toBeTruthy();
    // an open period may be overpaid
    const over = await openPeriod(1000);
    await expect(rawPayment(over, { amount: 5000 })).resolves.toBeTruthy();
    expect((await periodRow(over)).payment_state).toBe("overpaid");
    // a cancelled period is the same floor on a hand-built row: deductions need earnings
    const empty = await makePeriod(world);
    await expect(rawLine(empty.periodId, { kind: "paye", amount: 1 })).rejects.toMatchObject({ code: "FN026" });
  });

  it("TR13 / T1.13 a tracked change bumps the version exactly once; an UPDATE that changes no tracked column changes nothing", async () => {
    const p = await makePeriod(world);
    const v1 = await periodRow(p.periodId);
    await sql(`update staff_finance_periods set due_date = '2026-10-09' where id = '${p.periodId}'`);
    const v2 = await periodRow(p.periodId);
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.updated_at.getTime()).toBeGreaterThanOrEqual(v1.updated_at.getTime());
    await sql(`update staff_finance_periods set due_date = '2026-10-09' where id = '${p.periodId}'`);
    await sql(`update staff_finance_periods set updated_at = now() + interval '5 days' where id = '${p.periodId}'`);
    const v3 = await periodRow(p.periodId);
    expect([v3.version, v3.updated_at.getTime()]).toEqual([v2.version, v2.updated_at.getTime()]);
  });

  it("TR29 / T1.12a content_revision moving by anything but 0 or 1 in one UPDATE, or decreasing, is FN032", async () => {
    const p = await openPeriod(1000);
    const row = await periodRow(p);
    for (const set of [
      `content_revision = ${row.content_revision + 2}`,
      `content_revision = ${row.content_revision + 100}`,
      `content_revision = ${row.content_revision - 1}`,
      `content_revision = -1`,
    ]) {
      expect(await codeOf(sql(`update staff_finance_periods set ${set} where id = '${p}'`)), set).toBe("FN032");
    }
    expect(await codeOf(sql(`update staff_finance_periods set content_revision = ${row.content_revision + 1} where id = '${p}'`))).toBeUndefined();
  });
});

describe("TR line invariants (T2)", () => {
  it("TR14 / T2.1 a line insert on a cancelled period is FN025", async () => {
    const p = await makePeriod(world);
    await expectOk(await cancelPeriod(O().id, p.periodId, "iptal"));
    await expect(rawLine(p.periodId, { kind: "salary", amount: 1 })).rejects.toMatchObject({ code: "FN025" });
  });

  it("TR15 / T2.2 an unknown or inactive kind is FN030", async () => {
    const p = await openPeriod(1000);
    await expect(rawLine(p, { kind: "no_such_kind", amount: 1, lineGroup: "earning", institution: null })).rejects.toMatchObject({ code: "FN030" });
    const marker = new Error("rollback");
    try {
      await testDb.begin(async (tx) => {
        await tx`update staff_line_kinds set is_active = false where code = 'other_earning'`;
        await expect(
          tx.unsafe(
            `insert into staff_period_lines (tenant_id, period_id, currency, kind, line_group, amount, idempotency_key, idempotency_fingerprint)
             select tenant_id, id, currency, 'other_earning', 'earning', 1, '${newKey()}', '${"e".repeat(32)}' from staff_finance_periods where id = '${p}'`,
          ),
        ).rejects.toMatchObject({ code: "FN030" });
        throw marker;
      });
    } catch (e) {
      if (e !== marker) throw e;
    }
  });

  it("TR16 / T2.3 a group or institution that differs from the catalog is FN032", async () => {
    const p = await openPeriod(1000);
    await expect(rawLine(p, { kind: "bonus", amount: 1, lineGroup: "employer_cost" })).rejects.toMatchObject({ code: "FN032" });
    await expect(rawLine(p, { kind: "paye", amount: 1, institution: "social_insurance" })).rejects.toMatchObject({ code: "FN032" });
    await expect(rawLine(p, { kind: "employee_social_insurance", amount: 1, institution: null })).rejects.toMatchObject({ code: "FN032" });
    await expect(rawLine(p, { kind: "employee_social_insurance", amount: 1, institution: "provident_fund" })).rejects.toMatchObject({ code: "FN032" });
  });

  it.each([...EARNING_KINDS, ...DEDUCTION_KINDS].map((k) => [k]))(
    "TR17 / T2.4 on a finalized period the %s kind is rejected (FN024)",
    async (kind) => {
      const p = await finalizedPeriod(100000);
      await expect(rawLine(p, { kind, amount: 1, description: "d" })).rejects.toMatchObject({ code: "FN024" });
    },
  );

  it.each([...ADJUSTMENT_KINDS, ...EMPLOYER_KINDS].map((k) => [k]))(
    "TR17 / T2.4 on a finalized period the %s kind is accepted",
    async (kind) => {
      const p = await finalizedPeriod(100000);
      await expect(rawLine(p, { kind, amount: 1, description: "d" })).resolves.toBeTruthy();
    },
  );

  it("TR18 / T2.5 a wrong post_finalization flag or a non-active status on insert is FN032", async () => {
    const open = await openPeriod(1000);
    await expect(rawLine(open, { kind: "bonus", amount: 1, postFinalization: true })).rejects.toMatchObject({ code: "FN032" });
    const fin = await finalizedPeriod(1000);
    await expect(rawLine(fin, { kind: "private_insurance", amount: 1, postFinalization: false })).rejects.toMatchObject({ code: "FN032" });
    await expect(rawLine(open, { kind: "bonus", amount: 1, status: "voided" })).rejects.toMatchObject({ code: "FN032" });
  });

  it("TR19 / T2.6 a line UPDATE outside amount, description and the void block is FN032", async () => {
    const p = await openPeriod(1000);
    const id = await rawLine(p, { kind: "bonus", amount: 10 });
    const other = await openPeriod(1000);
    const sets = [
      `kind = 'commission'`,
      `period_id = '${other}'`,
      `currency = 'USD'`,
      `line_group = 'employer_cost'`,
      `institution = 'social_insurance'`,
      `calculation_source = 'rule_engine'`,
      `post_finalization = true`,
      `idempotency_key = '${newKey()}'`,
      `idempotency_fingerprint = '${"f".repeat(32)}'`,
      `tenant_id = '${world.otherTenant.id}'`,
      `created_by = '${O().id}'`,
      `created_at = now() - interval '1 day'`,
    ];
    for (const set of sets) {
      expect(await codeOf(sql(`update staff_period_lines set ${set} where id = '${id}'`)), set).toBe("FN032");
    }
  });

  it("TR20 / T2.7 a voided line cannot change, and a line can only move from active to voided", async () => {
    const p = await openPeriod(1000);
    const id = await rawLine(p, { kind: "bonus", amount: 10 });
    expect(await codeOf(sql(`update staff_period_lines set status = 'foo' where id = '${id}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_period_lines set status = 'voided' where id = '${id}'`))).toBe("FN032"); // no void data
    expect(await codeOf(sql(`update staff_period_lines set voided_at = now() where id = '${id}'`))).toBe("FN032"); // active with void data
    await sql(`update staff_period_lines set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${id}'`);
    expect(await codeOf(sql(`update staff_period_lines set amount = 99 where id = '${id}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_period_lines set description = 'y' where id = '${id}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_period_lines set status = 'active', voided_at = null, void_reason = null where id = '${id}'`))).toBe("FN032");
  });

  it("TR21 / T2.8 / T2.9 on a finalized period editing the amount or description of, or voiding, an earning or deduction line is FN024; an employer-cost line succeeds; a cancelled parent is FN025", async () => {
    const p = await makePeriod(world);
    const sal = await rawLine(p.periodId, { kind: "salary", amount: 1000, description: "a" });
    const ded = await rawLine(p.periodId, { kind: "paye", amount: 100, description: "a" });
    const emp = await rawLine(p.periodId, { kind: "private_insurance", amount: 50, description: "a" });
    await sql(finalizeSql(p.periodId));
    for (const id of [sal, ded]) {
      for (const set of [
        "amount = amount + 1",
        "description = 'b'",
        "status = 'voided', voided_at = now(), void_reason = 'x'",
      ]) {
        expect(await codeOf(sql(`update staff_period_lines set ${set} where id = '${id}'`)), set).toBe("FN024");
      }
    }
    for (const set of ["amount = amount + 1", "description = 'b'"]) {
      expect(await codeOf(sql(`update staff_period_lines set ${set} where id = '${emp}'`)), set).toBeUndefined();
    }
    expect(await codeOf(sql(`update staff_period_lines set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${emp}'`))).toBeUndefined();
    // a cancelled parent
    const q = await makePeriod(world);
    const line = await rawLine(q.periodId, { kind: "bonus", amount: 5 });
    await sql(cancelSql(q.periodId));
    expect(await codeOf(sql(`update staff_period_lines set amount = 6 where id = '${line}'`))).toBe("FN025");
  });
});

describe("TR payment invariants (T3)", () => {
  it("TR22 / T3.1 a payment on a cancelled period is FN025", async () => {
    const p = await makePeriod(world);
    await sql(cancelSql(p.periodId));
    await expect(rawPayment(p.periodId, { amount: 1 })).rejects.toMatchObject({ code: "FN025" });
  });

  it("TR23 / T3.2 a payment above the net on an open period is allowed; on a finalized period exactly the outstanding amount succeeds and 0.01 more is FN023", async () => {
    const open = await openPeriod(1000);
    await expect(rawPayment(open, { amount: 5000 })).resolves.toBeTruthy();
    const empty = await makePeriod(world);
    await expect(rawPayment(empty.periodId, { purpose: "advance", amount: 10 })).resolves.toBeTruthy();
    const fin = await finalizedPeriod(1000);
    await rawPayment(fin, { amount: 400 });
    await expect(rawPayment(fin, { amount: 600.01 })).rejects.toMatchObject({ code: "FN023" });
    await expect(rawPayment(fin, { amount: 600 })).resolves.toBeTruthy();
    await expect(rawPayment(fin, { amount: 0.01 })).rejects.toMatchObject({ code: "FN023" });
  });

  it("TR24 / T3.3 a wrong post_finalization flag or a status other than posted on insert is FN032", async () => {
    const open = await openPeriod(1000);
    await expect(rawPayment(open, { amount: 1, postFinalization: true })).rejects.toMatchObject({ code: "FN032" });
    const fin = await finalizedPeriod(1000);
    await expect(rawPayment(fin, { amount: 1, postFinalization: false })).rejects.toMatchObject({ code: "FN032" });
    await expect(rawPayment(open, { amount: 1, status: "voided" })).rejects.toMatchObject({ code: "FN032" });
  });

  it("TR25 / T3.4 / T3.5 a payment edit outside the void block and an un-void are FN032", async () => {
    const p = await openPeriod(1000);
    const id = await rawPayment(p, { amount: 100 });
    for (const set of [
      "amount = 1", "purpose = 'bonus'", "method = 'card'", "note = 'x'", "paid_at = now()", "post_finalization = true",
      `idempotency_key = '${newKey()}'`, `period_id = '${p}'`, "currency = 'USD'", `created_by = '${O().id}'`,
    ]) {
      const out = await codeOf(sql(`update staff_payments set ${set} where id = '${id}'`));
      // period_id to itself is a no-op; everything else is rejected
      expect(out, set).toBe(set.startsWith("period_id") ? undefined : "FN032");
    }
    expect(await codeOf(sql(`update staff_payments set status = 'foo' where id = '${id}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_payments set status = 'voided' where id = '${id}'`))).toBe("FN032"); // no void data
    await sql(`update staff_payments set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${id}'`);
    expect(await codeOf(sql(`update staff_payments set status = 'posted', voided_at = null, void_reason = null where id = '${id}'`))).toBe("FN032");
    expect(await codeOf(sql(`update staff_payments set void_reason = 'y' where id = '${id}'`))).toBe("FN032"); // a voided row is final, even its reason
  });
});

describe("TR cached totals (T4) and the change counter", () => {
  it("TR26 / T4 the cached totals equal the live sums after every child change; voided rows are excluded; an advance counts as a subset", async () => {
    const p = await makePeriod(world);
    const id = p.periodId;
    const check = async () => {
      const row = await periodRow(id);
      const live = await oracleTotals(id);
      expect({
        e: Number(row.earning_total), d: Number(row.employee_deduction_total), r: Number(row.employer_cost_total),
        p: Number(row.paid_total), a: Number(row.advance_total),
      }).toEqual({ e: live.earning, d: live.deduction, r: live.employer, p: live.paid, a: live.advances });
      return live;
    };
    const s = await rawLine(id, { kind: "salary", amount: 1000 });
    expect(await check()).toMatchObject({ earning: 1000 });
    const d = await rawLine(id, { kind: "employee_social_insurance", amount: 100 });
    const e = await rawLine(id, { kind: "employer_social_insurance", amount: 150 });
    expect(await check()).toMatchObject({ earning: 1000, deduction: 100, employer: 150 });
    const adv = await rawPayment(id, { purpose: "advance", amount: 200 });
    const sal = await rawPayment(id, { purpose: "salary", amount: 300 });
    expect(await check()).toMatchObject({ paid: 500, advances: 200 });
    await sql(`update staff_period_lines set amount = 1200 where id = '${s}'`);
    expect(await check()).toMatchObject({ earning: 1200 });
    await sql(`update staff_period_lines set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${d}'`);
    await sql(`update staff_period_lines set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${e}'`);
    expect(await check()).toMatchObject({ deduction: 0, employer: 0 });
    await sql(`update staff_payments set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${adv}'`);
    expect(await check()).toMatchObject({ paid: 300, advances: 0 });
    await sql(`update staff_payments set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${sal}'`);
    expect(await check()).toMatchObject({ paid: 0 });
    expect((await lineRows(id)).filter((l) => l.status === "voided")).toHaveLength(2);
  });

  it("TR27 an UPDATE that changes no column fires nothing; a description-only edit moves the counter and the version by 1; a payment insert or void moves the counter by 1", async () => {
    const p = await makePeriod(world);
    const id = p.periodId;
    const line = await rawLine(id, { kind: "salary", amount: 1000, description: "a" });
    const r0 = await periodRow(id);
    await sql(`update staff_period_lines set amount = amount, description = description where id = '${line}'`);
    const r1 = await periodRow(id);
    expect([r1.version, r1.content_revision]).toEqual([r0.version, r0.content_revision]);
    await sql(`update staff_period_lines set description = 'b' where id = '${line}'`);
    const r2 = await periodRow(id);
    expect([r2.version, r2.content_revision]).toEqual([r1.version + 1, r1.content_revision + 1]);
    expect(r2.earning_total).toBe(r1.earning_total);
    const pay = await rawPayment(id, { amount: 10 });
    const r3 = await periodRow(id);
    expect([r3.version, r3.content_revision]).toEqual([r2.version + 1, r2.content_revision + 1]);
    await sql(`update staff_payments set status = 'voided', voided_at = now(), void_reason = 'x' where id = '${pay}'`);
    const r4 = await periodRow(id);
    expect([r4.version, r4.content_revision]).toEqual([r3.version + 1, r3.content_revision + 1]);
    // a no-op payment update fires nothing
    await sql(`update staff_payments set status = status where id = '${pay}'`);
    const r5 = await periodRow(id);
    expect([r5.version, r5.content_revision]).toEqual([r4.version, r4.content_revision]);
  });

  it("a period total above the supported column range is a stable FN004 (never a raw numeric overflow) and writes nothing", async () => {
    const p = await makePeriod(world);
    await rawLine(p.periodId, { kind: "salary", amount: "9999999999.99" });
    const before = await periodRow(p.periodId);
    await expect(rawLine(p.periodId, { kind: "bonus", amount: 1 })).rejects.toMatchObject({ code: "FN004" });
    await expect(rawPayment(p.periodId, { amount: "9999999999.99" })).resolves.toBeTruthy();
    await expect(rawPayment(p.periodId, { amount: 1 })).rejects.toMatchObject({ code: "FN004" });
    const after = await periodRow(p.periodId);
    expect(after.earning_total).toBe(before.earning_total);
    // an employer total at the range limit does not stop a finalization (it never touches the net)
    expect((await finalizePeriod(O().id, { periodId: p.periodId, expectedVersion: after.version })).ok).toBe(true);
  });
});
