import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createStaffFinanceWorld,
  destroyStaffFinanceWorld,
  makePeriod,
  makeLine,
  makePayment,
  oracleTotals,
  newKey,
  type StaffFinanceWorld,
} from "./staff-finance-fixtures";

/**
 * Faz FIN.1C.1 — the pure helpers H1 to H7 (matrix group HLP). They live in the private schema and are called here as the
 * privileged test connection; the golden fingerprint vectors come from an independent Node implementation of the rules.
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to
 * whatever TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV
 * database) and fails loudly when they are not.
 */

let world: StaffFinanceWorld;

beforeAll(async () => {
  world = await createStaffFinanceWorld("fin1c1-hlp");
});

afterAll(async () => {
  await destroyStaffFinanceWorld(world);
});

/** Runs one scalar SQL expression and returns its text (or the error code). */
async function scalar(expr: string): Promise<{ ok: true; value: string | null } | { ok: false; code: string | undefined }> {
  try {
    const rows = await testDb.unsafe(`select (${expr})::text as v`);
    return { ok: true, value: (rows[0] as unknown as { v: string | null }).v };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code };
  }
}

/** The independent Node implementation of the fingerprint rules (character count prefix, UTF-8 md5). */
function fingerprint(components: string[]): string {
  const rendered = components.map((c) => `${[...c].length}:${c}`).join("|");
  return createHash("md5").update(rendered, "utf8").digest("hex");
}

const PERIOD_ID = "00000000-0000-4000-8000-0000000000b1";
const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";

describe("HLP helper vectors", () => {
  it.each([
    ["0.01", "0.01"],
    ["250", "250.00"],
    ["250.5", "250.50"],
    ["250.500", "250.50"],
    ["9999999999.99", "9999999999.99"],
  ])("HLP1 H3 amount %s is valid and returns %s", async (input, expected) => {
    const r = await scalar(`private.normalize_staff_finance_amount('${input}'::numeric)`);
    expect(r).toEqual({ ok: true, value: expected });
  });

  it.each([["0"], ["-1"], ["'NaN'::numeric"], ["'Infinity'::numeric"], ["'-Infinity'::numeric"], ["0.001"], ["10000000000.00"], ["null::numeric"], ["99999999999999999999.99"]])(
    "HLP1 H3 amount %s raises FN004 (never a raw 22xxx)",
    async (input) => {
      const expr = /::|null/.test(input) ? input : `${input}::numeric`;
      const r = await scalar(`private.normalize_staff_finance_amount(${expr})`);
      expect(r).toEqual({ ok: false, code: "FN004" });
    },
  );

  it("HLP2 H2 text: space, tab, CR and LF are trimmed, a blank becomes null, inner whitespace, case and Unicode are untouched", async () => {
    const cases: [string, string | null][] = [
      ["'  abc  '", "abc"],
      ["chr(9) || 'abc' || chr(10) || chr(13) || ' '", "abc"],
      ["'   '", null],
      ["chr(9) || chr(10) || chr(13) || ' '", null],
      ["''", null],
      ["null::text", null],
      ["'a  b'", "a  b"],
      ["'İI ıi'", "İI ıi"],
      ["'Ab'", "Ab"],
      ["chr(160) || 'x' || chr(160)", " x "],
    ];
    for (const [expr, expected] of cases) {
      const r = await scalar(`private.normalize_staff_finance_text(${expr})`);
      expect(r, expr).toEqual({ ok: true, value: expected });
    }
  });

  it("HLP3 H4 month: the first day of a month in range is accepted; any other day, out of range or null is FN004", async () => {
    expect(await scalar(`private.normalize_staff_finance_month(date '2026-10-01')`)).toEqual({ ok: true, value: "2026-10-01" });
    expect(await scalar(`private.normalize_staff_finance_month(date '2000-01-01')`)).toEqual({ ok: true, value: "2000-01-01" });
    expect(await scalar(`private.normalize_staff_finance_month(date '2100-12-01')`)).toEqual({ ok: true, value: "2100-12-01" });
    for (const expr of ["date '2026-10-02'", "date '1999-12-01'", "date '2101-01-01'", "date '2100-12-02'", "null::date"]) {
      expect(await scalar(`private.normalize_staff_finance_month(${expr})`), expr).toEqual({ ok: false, code: "FN004" });
    }
  });

  it("HLP4 the period fingerprint golden vectors GV1 and GV2 equal the independent implementation", async () => {
    const gv1 = ["staff.period.create.v1", STAFF_ID, "2026-10-01", "2026-11-05"];
    const gv2 = ["staff.period.create.v1", STAFF_ID, "2026-10-01", "NO_DUE"];
    expect(await scalar(`private.staff_period_create_fingerprint('${STAFF_ID}'::uuid, date '2026-10-01', date '2026-11-05')`)).toEqual({
      ok: true, value: fingerprint(gv1),
    });
    expect(await scalar(`private.staff_period_create_fingerprint('${STAFF_ID}'::uuid, date '2026-10-01', null)`)).toEqual({
      ok: true, value: fingerprint(gv2),
    });
    // the documented vectors
    expect(fingerprint(gv1)).toBe("1d8dd1ea28e67455cfb8b275e717d3a1");
    expect(fingerprint(gv2)).toBe("a7c4fb596be74ae2ad5c9b661827ac21");
  });

  it("HLP5 the line fingerprint golden vectors GV3 to GV6 (the pipe boundary and the paye kind included) equal the independent implementation", async () => {
    const vectors: [string, string, string, string, string, string][] = [
      ["GV3", "salary", "30000", "FIN.1C pilot maaş", "30000.00", "da877b8cf4e6644f374cbde872834f58"],
      ["GV4", "employee_social_insurance", "2500", "", "2500.00", "6773feded707f0edb82ae7aeace29d33"],
      ["GV5", "adjustment_credit", "0.05", "Düzeltme | komisyon", "0.05", "4f38439f76f52a5faffa2cf8f8878711"],
      ["GV6", "paye", "1000", "FIN.1C pilot stopaj", "1000.00", "3b3e6f6b3f7b24af0cc4e6741691b007"],
    ];
    for (const [name, kind, amount, description, amountText, documented] of vectors) {
      const expected = fingerprint(["staff.line.add.v1", PERIOD_ID, kind, amountText, description]);
      expect(expected, `${name} documented md5`).toBe(documented);
      const desc = description === "" ? "null::text" : `'${description.replace(/'/g, "''")}'`;
      const r = await scalar(`private.staff_line_add_fingerprint('${PERIOD_ID}'::uuid, '${kind}', '${amount}'::numeric, ${desc})`);
      expect(r, name).toEqual({ ok: true, value: expected });
    }
  });

  it("HLP6 changing any one fingerprint component changes the hash; the amount representations 250.5, 250.50 and 250.500 do not", async () => {
    const period = async (staff: string, month: string, due: string | null) =>
      (await scalar(`private.staff_period_create_fingerprint('${staff}'::uuid, date '${month}', ${due ? `date '${due}'` : "null::date"})`)) as { ok: true; value: string };
    const base = await period(STAFF_ID, "2026-10-01", "2026-11-05");
    const variants = [
      await period("00000000-0000-4000-8000-0000000000a2", "2026-10-01", "2026-11-05"),
      await period(STAFF_ID, "2026-09-01", "2026-11-05"),
      await period(STAFF_ID, "2026-10-01", "2026-11-06"),
      await period(STAFF_ID, "2026-10-01", null),
    ];
    for (const v of variants) expect(v.value).not.toBe(base.value);
    const line = async (period: string, kind: string, amount: string, desc: string | null) =>
      (await scalar(`private.staff_line_add_fingerprint('${period}'::uuid, '${kind}', '${amount}'::numeric, ${desc === null ? "null::text" : `'${desc}'`})`)) as { ok: true; value: string };
    const lbase = await line(PERIOD_ID, "salary", "250.5", "x");
    for (const v of [
      await line("00000000-0000-4000-8000-0000000000b2", "salary", "250.5", "x"),
      await line(PERIOD_ID, "bonus", "250.5", "x"),
      await line(PERIOD_ID, "salary", "250.51", "x"),
      await line(PERIOD_ID, "salary", "250.5", "y"),
      await line(PERIOD_ID, "salary", "250.5", null),
    ]) {
      expect(v.value).not.toBe(lbase.value);
    }
    for (const same of ["250.50", "250.500", "250.5000"]) {
      expect((await line(PERIOD_ID, "salary", same, "x")).value).toBe(lbase.value);
    }
  });

  it("HLP7 H7 payment input: amount, purpose, method, paid_at and note are validated exactly (the bounds computed in SQL)", async () => {
    const call = (amount: string, purpose: string, method: string, paidAt: string, note: string) =>
      scalar(`private.normalize_staff_payment_input(${amount}, ${purpose}, ${method}, ${paidAt}, ${note})`);
    const ok = await call("250.5::numeric", "'advance'", "'cash'", "timestamptz '2026-10-02 09:15:30.123456+00'", "'  not  '");
    expect(ok.ok).toBe(true);
    const norm = JSON.parse((ok as { value: string }).value) as Record<string, unknown>;
    expect(norm).toEqual({ amount: 250.5, purpose: "advance", method: "cash", paid_at: "2026-10-02T09:15:30.123456Z", note: "not" });
    expect(await call("0::numeric", "'salary'", "'cash'", "now()", "null")).toEqual({ ok: false, code: "FN004" });
    expect(await call("1::numeric", "'loan'", "'cash'", "now()", "null")).toEqual({ ok: false, code: "FN004" });
    expect(await call("1::numeric", "null", "'cash'", "now()", "null")).toEqual({ ok: false, code: "FN004" });
    expect(await call("1::numeric", "'salary'", "'crypto'", "now()", "null")).toEqual({ ok: false, code: "FN006" });
    expect(await call("1::numeric", "'salary'", "null", "now()", "null")).toEqual({ ok: false, code: "FN006" });
    expect(await call("1::numeric", "'salary'", "'cash'", "null::timestamptz", "null")).toEqual({ ok: false, code: "FN004" });
    expect(await call("1::numeric", "'salary'", "'cash'", "timestamptz '1999-12-31 23:59:59+00'", "null")).toEqual({ ok: false, code: "FN004" });
    expect((await call("1::numeric", "'salary'", "'cash'", "timestamptz '2000-01-01 00:00:00+00'", "null")).ok).toBe(true);
    expect(await call("1::numeric", "'salary'", "'cash'", "now() + interval '61 minutes'", "null")).toEqual({ ok: false, code: "FN004" });
    expect((await call("1::numeric", "'salary'", "'cash'", "now() + interval '59 minutes'", "null")).ok).toBe(true);
    expect(await call("1::numeric", "'salary'", "'cash'", "now()", "repeat('x', 501)")).toEqual({ ok: false, code: "FN004" });
    expect((await call("1::numeric", "'salary'", "'cash'", "now()", "repeat('x', 500)")).ok).toBe(true);
    // there is NO amount-versus-net argument at all
    const [{ n }] = await testDb<{ n: string }[]>`
      select count(*)::text as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'private' and p.proname = 'normalize_staff_payment_input' and p.pronargs = 5`;
    expect(n).toBe("1");
  });

  it("HLP8 H1 live totals: voided lines and payments are excluded and an advance is a subset of paid", async () => {
    const p = await makePeriod(world);
    const a = await makeLine(p.periodId, "salary", 1000, {}, world.owner);
    await makeLine(p.periodId, "bonus", 200, {}, world.owner);
    await makeLine(p.periodId, "paye", 100, {}, world.owner);
    await makeLine(p.periodId, "employer_social_insurance", 300, {}, world.owner);
    const dead = await makeLine(p.periodId, "private_insurance", 50, {}, world.owner);
    const adv = await makePayment(p.periodId, 400, { purpose: "advance" }, world.owner);
    await makePayment(p.periodId, 100, { purpose: "salary" }, world.owner);
    const gone = await makePayment(p.periodId, 77, { purpose: "advance" }, world.owner);
    await testDb`update staff_period_lines set status = 'voided', voided_at = now(), void_reason = 'x' where id = ${dead.lineId!}`;
    await testDb`update staff_payments set status = 'voided', voided_at = now(), void_reason = 'x' where id = ${gone.paymentId!}`;
    const [live] = await testDb<{ g: string; d: string; e: string; p: string; a: string }[]>`
      select earning_total::text as g, employee_deduction_total::text as d, employer_cost_total::text as e,
             paid_total::text as p, advance_total::text as a
      from private.staff_period_live_totals(${p.periodId})`;
    expect(Object.fromEntries(Object.entries(live).map(([k, v]) => [k, Number(v)]))).toEqual({ g: 1200, d: 100, e: 300, p: 500, a: 400 });
    expect(await oracleTotals(p.periodId)).toEqual({ earning: 1200, deduction: 100, employer: 300, paid: 500, advances: 400 });
    expect(a.lineId && adv.paymentId).toBeTruthy();
  });

  it.each([
    // [earning, deduction, paid, expected]
    [0, 0, 0, "nothing_due"],
    [1000, 0, 0, "unpaid"],
    [1000, 0, 400, "partially_paid"],
    [1000, 0, 999.99, "partially_paid"],
    [1000, 0, 1000, "paid"],
    [1000, 0, 1000.01, "overpaid"],
    [1000, 200, 800, "paid"],
    [1000, 200, 800.01, "overpaid"],
    [1000, 1000, 0, "nothing_due"],
    [0, 0, 100, "overpaid"],
    [1000, 1000, 0.01, "overpaid"],
  ])("HLP9 payment_state for earning %s, deduction %s, paid %s is %s", async (earning, deduction, paid, expected) => {
    // generated column: evaluated directly through a scratch row (rolled back) so no trigger is involved
    const marker = new Error("rollback");
    try {
      await testDb.begin(async (sql) => {
        const [t] = await sql<{ tenant_id: string; staff_id: string }[]>`select ${world.tenant.id}::uuid as tenant_id, ${world.staffA.id}::uuid as staff_id`;
        await sql`alter table staff_finance_periods disable trigger enforce_staff_period_invariants_trg`;
        const [row] = await sql<{ payment_state: string; net_payable: string }[]>`
          insert into staff_finance_periods (tenant_id, staff_member_id, staff_display_name, period_month, currency,
            earning_total, employee_deduction_total, paid_total, advance_total, idempotency_key, idempotency_fingerprint, lifecycle)
          values (${t!.tenant_id}, ${t!.staff_id}, 'x', '2001-01-01', 'TRY', ${earning}, ${deduction}, ${paid}, 0, ${newKey()}, ${"a".repeat(32)}, 'open')
          returning payment_state, net_payable::text`;
        expect(row!.payment_state).toBe(expected);
        expect(Number(row!.net_payable)).toBe(earning - deduction);
        throw marker;
      });
    } catch (e) {
      if (e !== marker) throw e;
    }
  });
});
