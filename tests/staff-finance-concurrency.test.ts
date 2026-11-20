import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createStaffFinanceWorld,
  destroyStaffFinanceWorld,
  buildCall,
  toOutcome,
  createPeriodArgs,
  updatePeriodArgs,
  addLineArgs,
  updateLineArgs,
  voidLineArgs,
  finalizeArgs,
  reopenArgs,
  cancelArgs,
  recordArgs,
  voidPaymentArgs,
  finalizePeriod,
  recordPayment,
  makePeriod,
  makeLine,
  makePayment,
  validPeriod,
  periodRow,
  lineRows,
  paymentRows,
  oracleTotals,
  staffAudit,
  newStaff,
  newKey,
  instantAgo,
  expectOk,
  type StaffFinanceWorld,
  type WriteResult,
  type RpcArg,
  type RpcOutcome,
} from "./staff-finance-fixtures";

/**
 * Faz FIN.1C.1 — concurrency (matrix group K). Every scenario runs N iterations; each iteration builds fresh rows, races the
 * competing calls behind a driver-level barrier (every transaction is open, `authenticated`, JWT claims set, and parked
 * BEFORE any of them sends its statement, released in a random order), then asserts the scenario's invariant, that the
 * period is internally consistent and the version accounting.
 *
 * K_ITERATIONS (default 20), K_POOL_MAX (default 24), K_SEED and K_BARRIER tune a run. K_BARRIER=server adds a SERVER-clock
 * barrier on top of the driver gate (pg_sleep_until a common instant on the database clock). The 50+ iteration runs use it.
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to whatever
 * TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV database).
 */

const ITERATIONS = Math.max(1, Number(process.env.K_ITERATIONS ?? 20));
const POOL_MAX = Math.max(4, Number(process.env.K_POOL_MAX ?? 24));
const SEED = Number(process.env.K_SEED ?? 20261007);
const SERVER_BARRIER = process.env.K_BARRIER === "server";
const BARRIER_LEAD_MS = Math.max(50, Number(process.env.K_BARRIER_LEAD_MS ?? 250));
const TEST_TIMEOUT = 900_000;

let world: StaffFinanceWorld;
let pool: Sql;

beforeAll(async () => {
  world = await createStaffFinanceWorld("fin1c1-conc");
  pool = postgres(process.env.TEST_DATABASE_URL!, { ssl: "require", max: POOL_MAX, onnotice: () => undefined });
});

afterAll(async () => {
  await pool?.end({ timeout: 10 });
  await destroyStaffFinanceWorld(world);
});

const T = () => world.tenant.id;
const OWNER = () => world.owner.id;

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
const rng = mulberry32(SEED);

function shuffled<T>(items: T[], r: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** An instant `ms` milliseconds ahead on the DATABASE clock (UTC text), read through testDb, never through the race pool. */
async function serverInstantAhead(ms: number): Promise<string> {
  const [row] = await testDb<{ t: string }[]>`
    select to_char(clock_timestamp() at time zone 'UTC' + (${ms}::int * interval '1 millisecond'), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`;
  return row!.t;
}

type Call = { userId: string; fn: string; args: RpcArg[]; holdMs?: number; settings?: Record<string, string> };
type Outcomes<L extends Record<string, Call>> = { [K in keyof L]: RpcOutcome<WriteResult> };

async function race<L extends Record<string, Call>>(calls: L): Promise<Outcomes<L>> {
  const labels = Object.keys(calls);
  if (labels.length > POOL_MAX) throw new Error(`${labels.length} concurrent calls exceed K_POOL_MAX=${POOL_MAX}`);
  const gates = labels.map(() => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  });
  let armed = 0;
  let allArmed!: () => void;
  const armedPromise = new Promise<void>((resolve) => {
    allArmed = resolve;
  });
  let serverStart = "";
  const tasks = labels.map(async (label, idx) => {
    const call = calls[label]!;
    const { query, params } = buildCall(call.fn, call.args);
    try {
      const rows = await pool.begin(async (sql) => {
        await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: call.userId, role: "authenticated" })}, true),
                         set_config('request.jwt.claim.sub', ${call.userId}, true)`;
        await sql`set local role authenticated`;
        for (const [name, value] of Object.entries(call.settings ?? {})) await sql`select set_config(${name}, ${value}, true)`;
        armed += 1;
        if (armed === labels.length) allArmed();
        await gates[idx]!.promise;
        if (SERVER_BARRIER) await sql`select pg_sleep_until(${serverStart}::text::timestamptz)`;
        const result = await sql.unsafe(query, params as never[]);
        if (call.holdMs) await sql`select pg_sleep(${call.holdMs / 1000})`;
        return result;
      });
      return [label, { ok: true, data: (rows[0] as unknown as { r: WriteResult }).r } as RpcOutcome<WriteResult>] as const;
    } catch (error) {
      return [label, toOutcome<WriteResult>(error)] as const;
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 20_000);
  });
  const first = await Promise.race([armedPromise.then(() => "armed" as const), timedOut]);
  clearTimeout(timer);
  if (SERVER_BARRIER) serverStart = await serverInstantAhead(BARRIER_LEAD_MS);
  for (const gate of shuffled(gates, rng)) gate.release();
  const settled = await Promise.all(tasks);
  if (first === "timeout") throw new Error("the race barrier was not armed within 20 s (pool exhausted or connection failure)");
  return Object.fromEntries(settled) as Outcomes<L>;
}

// ----------------------------------------------------------------------------------------------------------------
// call builders
// ----------------------------------------------------------------------------------------------------------------

const createCall = (input: Parameters<typeof createPeriodArgs>[0], userId = OWNER()): Call => ({ userId, fn: "create_staff_finance_period", args: createPeriodArgs(input) });
const updateDueCall = (periodId: string, dueDate: string | null, expectedVersion: number): Call => ({ userId: OWNER(), fn: "update_staff_finance_period", args: updatePeriodArgs({ periodId, dueDate, expectedVersion }) });
const payCall = (periodId: string, amount: number, o: { purpose?: string; key?: string; paidAt?: string } = {}): Call => ({
  userId: OWNER(),
  fn: "record_staff_payment",
  args: recordArgs({ periodId, purpose: o.purpose ?? "salary", amount, method: "cash", paidAt: o.paidAt ?? instantAgo(5), idempotencyKey: o.key ?? newKey() }),
});
const voidPayCall = (paymentId: string): Call => ({ userId: OWNER(), fn: "void_staff_payment", args: voidPaymentArgs(paymentId, "es zamanli iptal") });
const finalizeCall = (periodId: string, expectedVersion: number): Call => ({ userId: OWNER(), fn: "finalize_staff_finance_period", args: finalizeArgs({ periodId, expectedVersion }) });
const reopenCall = (periodId: string, expectedVersion: number): Call => ({ userId: OWNER(), fn: "reopen_staff_finance_period", args: reopenArgs({ periodId, reason: "es zamanli", expectedVersion }) });
const cancelCall = (periodId: string): Call => ({ userId: OWNER(), fn: "cancel_staff_finance_period", args: cancelArgs(periodId, "es zamanli iptal") });
const addLineCall = (periodId: string, kind: string, amount: number, o: { description?: string | null; key?: string } = {}): Call => ({
  userId: OWNER(),
  fn: "add_staff_period_line",
  args: addLineArgs({ periodId, kind, amount, description: o.description ?? (/^adjustment_/.test(kind) ? "Duzeltme" : null), idempotencyKey: o.key ?? newKey() }),
});
const editLineCall = (lineId: string, amount: number, expectedVersion: number, description: string | null = null): Call => ({ userId: OWNER(), fn: "update_staff_period_line", args: updateLineArgs({ lineId, amount, description, expectedVersion }) });
const voidLineCall = (lineId: string, expectedVersion: number): Call => ({ userId: OWNER(), fn: "void_staff_period_line", args: voidLineArgs({ lineId, reason: "es zamanli iptal", expectedVersion }) });

/** The error codes a race may legitimately produce; anything else (23505, 40P01, 40001, XX000, ...) fails the iteration. */
function expectOnlyCodes(outcomes: Record<string, RpcOutcome<unknown>>, allowed: string[]) {
  for (const [label, out] of Object.entries(outcomes)) {
    if (!out.ok) expect(allowed, `${label} failed with ${out.code}: ${out.message}`).toContain(out.code);
  }
}
const okOf = (o: RpcOutcome<WriteResult>) => (o.ok ? o.data : undefined);
const codeOf = (o: RpcOutcome<unknown>) => (o.ok ? null : o.code);
const real = (o: RpcOutcome<WriteResult>) => o.ok && o.data.noop === false;

async function openWithSalary(amount = 1000) {
  const p = await makePeriod(world);
  await makeLine(p.periodId, "salary", amount, {}, world.owner);
  return p.periodId;
}
async function finalizedWithSalary(amount = 1000) {
  const periodId = await openWithSalary(amount);
  const v = (await periodRow(periodId)).version;
  expectOk(await finalizePeriod(OWNER(), { periodId, expectedVersion: v }));
  return periodId;
}

/** Row-level consistency: cached totals equal the live sums, the floors hold, a cancelled period holds no posted payment. */
async function assertStateConsistent(periodId: string) {
  const row = await periodRow(periodId);
  const o = await oracleTotals(periodId);
  const cents = (n: number) => Math.round(n * 100);
  expect([cents(Number(row.earning_total)), cents(Number(row.employee_deduction_total)), cents(Number(row.employer_cost_total)), cents(Number(row.paid_total)), cents(Number(row.advance_total))], "cached totals equal the live sums").toEqual([cents(o.earning), cents(o.deduction), cents(o.employer), cents(o.paid), cents(o.advances)]);
  expect(cents(o.deduction), "deductions at most earnings").toBeLessThanOrEqual(cents(o.earning));
  expect(cents(o.advances), "advances at most payments").toBeLessThanOrEqual(cents(o.paid));
  if (row.lifecycle === "finalized") {
    expect(cents(o.paid), "a finalized period never holds payments above its net").toBeLessThanOrEqual(cents(o.earning - o.deduction));
    expect(row.finalized_earning_total).not.toBeNull();
  }
  if (row.lifecycle === "cancelled") expect(cents(o.paid), "a cancelled period holds no posted payment").toBe(0);
  return { row, o };
}

/** K14: the version equals 1 plus the number of committed real changes, reconstructed from the audit trail. */
async function assertVersionAccounting(periodId: string) {
  const [row] = await testDb<{ version: number; events: number }[]>`
    select pe.version,
           ((select count(*) from audit_logs a where a.entity_type = 'staff_finance_period' and a.entity_id = pe.id
               and a.action in ('finance.staff_period_updated', 'finance.staff_period_finalized', 'finance.staff_period_reopened', 'finance.staff_period_cancelled'))
          + (select count(*) from audit_logs a where a.entity_type in ('staff_period_line', 'staff_payment') and a.after ->> 'period_id' = pe.id::text
               and a.action in ('finance.staff_line_added', 'finance.staff_line_updated', 'finance.staff_line_voided', 'finance.staff_payment_recorded', 'finance.staff_payment_voided')))::int as events
    from staff_finance_periods pe where pe.id = ${periodId}`;
  expect(row!.version, "version = 1 + audited real changes (no skip, no double)").toBe(1 + row!.events);
}

async function assertConsistent(periodId: string) {
  await assertStateConsistent(periodId);
  await assertVersionAccounting(periodId);
}

async function repeat(name: string, body: (i: number) => Promise<void>) {
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      await body(i);
    } catch (error) {
      (error as Error).message = `[${name}, iteration ${i + 1}/${ITERATIONS}, seed ${SEED}] ${(error as Error).message}`;
      throw error;
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------
// the scenarios
// ----------------------------------------------------------------------------------------------------------------

describe("K concurrency (real parallel connections, driver barrier)", () => {
  it(
    "K1 two creates with the same key and an identical payload: one row, the same id, exactly one noop, one audit",
    async () => {
      await repeat("K1", async (i) => {
        const staff = await newStaff(world);
        const input = validPeriod(world, staff.id, i % 2 ? { dueDate: "2026-09-20" } : {});
        const out = await race({ a: createCall(input), b: createCall(input) });
        expectOnlyCodes(out, []);
        const a = okOf(out.a)!;
        const b = okOf(out.b)!;
        expect(a.periodId).toBe(b.periodId);
        expect([a.noop, b.noop].filter(Boolean)).toHaveLength(1);
        expect(a.version).toBe(1);
        const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_finance_periods where tenant_id = ${T()} and idempotency_key = ${input.idempotencyKey!}`;
        expect(Number(n!.n)).toBe(1);
        expect(await staffAudit(T(), "finance.staff_period_created", a.periodId)).toHaveLength(1);
        await assertConsistent(a.periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K2 two creates with the same key and different payloads: one row, the loser FN007, never a raw unique violation",
    async () => {
      await repeat("K2", async () => {
        const staff = await newStaff(world);
        const key = newKey();
        const out = await race({
          a: createCall(validPeriod(world, staff.id, { idempotencyKey: key, dueDate: "2026-09-20" })),
          b: createCall(validPeriod(world, staff.id, { idempotencyKey: key, dueDate: "2026-09-25" })),
        });
        expectOnlyCodes(out, ["FN007"]);
        const winners = [out.a, out.b].filter((o) => o.ok);
        expect(winners).toHaveLength(1);
        expect([out.a, out.b].filter((o) => !o.ok).map(codeOf)).toEqual(["FN007"]);
        const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_finance_periods where tenant_id = ${T()} and idempotency_key = ${key}`;
        expect(Number(n!.n)).toBe(1);
        await assertConsistent(okOf(winners[0]!)!.periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K3 two creates with different keys for the same staff member and month: one succeeds, the other FN028, never a raw unique violation",
    async () => {
      await repeat("K3", async () => {
        const staff = await newStaff(world);
        const out = await race({ a: createCall(validPeriod(world, staff.id)), b: createCall(validPeriod(world, staff.id)) });
        expectOnlyCodes(out, ["FN028"]);
        expect([out.a, out.b].filter((o) => o.ok)).toHaveLength(1);
        const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_finance_periods where tenant_id = ${T()} and staff_member_id = ${staff.id}`;
        expect(Number(n!.n)).toBe(1);
        await assertConsistent((await testDb<{ id: string }[]>`select id from staff_finance_periods where tenant_id = ${T()} and staff_member_id = ${staff.id}`)[0]!.id);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K4 two payments (two advances included) in an open period: both succeed, no cap, the state may be overpaid",
    async () => {
      await repeat("K4", async (i) => {
        const periodId = await openWithSalary(100);
        const purposes = i % 2 ? ["advance", "advance"] : ["salary", "advance"];
        const out = await race({ a: payCall(periodId, 80, { purpose: purposes[0] }), b: payCall(periodId, 80, { purpose: purposes[1] }) });
        expectOnlyCodes(out, []);
        expect(okOf(out.a)!.noop).toBe(false);
        expect(okOf(out.b)!.noop).toBe(false);
        const row = await periodRow(periodId);
        expect(Number(row.paid_total)).toBe(160);
        expect(row.payment_state).toBe("overpaid");
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K5 two payments with the same key and the same payload: one payment, one noop",
    async () => {
      await repeat("K5", async () => {
        const periodId = await openWithSalary(1000);
        const key = newKey();
        const paidAt = instantAgo(7);
        const out = await race({ a: payCall(periodId, 100, { key, paidAt }), b: payCall(periodId, 100, { key, paidAt }) });
        expectOnlyCodes(out, []);
        expect([okOf(out.a)!.noop, okOf(out.b)!.noop].filter(Boolean)).toHaveLength(1);
        expect(okOf(out.a)!.paymentId).toBe(okOf(out.b)!.paymentId);
        expect(await paymentRows(periodId)).toHaveLength(1);
        expect(await staffAudit(T(), "finance.staff_payment_recorded")).toSatisfy((rows: { after: Record<string, unknown> | null }[]) => rows.filter((r) => r.after?.period_id === periodId).length === 1);
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K6 a payment against finalize: either order is valid; a finalized period always has P at most N",
    async () => {
      await repeat("K6", async (i) => {
        const periodId = await openWithSalary(1000);
        await makePayment(periodId, 600, {}, world.owner);
        const v = (await periodRow(periodId)).version;
        const amount = i % 2 ? 500 : 300; // 500 would exceed the net together with the prior 600; 300 fits
        const out = await race({ pay: payCall(periodId, amount), fin: finalizeCall(periodId, v) });
        expectOnlyCodes(out, ["FN013", "FN023", "FN033"]);
        const row = await periodRow(periodId);
        if (amount === 500) {
          // payment first: P = 1100 above the net, so finalize is FN033 (or stale FN013); finalize first: payment is FN023
          expect([out.pay.ok, out.fin.ok].filter(Boolean).length).toBeLessThanOrEqual(1);
          if (!out.pay.ok) expect(codeOf(out.pay)).toBe("FN023");
          if (!out.fin.ok) expect(["FN013", "FN033"]).toContain(codeOf(out.fin));
        } else {
          expect(out.pay.ok).toBe(true); // 300 always fits (open: no cap; finalized: outstanding 400)
        }
        if (row.lifecycle === "finalized") expect(Number(row.paid_total)).toBeLessThanOrEqual(Number(row.net_payable));
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K7 a payment against cancel: exactly one wins; never cancelled with a posted payment",
    async () => {
      await repeat("K7", async () => {
        const periodId = await openWithSalary(1000);
        const out = await race({ pay: payCall(periodId, 100), cancel: cancelCall(periodId) });
        expectOnlyCodes(out, ["FN025", "FN027"]);
        expect([out.pay.ok, out.cancel.ok].filter(Boolean)).toHaveLength(1);
        if (!out.pay.ok) expect(codeOf(out.pay)).toBe("FN025");
        if (!out.cancel.ok) expect(codeOf(out.cancel)).toBe("FN027");
        const { row, o } = await assertStateConsistent(periodId);
        if (row.lifecycle === "cancelled") expect(o.paid).toBe(0);
        await assertVersionAccounting(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K8 two payments that together exceed the outstanding amount of a finalized period: one succeeds, one FN023; P never above N",
    async () => {
      await repeat("K8", async () => {
        const periodId = await finalizedWithSalary(1000);
        const out = await race({ a: payCall(periodId, 600), b: payCall(periodId, 600) });
        expectOnlyCodes(out, ["FN023"]);
        expect([out.a, out.b].filter((o) => o.ok)).toHaveLength(1);
        expect([out.a, out.b].filter((o) => !o.ok).map(codeOf)).toEqual(["FN023"]);
        const row = await periodRow(periodId);
        expect(Number(row.paid_total)).toBe(600);
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K9 a void against a void of the same payment: no deadlock, both answer, one audit event",
    async () => {
      await repeat("K9", async () => {
        const periodId = await openWithSalary(1000);
        const pay = await makePayment(periodId, 200, {}, world.owner);
        const out = await race({ a: voidPayCall(pay.paymentId!), b: voidPayCall(pay.paymentId!) });
        expectOnlyCodes(out, []);
        expect([okOf(out.a)!.noop, okOf(out.b)!.noop].filter(Boolean)).toHaveLength(1);
        const voided = (await staffAudit(T(), "finance.staff_payment_voided")).filter((r) => r.entity_id === pay.paymentId);
        expect(voided).toHaveLength(1);
        expect(Number((await periodRow(periodId)).paid_total)).toBe(0);
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K10 two line edits with the same expected version: one succeeds, one FN013",
    async () => {
      await repeat("K10", async () => {
        const periodId = await openWithSalary(1000);
        const l1 = await makeLine(periodId, "bonus", 100, {}, world.owner);
        const l2 = await makeLine(periodId, "commission", 200, {}, world.owner);
        const v = (await periodRow(periodId)).version;
        const out = await race({ a: editLineCall(l1.lineId!, 110, v), b: editLineCall(l2.lineId!, 220, v) });
        expectOnlyCodes(out, ["FN013"]);
        expect([out.a, out.b].filter((o) => o.ok)).toHaveLength(1);
        expect([out.a, out.b].filter((o) => !o.ok).map(codeOf)).toEqual(["FN013"]);
        expect((await periodRow(periodId)).version).toBe(v + 1);
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K11 an earning line added against finalize: never both; finalize first gives FN024, an earlier add makes the finalize stale or it succeeds without the line",
    async () => {
      await repeat("K11", async () => {
        const periodId = await openWithSalary(1000);
        const v = (await periodRow(periodId)).version;
        const out = await race({ add: addLineCall(periodId, "bonus", 50), fin: finalizeCall(periodId, v) });
        expectOnlyCodes(out, ["FN013", "FN024"]);
        const row = await periodRow(periodId);
        if (out.add.ok && out.fin.ok) throw new Error("both the add and the finalize succeeded");
        if (row.lifecycle === "finalized") {
          expect(codeOf(out.add)).toBe("FN024");
          // the snapshot is the statement at the instant of finalization: salary only
          expect(Number(row.finalized_earning_total)).toBe(1000);
          expect(Number(row.earning_total)).toBe(1000);
        } else {
          expect(out.add.ok).toBe(true);
          expect(["FN013"]).toContain(codeOf(out.fin));
        }
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K12 a reopen against a payment on a finalized period: a reopen succeeds only when no posted post-finalization payment exists",
    async () => {
      await repeat("K12", async () => {
        const periodId = await finalizedWithSalary(1000);
        const v = (await periodRow(periodId)).version;
        const out = await race({ reopen: reopenCall(periodId, v), pay: payCall(periodId, 100) });
        expectOnlyCodes(out, ["FN013", "FN027"]);
        const row = await periodRow(periodId);
        const pays = await paymentRows(periodId);
        if (row.lifecycle === "open") {
          // reopened: no posted post-finalization payment may exist
          expect(pays.filter((p) => p.status === "posted" && p.post_finalization)).toHaveLength(0);
        }
        if (out.reopen.ok && out.pay.ok) {
          // reopen first: the payment landed on an open period (not flagged), allowed without a cap
          expect(pays.filter((p) => p.post_finalization)).toHaveLength(0);
        }
        if (!out.reopen.ok) expect(["FN013", "FN027"]).toContain(codeOf(out.reopen));
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K13 / K14 twenty mixed payments, voids, line edits and adds on one period: the final state equals the oracle and the version accounting reconciles",
    async () => {
      await repeat("K13", async () => {
        const periodId = await openWithSalary(5000);
        const edits = [await makeLine(periodId, "bonus", 100, {}, world.owner), await makeLine(periodId, "commission", 100, {}, world.owner), await makeLine(periodId, "overtime", 100, {}, world.owner), await makeLine(periodId, "other_earning", 100, {}, world.owner)];
        const prior = [await makePayment(periodId, 50, {}, world.owner), await makePayment(periodId, 60, {}, world.owner), await makePayment(periodId, 70, {}, world.owner), await makePayment(periodId, 80, {}, world.owner)];
        const v = (await periodRow(periodId)).version;
        const calls: Record<string, Call> = {};
        for (let k = 0; k < 8; k++) calls[`pay${k}`] = payCall(periodId, 10 + k, { purpose: ["salary", "advance", "bonus", "other"][k % 4] });
        prior.forEach((p, k) => (calls[`void${k}`] = voidPayCall(p.paymentId!)));
        edits.forEach((l, k) => (calls[`edit${k}`] = editLineCall(l.lineId!, 150 + k, v)));
        for (let k = 0; k < 4; k++) calls[`add${k}`] = addLineCall(periodId, "other_employer_cost", 5 + k);
        const out = await race(calls);
        expectOnlyCodes(out, ["FN013"]);
        for (const [label, o] of Object.entries(out)) {
          if (!o.ok) expect(label.startsWith("edit"), `only a stale edit may fail: ${label}`).toBe(true);
        }
        // every edit carries the version read before the race and every other call in it also bumps the version, so at most
        // one edit can win (the one that runs before any other committed change) and it is entirely legitimate that none does
        expect(Object.entries(out).filter(([l, o]) => l.startsWith("edit") && o.ok).length).toBeLessThanOrEqual(1);
        // the oracle: the child rows are the truth
        const row = await periodRow(periodId);
        const o = await oracleTotals(periodId);
        expect(Math.round(o.paid * 100)).toBe(Math.round((50 + 60 + 70 + 80 + [0, 1, 2, 3, 4, 5, 6, 7].reduce((a, k) => a + 10 + k, 0) - 260) * 100));
        expect(Number(row.paid_total)).toBe(o.paid);
        const lines = await lineRows(periodId);
        expect(lines.filter((l) => l.kind === "other_employer_cost")).toHaveLength(4);
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K15 an adjustment debit against a payment on a finalized period: either order valid; P at most N in both",
    async () => {
      await repeat("K15", async (i) => {
        const periodId = await finalizedWithSalary(1000);
        const payAmount = i % 2 ? 1000 : 500; // 1000 conflicts with a debit of 100 (net 900); 500 fits either way
        const out = await race({ pay: payCall(periodId, payAmount), debit: addLineCall(periodId, "adjustment_debit", 100) });
        expectOnlyCodes(out, ["FN023", "FN026"]);
        if (payAmount === 1000) {
          expect([out.pay.ok, out.debit.ok].filter(Boolean)).toHaveLength(1);
          if (!out.pay.ok) expect(codeOf(out.pay)).toBe("FN023");
          if (!out.debit.ok) expect(codeOf(out.debit)).toBe("FN026");
        } else {
          expect(out.pay.ok && out.debit.ok).toBe(true);
        }
        const row = await periodRow(periodId);
        expect(Number(row.paid_total)).toBeLessThanOrEqual(Number(row.net_payable));
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K16 stale-version storm: five due-date edits with the same expected version: exactly one succeeds, four FN013",
    async () => {
      await repeat("K16", async () => {
        const periodId = await openWithSalary(100);
        const v = (await periodRow(periodId)).version;
        const out = await race({
          a: updateDueCall(periodId, "2026-09-11", v),
          b: updateDueCall(periodId, "2026-09-12", v),
          c: updateDueCall(periodId, "2026-09-13", v),
          d: updateDueCall(periodId, "2026-09-14", v),
          e: updateDueCall(periodId, "2026-09-15", v),
        });
        expectOnlyCodes(out, ["FN013"]);
        expect(Object.values(out).filter((o) => o.ok)).toHaveLength(1);
        expect((await periodRow(periodId)).version).toBe(v + 1);
        await assertConsistent(periodId);
      });
    },
    TEST_TIMEOUT,
  );
});

// ----------------------------------------------------------------------------------------------------------------
// K1b: the deterministic window of create_staff_finance_period (fault injection)
// ----------------------------------------------------------------------------------------------------------------

const CREATE_SIGNATURE = "private.create_staff_finance_period(uuid,uuid,date,uuid,date)";

/**
 * Runs `body` while a copy of private.create_staff_finance_period is installed that sleeps for the transaction-local
 * setting app.k1b_delay seconds (a no-op when the setting is absent) right after the replay block, then puts the ORIGINAL
 * definition back (also when the body throws). CREATE OR REPLACE keeps the owner and the grants.
 */
async function withDelayedCreate<T>(body: () => Promise<T>): Promise<T> {
  const [row] = await testDb<{ def: string }[]>`select pg_get_functiondef(${CREATE_SIGNATURE}::regprocedure) as def`;
  const original = row!.def;
  // the end of the replay block: the "different payload" raise and the `end if;` that closes `if found then`
  const anchor = "    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';\n  end if;\n";
  const at = original.indexOf(anchor);
  if (at < 0) throw new Error("the replay block anchor is missing from the live create_staff_finance_period");
  const end = at + anchor.length;
  const injected = original.slice(0, end) + "  perform pg_sleep(nullif(current_setting('app.k1b_delay', true), '')::numeric);\n" + original.slice(end);
  await testDb.unsafe(injected);
  try {
    return await body();
  } finally {
    await testDb.unsafe(original);
  }
}

describe("K1b the window between the replay lookup and the insert of create_staff_finance_period (fault-injected delay)", () => {
  it(
    "K1b an identical create still gets the noop when the winner commits between ITS replay lookup and ITS checks and insert",
    async () => {
      // The slow call's replay lookup MISSES (the winner has not committed yet), then it sleeps; the fast call creates and
      // commits the period; only then the slow call continues. An identical retry must be answered like a replay (noop),
      // never with a spurious duplicate-month error or a unique violation.
      await withDelayedCreate(async () => {
        for (let i = 0; i < Math.max(3, Math.min(ITERATIONS, 8)); i++) {
          const staff = await newStaff(world);
          const input = validPeriod(world, staff.id);
          const out = await race({
            slow: { ...createCall(input), settings: { "app.k1b_delay": "0.6" } },
            fast: createCall(input),
          });
          expectOnlyCodes(out, []);
          expect(okOf(out.slow)!.periodId).toBe(okOf(out.fast)!.periodId);
          expect([okOf(out.slow)!.noop, okOf(out.fast)!.noop].filter(Boolean)).toHaveLength(1);
          const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_finance_periods where tenant_id = ${T()} and staff_member_id = ${staff.id}`;
          expect(Number(n!.n)).toBe(1);
          await assertConsistent(okOf(out.fast)!.periodId);
        }
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K1c the same window with a DIFFERENT key for the same staff member and month is FN028, and with the same key but another payload FN007; no raw unique violation",
    async () => {
      await withDelayedCreate(async () => {
        for (let i = 0; i < 4; i++) {
          const staff = await newStaff(world);
          const first = validPeriod(world, staff.id);
          const otherKey = validPeriod(world, staff.id); // a different key, same staff member and month
          const out = await race({
            slow: { ...createCall(otherKey), settings: { "app.k1b_delay": "0.6" } },
            fast: createCall(first),
          });
          expectOnlyCodes(out, ["FN028"]);
          expect(out.fast.ok).toBe(true);
          expect(codeOf(out.slow)).toBe("FN028");

          const staff2 = await newStaff(world);
          const key = newKey();
          const a = validPeriod(world, staff2.id, { idempotencyKey: key });
          const b = validPeriod(world, staff2.id, { idempotencyKey: key, dueDate: "2026-09-28" });
          const out2 = await race({
            slow: { ...createCall(b), settings: { "app.k1b_delay": "0.6" } },
            fast: createCall(a),
          });
          expectOnlyCodes(out2, ["FN007"]);
          expect(out2.fast.ok).toBe(true);
          expect(codeOf(out2.slow)).toBe("FN007");
        }
      });
    },
    TEST_TIMEOUT,
  );
});
