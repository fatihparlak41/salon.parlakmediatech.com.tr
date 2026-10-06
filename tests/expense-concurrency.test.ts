import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createExpenseWorld,
  destroyExpenseWorld,
  buildCall,
  toOutcome,
  createArgs,
  updateArgs,
  cancelArgs,
  recordArgs,
  voidArgs,
  makeExpense,
  makePayment,
  validCreate,
  expenseRow,
  paymentRows,
  postedTotal,
  expenseAudit,
  newKey,
  instantAgo,
  ip,
  uniqueText,
  type ExpenseWorld,
  type ExpenseWriteResult,
  type RpcArg,
  type RpcOutcome,
} from "./expense-fixtures";

/**
 * Faz FIN.1B.1 — concurrency (matrix group K, the Promise.all-over-real-connections layer). Every scenario runs N
 * iterations; each iteration builds fresh rows, races the competing calls behind a driver-level barrier (every transaction
 * is open, `authenticated`, JWT claims set, and parked BEFORE any of them sends its statement, released in a random order),
 * then asserts the scenario's invariant, that the expense is internally consistent, and the version accounting.
 *
 * K_ITERATIONS (default 20), K_POOL_MAX (default 24: the largest number of simultaneously parked transactions), K_SEED and
 * K_BARRIER tune a run. K_BARRIER=server adds a SERVER-clock barrier on top of the driver gate: every parked transaction
 * additionally sleeps until one common instant chosen on the database clock (pg_sleep_until), so the competing statements
 * start within microseconds of each other regardless of driver or network jitter. The 50+ iteration runs use it.
 *
 * NOTE for whoever runs this file next: it needs migration 20261003090000 applied to whatever TEST_DATABASE_URL points
 * at (a disposable PROD-derived branch or the local rig, never the shared DEV database).
 */

const ITERATIONS = Math.max(1, Number(process.env.K_ITERATIONS ?? 20));
const POOL_MAX = Math.max(4, Number(process.env.K_POOL_MAX ?? 24));
const SEED = Number(process.env.K_SEED ?? 20261003);
const SERVER_BARRIER = process.env.K_BARRIER === "server";
// how far ahead of the database clock the common start instant is set; it must exceed the round trip to a remote database
const BARRIER_LEAD_MS = Math.max(
  50,
  Number(process.env.K_BARRIER_LEAD_MS ?? 250),
);
const TEST_TIMEOUT = 600_000;

let world: ExpenseWorld;
let pool: Sql;

beforeAll(async () => {
  world = await createExpenseWorld("fin1b1-conc");
  pool = postgres(process.env.TEST_DATABASE_URL!, {
    ssl: "require",
    max: POOL_MAX,
    onnotice: () => undefined,
  });
});

afterAll(async () => {
  await pool?.end({ timeout: 10 });
  await destroyExpenseWorld(world);
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

function shuffled<T>(items: T[], rng: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * An instant `ms` milliseconds ahead on the DATABASE clock (UTC text), the common start of a server-side barrier.
 * It is read through `testDb`, never through the race `pool`: when a race parks as many transactions as the pool has
 * connections (K10 with a small K_POOL_MAX), a clock query on the pool would wait for a connection that is only freed once
 * the barrier is released, and the whole file would hang.
 */
async function serverInstantAhead(ms: number): Promise<string> {
  const [row] = await testDb<{ t: string }[]>`
    select to_char(clock_timestamp() at time zone 'UTC' + (${ms}::int * interval '1 millisecond'), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`;
  return row!.t;
}

/**
 * `holdMs` keeps the call's transaction open for that long after the statement (its locks and unique-index entries stay);
 * `settings` are transaction-local custom settings (set_config) applied before the call is parked at the barrier.
 */
type Call = {
  userId: string;
  fn: string;
  args: RpcArg[];
  holdMs?: number;
  settings?: Record<string, string>;
};
type Outcomes<L extends Record<string, Call>> = {
  [K in keyof L]: RpcOutcome<ExpenseWriteResult>;
};

/**
 * Runs the labelled calls truly concurrently: one pooled connection and one transaction per call, all armed (role and
 * claims set) behind a barrier, then released in a random order within one tick.
 */
async function race<L extends Record<string, Call>>(
  calls: L,
): Promise<Outcomes<L>> {
  const labels = Object.keys(calls);
  if (labels.length > POOL_MAX)
    throw new Error(
      `${labels.length} concurrent calls exceed K_POOL_MAX=${POOL_MAX}`,
    );
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
        for (const [name, value] of Object.entries(call.settings ?? {}))
          await sql`select set_config(${name}, ${value}, true)`;
        armed += 1;
        if (armed === labels.length) allArmed();
        await gates[idx]!.promise;
        if (SERVER_BARRIER)
          await sql`select pg_sleep_until(${serverStart}::text::timestamptz)`;
        const result = await sql.unsafe(query, params as never[]);
        if (call.holdMs) await sql`select pg_sleep(${call.holdMs / 1000})`;
        return result;
      });
      return [
        label,
        {
          ok: true,
          data: (rows[0] as unknown as { r: ExpenseWriteResult }).r,
        } as RpcOutcome<ExpenseWriteResult>,
      ] as const;
    } catch (error) {
      return [label, toOutcome<ExpenseWriteResult>(error)] as const;
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 20_000);
  });
  const first = await Promise.race([
    armedPromise.then(() => "armed" as const),
    timedOut,
  ]);
  clearTimeout(timer);
  if (SERVER_BARRIER) serverStart = await serverInstantAhead(BARRIER_LEAD_MS);
  for (const gate of shuffled(gates)) gate.release();
  const settled = await Promise.all(tasks);
  if (first === "timeout")
    throw new Error(
      "the race barrier was not armed within 20 s (pool exhausted or connection failure)",
    );
  return Object.fromEntries(settled) as Outcomes<L>;
}

const pay = (
  expenseId: string,
  amount: number,
  key: string = newKey(),
  userId: string = OWNER(),
  paidAt: string = instantAgo(5),
): Call => ({
  userId,
  fn: "record_expense_payment",
  args: recordArgs({
    expenseId,
    amount,
    method: "cash",
    paidAt,
    idempotencyKey: key,
  }),
});
const voidCall = (paymentId: string, userId = OWNER()): Call => ({
  userId,
  fn: "void_expense_payment",
  args: voidArgs(paymentId, "es zamanli iptal"),
});
const cancelCall = (expenseId: string, userId = OWNER()): Call => ({
  userId,
  fn: "cancel_expense",
  args: cancelArgs(expenseId, "es zamanli iptal"),
});
const editCall = (
  row: Awaited<ReturnType<typeof expenseRow>>,
  change: { amount?: number; categoryKey?: string; description?: string },
  expectedVersion = row.version,
  userId = OWNER(),
): Call => ({
  userId,
  fn: "update_expense",
  args: updateArgs({
    expenseId: row.id,
    categoryKey: change.categoryKey ?? row.category_key,
    description: change.description ?? row.description,
    expenseDate: row.expense_date,
    amount: change.amount ?? Number(row.amount),
    expectedVersion,
    branchId: row.branch_id,
    vendorName: row.vendor_name,
    dueDate: row.due_date,
    note: row.note,
  }),
});

/** The error codes a race may legitimately produce; anything else (23505, 40P01, 40001, XX000, ...) fails the iteration. */
function expectOnlyCodes(
  outcomes: Record<string, RpcOutcome<unknown>>,
  allowed: string[],
) {
  for (const [label, out] of Object.entries(outcomes)) {
    if (!out.ok)
      expect(
        allowed,
        `${label} failed with ${out.code}: ${out.message}`,
      ).toContain(out.code);
  }
}

const okOf = (o: RpcOutcome<ExpenseWriteResult>) => (o.ok ? o.data : undefined);
const codeOf = (o: RpcOutcome<unknown>) => (o.ok ? null : o.code);

/** K11: the version equals 1 plus the number of committed tracked changes, reconstructed two independent ways. */
async function assertVersionAccounting(expenseId: string) {
  const [row] = await testDb<
    {
      version: number;
      settlement_events: number;
      expense_events: number;
      payment_events: number;
      payment_rows: number;
      voided_rows: number;
    }[]
  >`
    select e.version, e.settlement_events,
           (select count(*)::int from audit_logs a where a.entity_type = 'expense' and a.entity_id::text = e.id::text
              and a.action in ('finance.expense_updated', 'finance.expense_cancelled')) as expense_events,
           (select count(*)::int from audit_logs a where a.entity_type = 'expense_payment'
              and a.action in ('finance.expense_payment_recorded', 'finance.expense_payment_voided')
              and a.after ->> 'expense_id' = e.id::text) as payment_events,
           (select count(*)::int from expense_payments p where p.expense_id = e.id) as payment_rows,
           (select count(*)::int from expense_payments p where p.expense_id = e.id and p.status = 'voided') as voided_rows
    from expenses e where e.id = ${expenseId}`;
  expect(
    row!.version,
    "version = 1 + audited updates and cancels + audited payment events",
  ).toBe(1 + row!.expense_events + row!.payment_events);
  expect(
    row!.version,
    "version = 1 + audited updates and cancels + payment rows + voided rows",
  ).toBe(1 + row!.expense_events + row!.payment_rows + row!.voided_rows);
  expect(row!.settlement_events).toBe(row!.payment_rows + row!.voided_rows);
}

/** Final status equals the status derived from the posted payments; posted never exceeds the amount; cancelled has no posted. */
/** Row-level consistency only (no audit accounting): what hand-written SQL writers can be held to. */
async function assertStateConsistent(expenseId: string) {
  const row = await expenseRow(expenseId);
  const posted = await postedTotal(expenseId);
  const amount = Number(row.amount);
  expect(posted, "posted never above the amount").toBeLessThanOrEqual(amount);
  if (row.status === "cancelled") {
    expect(posted, "a cancelled expense never carries a posted payment").toBe(
      0,
    );
    expect(row.cancelled_at).not.toBeNull();
  } else {
    expect(row.status).toBe(
      posted >= amount ? "paid" : posted > 0 ? "partially_paid" : "open",
    );
  }
}

/** Full check for RPC-driven iterations: state plus the audit-based version accounting (K11). */
async function assertConsistent(expenseId: string) {
  await assertStateConsistent(expenseId);
  await assertVersionAccounting(expenseId);
}

const CREATE_EXPENSE_SIGNATURE =
  "private.create_expense(uuid,text,text,date,numeric,uuid,uuid,text,date,text,jsonb)";

/**
 * Fault injection for K1b: runs `body` while a copy of private.create_expense is installed that sleeps for the
 * transaction-local setting app.k1b_delay seconds (a no-op when the setting is absent) right after the replay block, then puts the
 * ORIGINAL definition back (also when the body throws). CREATE OR REPLACE keeps the owner and the grants.
 */
async function withDelayedCreate<T>(body: () => Promise<T>): Promise<T> {
  const [row] = await testDb<
    { def: string }[]
  >`select pg_get_functiondef(${CREATE_EXPENSE_SIGNATURE}::regprocedure) as def`;
  const original = row!.def;
  // the end of the replay block: the first "different payload" raise and the `end if;` that closes `if found then`
  const anchor =
    "    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';\n  end if;\n";
  const at = original.indexOf(anchor);
  if (at < 0)
    throw new Error(
      "the replay block anchor is missing from the live create_expense",
    );
  const end = at + anchor.length;
  const injected =
    original.slice(0, end) +
    "  perform pg_sleep(nullif(current_setting('app.k1b_delay', true), '')::numeric);\n" +
    original.slice(end);
  await testDb.unsafe(injected);
  try {
    return await body();
  } finally {
    await testDb.unsafe(original);
  }
}

async function repeat(name: string, body: (i: number) => Promise<void>) {
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      await body(i);
    } catch (error) {
      (error as Error).message =
        `[${name}, iteration ${i + 1}/${ITERATIONS}, seed ${SEED}] ${(error as Error).message}`;
      throw error;
    }
  }
}

describe("K concurrency (real parallel connections, driver barrier)", () => {
  it(
    "K1 two creates with the same key and an identical payload: one row, the same id, exactly one noop, one audit set",
    async () => {
      await repeat("K1", async (i) => {
        const withInitial = i % 2 === 1;
        const input = validCreate(world, {
          amount: 500,
          initialPayment: withInitial ? ip(200) : undefined,
        });
        const out = await race({
          a: { userId: OWNER(), fn: "create_expense", args: createArgs(input) },
          b: { userId: OWNER(), fn: "create_expense", args: createArgs(input) },
        });
        expectOnlyCodes(out, []);
        const a = okOf(out.a)!;
        const b = okOf(out.b)!;
        expect(a.expenseId).toBe(b.expenseId);
        expect([a.noop, b.noop].filter(Boolean)).toHaveLength(1);
        expect(a.version).toBe(withInitial ? 2 : 1);
        expect(b.version).toBe(a.version);
        const [rows] = await testDb<
          { n: string }[]
        >`select count(*)::text as n from expenses where tenant_id = ${T()} and idempotency_key = ${input.idempotencyKey!}`;
        expect(Number(rows!.n)).toBe(1);
        expect(
          await expenseAudit(T(), "finance.expense_created", a.expenseId),
        ).toHaveLength(1);
        expect((await paymentRows(a.expenseId)).length).toBe(
          withInitial ? 1 : 0,
        );
        const recorded = (
          await expenseAudit(T(), "finance.expense_payment_recorded")
        ).filter((r) => r.after?.expense_id === a.expenseId);
        expect(recorded).toHaveLength(withInitial ? 1 : 0);
        await assertConsistent(a.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K1b an identical create still gets the noop when the winner commits between ITS replay lookup and ITS insert (fault-injected delay)",
    async () => {
      // The window between create_expense's replay lookup and its insert is a few microseconds, so a timing-only test finds
      // a regression rarely. Here a copy of the live function sleeps right after the replay block when the transaction-local
      // setting app.k1b_delay is present, which makes the slow call's lookup MISS, lets the fast call commit completely, and
      // only then lets the slow call continue. The original definition is restored afterwards (and the copy is identical
      // unless the setting exists).
      await withDelayedCreate(async () => {
        await repeat("K1b", async (i) => {
          const input = validCreate(world, {
            amount: 500,
            initialPayment: i % 2 === 0 ? ip(200) : undefined,
          });
          const call = (delayed: boolean): Call => ({
            userId: OWNER(),
            fn: "create_expense",
            args: createArgs(input),
            settings: delayed ? { "app.k1b_delay": "0.4" } : undefined,
          });
          const out = await race({ fast: call(false), slow: call(true) });
          expectOnlyCodes(out, []);
          const fast = okOf(out.fast)!;
          const slow = okOf(out.slow)!;
          expect(fast.noop, "the call that was not delayed created it").toBe(
            false,
          );
          expect(
            slow.noop,
            "the delayed identical call is answered as a replay",
          ).toBe(true);
          expect(slow.expenseId).toBe(fast.expenseId);
          expect(slow.paymentId).toBe(fast.paymentId);
          expect(slow.version).toBe(fast.version);
          expect(
            await expenseAudit(T(), "finance.expense_created", fast.expenseId),
          ).toHaveLength(1);
          await assertConsistent(fast.expenseId);
        });
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K2 two creates with the same key and different payloads: one row, the loser gets FN007, never 23505",
    async () => {
      await repeat("K2", async () => {
        const key = newKey();
        const base = validCreate(world, { idempotencyKey: key });
        const out = await race({
          a: {
            userId: OWNER(),
            fn: "create_expense",
            args: createArgs({ ...base, amount: 100 }),
          },
          b: {
            userId: OWNER(),
            fn: "create_expense",
            args: createArgs({ ...base, amount: 200 }),
          },
        });
        expectOnlyCodes(out, ["FN007"]);
        const results = [out.a, out.b];
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok && r.code === "FN007")).toHaveLength(
          1,
        );
        const winner = results.find((r) => r.ok) as {
          ok: true;
          data: ExpenseWriteResult;
        };
        expect(winner.data.noop).toBe(false);
        const rows = await testDb<
          { id: string; amount: string }[]
        >`select id, amount::text as amount from expenses where tenant_id = ${T()} and idempotency_key = ${key}`;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(winner.data.expenseId);
        expect(
          await expenseAudit(
            T(),
            "finance.expense_created",
            winner.data.expenseId,
          ),
        ).toHaveLength(1);
        await assertConsistent(winner.data.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K3 two payments of 700 on a 1000 expense with different keys: one succeeds, one gets FN005, posted never above the amount",
    async () => {
      await repeat("K3", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const out = await race({
          a: pay(e.expenseId, 700),
          b: pay(e.expenseId, 700),
        });
        expectOnlyCodes(out, ["FN005"]);
        expect([out.a, out.b].filter((r) => r.ok)).toHaveLength(1);
        expect(
          [out.a, out.b].filter((r) => !r.ok && r.code === "FN005"),
        ).toHaveLength(1);
        expect(await postedTotal(e.expenseId)).toBe(700);
        expect(await paymentRows(e.expenseId)).toHaveLength(1);
        const row = await expenseRow(e.expenseId);
        expect(row.status).toBe("partially_paid");
        expect(row.version).toBe(2);
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K4 two payments with the same key and payload: one payment row, one noop, never 23505",
    async () => {
      await repeat("K4", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const key = newKey();
        const call = () => ({
          userId: OWNER(),
          fn: "record_expense_payment",
          args: recordArgs({
            expenseId: e.expenseId,
            amount: 300,
            method: "cash",
            paidAt: "2026-10-02T10:00:00.123456Z",
            idempotencyKey: key,
          }),
        });
        const out = await race({ a: call(), b: call() });
        expectOnlyCodes(out, []);
        const a = okOf(out.a)!;
        const b = okOf(out.b)!;
        expect(a.paymentId).toBe(b.paymentId);
        expect([a.noop, b.noop].filter(Boolean)).toHaveLength(1);
        expect(await paymentRows(e.expenseId)).toHaveLength(1);
        expect(
          (await expenseAudit(T(), "finance.expense_payment_recorded")).filter(
            (r) => r.after?.expense_id === e.expenseId,
          ),
        ).toHaveLength(1);
        expect((await expenseRow(e.expenseId)).version).toBe(2);
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K14 two payments with the SAME key on two DIFFERENT expenses of one tenant: one succeeds, the other is FN007, never 23505",
    async () => {
      await repeat("K14", async () => {
        const first = await makeExpense(world, { amount: 1000 });
        const second = await makeExpense(world, { amount: 1000 });
        const key = newKey();
        // Each call locks only ITS OWN expense, so nothing serializes them but the unique (tenant, key) index. Holding both
        // transactions open after the insert guarantees the loser's replay lookup cannot see the winner yet, so the loser
        // always reaches the insert, blocks on the index, and must surface FN007 (the mapped unique violation).
        const call = (expenseId: string): Call => ({
          userId: OWNER(),
          fn: "record_expense_payment",
          args: recordArgs({
            expenseId,
            amount: 100,
            method: "cash",
            paidAt: "2026-10-02T10:00:00.123456Z",
            idempotencyKey: key,
          }),
          holdMs: 60,
        });
        const out = await race({
          a: call(first.expenseId),
          b: call(second.expenseId),
        });
        expectOnlyCodes(out, ["FN007"]);
        expect([out.a, out.b].filter((r) => r.ok)).toHaveLength(1);
        expect(
          [out.a, out.b].filter((r) => !r.ok && r.code === "FN007"),
        ).toHaveLength(1);
        expect(okOf(out.a)?.noop ?? okOf(out.b)?.noop).toBe(false);
        const rows = await testDb<{ expense_id: string }[]>`
          select expense_id from expense_payments where tenant_id = ${T()} and idempotency_key = ${key}`;
        expect(rows).toHaveLength(1);
        const winner = rows[0]!.expense_id;
        const loser = winner === first.expenseId ? second : first;
        expect(await paymentRows(loser.expenseId)).toHaveLength(0);
        expect((await expenseRow(loser.expenseId)).version).toBe(1);
        expect((await expenseRow(winner)).version).toBe(2);
        await assertConsistent(first.expenseId);
        await assertConsistent(second.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K5a edit the amount to 600 against paying 500 on a 1000 expense: both orders are valid and end in the same state",
    async () => {
      await repeat("K5a", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const row = await expenseRow(e.expenseId);
        const out = await race({
          edit: editCall(row, { amount: 600 }),
          payment: pay(e.expenseId, 500),
        });
        // pay first: the edit sees version 2 and fails stale (FN013); edit first: the payment succeeds (500 <= 600)
        expectOnlyCodes(out, ["FN013"]);
        expect(out.payment.ok, "the payment fits under both 1000 and 600").toBe(
          true,
        );
        const final = await expenseRow(e.expenseId);
        if (out.edit.ok) {
          expect(Number(final.amount)).toBe(600);
          expect(final.version).toBe(3);
        } else {
          expect(Number(final.amount)).toBe(1000);
          expect(final.version).toBe(2);
        }
        expect(await postedTotal(e.expenseId)).toBe(500);
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K5b edit the amount to 600 against paying 700: exactly one wins and posted never exceeds the amount",
    async () => {
      await repeat("K5b", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const row = await expenseRow(e.expenseId);
        const out = await race({
          edit: editCall(row, { amount: 600 }),
          payment: pay(e.expenseId, 700),
        });
        expectOnlyCodes(out, ["FN005", "FN012", "FN013"]);
        const final = await expenseRow(e.expenseId);
        if (out.edit.ok) {
          // the edit committed first: the payment would overpay the new amount
          expect(codeOf(out.payment)).toBe("FN005");
          expect(Number(final.amount)).toBe(600);
          expect(await postedTotal(e.expenseId)).toBe(0);
        } else {
          // the payment committed first: the edit is stale (FN013) or would drop the amount below the posted total (FN012)
          expect(out.payment.ok).toBe(true);
          expect(["FN012", "FN013"]).toContain(codeOf(out.edit));
          expect(Number(final.amount)).toBe(1000);
          expect(await postedTotal(e.expenseId)).toBe(700);
        }
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K6 edit the category against the first payment: a category change after the first posted payment never happens",
    async () => {
      await repeat("K6", async () => {
        const e = await makeExpense(world, {
          amount: 1000,
          categoryKey: "supplies",
        });
        const row = await expenseRow(e.expenseId);
        const out = await race({
          edit: editCall(row, { categoryKey: "rent" }),
          payment: pay(e.expenseId, 100),
        });
        expectOnlyCodes(out, ["FN012", "FN013"]);
        expect(out.payment.ok).toBe(true);
        const final = await expenseRow(e.expenseId);
        if (out.edit.ok) {
          // serialized edit-then-pay: the edit produced version 2, the payment version 3
          expect(final.category_key).toBe("rent");
          expect(okOf(out.edit)!.version).toBe(2);
          expect(okOf(out.payment)!.version).toBe(3);
          expect(final.version).toBe(3);
        } else {
          // pay-then-edit: the structure lock (FN012) or the stale version (FN013) refuses the edit; the category is unchanged
          expect(final.category_key).toBe("supplies");
          expect(okOf(out.payment)!.version).toBe(2);
          expect(final.version).toBe(2);
        }
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K7 cancel against pay: exactly one wins and a cancelled expense never carries a posted payment",
    async () => {
      await repeat("K7", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const out = await race({
          cancel: cancelCall(e.expenseId),
          payment: pay(e.expenseId, 250),
        });
        expectOnlyCodes(out, ["FN008", "FN011"]);
        const final = await expenseRow(e.expenseId);
        expect([out.cancel, out.payment].filter((r) => r.ok)).toHaveLength(1);
        if (out.cancel.ok) {
          expect(codeOf(out.payment)).toBe("FN008");
          expect(final.status).toBe("cancelled");
          expect(await paymentRows(e.expenseId)).toHaveLength(0);
        } else {
          expect(codeOf(out.cancel)).toBe("FN011");
          expect(final.status).toBe("partially_paid");
          expect(await postedTotal(e.expenseId)).toBe(250);
        }
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K8a void against void on the same payment: both succeed, one real void and one noop, one audit event, one version bump",
    async () => {
      await repeat("K8a", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const p = await makePayment(world, e.expenseId, 400);
        const out = await race({
          a: voidCall(p.paymentId!),
          b: voidCall(p.paymentId!),
        });
        expectOnlyCodes(out, []);
        expect(
          [okOf(out.a)!.noop, okOf(out.b)!.noop].filter(Boolean),
        ).toHaveLength(1);
        expect(
          (
            await expenseAudit(
              T(),
              "finance.expense_payment_voided",
              p.paymentId!,
            )
          ).length,
        ).toBe(1);
        const final = await expenseRow(e.expenseId);
        expect(final.status).toBe("open");
        expect(final.version).toBe(3);
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K8b void against pay: no deadlock, both orders valid, posted never above the amount",
    async () => {
      await repeat("K8b", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const p = await makePayment(world, e.expenseId, 400);
        const out = await race({
          void: voidCall(p.paymentId!),
          payment: pay(e.expenseId, 700),
        });
        expectOnlyCodes(out, ["FN005"]);
        expect(out.void.ok, "a void never fails here").toBe(true);
        const posted = await postedTotal(e.expenseId);
        if (out.payment.ok)
          expect(posted).toBe(700); // void first, then 700 fits
        else expect(posted).toBe(0); // 400 + 700 would overpay, and the void then released the 400
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K8c void against edit: no deadlock, an amount below the posted total never happens",
    async () => {
      await repeat("K8c", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const p = await makePayment(world, e.expenseId, 400);
        const row = await expenseRow(e.expenseId);
        const out = await race({
          void: voidCall(p.paymentId!),
          edit: editCall(row, { amount: 300 }),
        });
        expectOnlyCodes(out, ["FN012", "FN013"]);
        expect(out.void.ok).toBe(true);
        const final = await expenseRow(e.expenseId);
        if (out.edit.ok)
          expect(Number(final.amount)).toBe(300); // the void committed first
        else expect(Number(final.amount)).toBe(1000); // stale (the void bumped the version) or below the posted total
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K9a two edits with the same expected version and different changes: one succeeds, one gets FN013",
    async () => {
      await repeat("K9a", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const row = await expenseRow(e.expenseId);
        const out = await race({
          a: editCall(row, { description: uniqueText("kisi A") }),
          b: editCall(row, { description: uniqueText("kisi B") }),
        });
        expectOnlyCodes(out, ["FN013"]);
        expect([out.a, out.b].filter((r) => r.ok)).toHaveLength(1);
        expect(
          [out.a, out.b].filter((r) => !r.ok && r.code === "FN013"),
        ).toHaveLength(1);
        expect((await expenseRow(e.expenseId)).version).toBe(2);
        expect(
          await expenseAudit(T(), "finance.expense_updated", e.expenseId),
        ).toHaveLength(1);
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K9b two IDENTICAL edits with the same expected version: one succeeds, the other still gets FN013 (a stale version is never a noop)",
    async () => {
      await repeat("K9b", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const row = await expenseRow(e.expenseId);
        const description = uniqueText("ayni degisiklik");
        const out = await race({
          a: editCall(row, { description }),
          b: editCall(row, { description }),
        });
        expectOnlyCodes(out, ["FN013"]);
        expect([out.a, out.b].filter((r) => r.ok)).toHaveLength(1);
        expect(
          [out.a, out.b].filter((r) => !r.ok && r.code === "FN013"),
        ).toHaveLength(1);
        const winner = [out.a, out.b].find((r) => r.ok) as {
          ok: true;
          data: ExpenseWriteResult;
        };
        expect(winner.data.noop).toBe(false);
        expect((await expenseRow(e.expenseId)).version).toBe(2);
        expect(
          await expenseAudit(T(), "finance.expense_updated", e.expenseId),
        ).toHaveLength(1);
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K10 mixed payments and voids on one expense (up to 8 voids + up to 12 payments): final status derived, no overpayment, no deadlock",
    async () => {
      // 20 concurrent operations with the default pool; a smaller K_POOL_MAX (a session pooler with few server connections)
      // shrinks both halves so that every parked transaction still fits.
      const voids = Math.min(8, Math.floor(POOL_MAX / 2));
      const payments = Math.min(12, POOL_MAX - voids);
      const rng = mulberry32(SEED);
      await repeat("K10", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const seeded: string[] = [];
        for (let n = 0; n < voids; n++)
          seeded.push((await makePayment(world, e.expenseId, 50)).paymentId!);
        const calls: Record<string, Call> = {};
        seeded.forEach(
          (paymentId, n) => (calls[`void${n}`] = voidCall(paymentId)),
        );
        const amounts = Array.from(
          { length: payments },
          () => 30 + 10 * Math.floor(rng() * 10),
        );
        amounts.forEach(
          (amount, n) => (calls[`pay${n}`] = pay(e.expenseId, amount)),
        );
        const out = await race(calls);
        expectOnlyCodes(out, ["FN005"]);
        for (let n = 0; n < voids; n++) {
          expect(out[`void${n}`]!.ok, `void ${n} never fails`).toBe(true);
          expect(okOf(out[`void${n}`]!)!.noop).toBe(false);
        }
        const succeeded = amounts
          .filter((_, n) => out[`pay${n}`]!.ok)
          .reduce((a, b) => a + b, 0);
        expect(
          await postedTotal(e.expenseId),
          "posted = the successful new payments (all 8 seeded ones were voided)",
        ).toBe(succeeded);
        const rows = await paymentRows(e.expenseId);
        expect(rows.filter((r) => r.status === "voided")).toHaveLength(voids);
        expect(rows.filter((r) => r.status === "posted")).toHaveLength(
          amounts.filter((_, n) => out[`pay${n}`]!.ok).length,
        );
        await assertConsistent(e.expenseId);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K11 version accounting over a random mixed workload: no skips, no doubles, status derived at every burst",
    async () => {
      const rng = mulberry32(SEED + 11);
      const bursts = Math.max(4, Math.ceil(ITERATIONS / 2));
      const e = await makeExpense(world, { amount: 5000 });
      const known: {
        paymentId: string;
        key: string;
        amount: number;
        paidAt: string;
      }[] = [];
      let cancelled = false;
      for (let burst = 0; burst < bursts; burst++) {
        const row = await expenseRow(e.expenseId);
        const calls: Record<string, Call> = {};
        const planned: {
          label: string;
          kind: "pay" | "void" | "edit" | "replay" | "cancel";
          key?: string;
          amount?: number;
          paidAt?: string;
        }[] = [];
        // up to 8 operations (the last burst adds a cancel), never more parked transactions than the pool allows
        const size = Math.min(4 + Math.floor(rng() * 5), POOL_MAX - 1);
        const addPayment = (label: string, amount: number) => {
          const key = newKey();
          const paidAt = instantAgo(5);
          calls[label] = pay(e.expenseId, amount, key, OWNER(), paidAt);
          planned.push({ label, kind: "pay", key, amount, paidAt });
        };
        for (let n = 0; n < size; n++) {
          const roll = rng();
          const label = `op${n}`;
          if (roll < 0.4) {
            addPayment(label, 50 + 25 * Math.floor(rng() * 8));
          } else if (roll < 0.6 && known.length > 0) {
            calls[label] = voidCall(
              known[Math.floor(rng() * known.length)]!.paymentId,
            );
            planned.push({ label, kind: "void" });
          } else if (roll < 0.8) {
            // half of the edits carry a deliberately stale expected version
            calls[label] = editCall(
              row,
              { description: uniqueText("rastgele") },
              rng() < 0.5 ? row.version : Math.max(1, row.version - 1),
            );
            planned.push({ label, kind: "edit" });
          } else if (known.length > 0) {
            const prior = known[Math.floor(rng() * known.length)]!;
            calls[label] = pay(
              e.expenseId,
              prior.amount,
              prior.key,
              OWNER(),
              prior.paidAt,
            ); // an exact replay of a landed payment
            planned.push({ label, kind: "replay" });
          } else {
            addPayment(label, 40);
          }
        }
        if (burst === bursts - 1) {
          calls.cancel = cancelCall(e.expenseId);
          planned.push({ label: "cancel", kind: "cancel" });
        }
        const out = await race(calls);
        // exact replays are never FN007, and nothing but the documented race outcomes may surface
        expectOnlyCodes(out, ["FN005", "FN008", "FN011", "FN013"]);
        for (const p of planned) {
          const result = okOf(out[p.label]!);
          if (p.kind === "replay")
            expect(
              result?.noop,
              `${p.label}: an exact replay of a landed payment is a noop`,
            ).toBe(true);
          // payments that landed become candidates for later voids and replays
          if (p.kind === "pay" && result?.paymentId && !result.noop)
            known.push({
              paymentId: result.paymentId,
              key: p.key!,
              amount: p.amount!,
              paidAt: p.paidAt!,
            });
          if (p.kind === "cancel" && result) cancelled = true;
        }
        await assertConsistent(e.expenseId);
      }
      // every landed payment is exactly one row, and the cancel only ever succeeded with nothing posted
      const rows = await paymentRows(e.expenseId);
      expect(rows.length).toBe(known.length);
      if (cancelled) expect(await postedTotal(e.expenseId)).toBe(0);
      await assertVersionAccounting(e.expenseId);
    },
    TEST_TIMEOUT,
  );
});

type DirectTask = (sql: postgres.TransactionSql) => Promise<unknown>;
type DirectOutcome = { ok: true } | { ok: false; code: string | undefined };

/**
 * Races hand-written SQL statements (no RPC, no role switch: the privileged connection a migration, a data fix or the future
 * FIN.1B.2 materializer would use) behind the same barrier. Each transaction does its statement and then HOLDS for `holdMs` before
 * committing, so a missing lock in a trigger cannot be hidden by timing luck: the second writer can only see the first one's
 * rows after its commit, which is exactly what the parent-row lock makes it wait for.
 */
async function raceDirect(
  tasks: Record<string, DirectTask>,
  holdMs = 40,
): Promise<Record<string, DirectOutcome>> {
  const labels = Object.keys(tasks);
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
  const running = labels.map(async (label, idx) => {
    try {
      await pool.begin(async (sql) => {
        await sql`select 1`;
        armed += 1;
        if (armed === labels.length) allArmed();
        await gates[idx]!.promise;
        if (SERVER_BARRIER)
          await sql`select pg_sleep_until(${serverStart}::text::timestamptz)`;
        await tasks[label]!(sql);
        await sql`select pg_sleep(${holdMs / 1000})`;
      });
      return [label, { ok: true } as DirectOutcome] as const;
    } catch (error) {
      return [
        label,
        { ok: false, code: (error as { code?: string }).code } as DirectOutcome,
      ] as const;
    }
  });
  await armedPromise;
  if (SERVER_BARRIER) serverStart = await serverInstantAhead(BARRIER_LEAD_MS);
  for (const gate of shuffled(gates)) gate.release();
  return Object.fromEntries(await Promise.all(running));
}

describe("K12-K13 direct SQL writers (the triggers alone must hold the invariants)", () => {
  const insertPayment = (expenseId: string, amount: number): DirectTask => {
    return (sql) =>
      sql`insert into expense_payments (tenant_id, expense_id, amount, method, paid_at, idempotency_key)
          values (${T()}, ${expenseId}, ${amount}, 'cash', now(), ${newKey()})`;
  };

  it(
    "K12 two direct payment inserts of 700 on a 1000 expense: exactly one commits, the other is FN005",
    async () => {
      await repeat("K12", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const out = await raceDirect({
          a: insertPayment(e.expenseId, 700),
          b: insertPayment(e.expenseId, 700),
        });
        expect(
          [out.a, out.b].filter((o) => o.ok),
          "exactly one insert commits",
        ).toHaveLength(1);
        const failed = [out.a, out.b].find((o) => !o.ok) as {
          ok: false;
          code: string | undefined;
        };
        expect(failed.code).toBe("FN005");
        expect(await postedTotal(e.expenseId)).toBe(700);
        const row = await expenseRow(e.expenseId);
        expect(row.status).toBe("partially_paid");
        expect(row.version).toBe(2);
        expect(row.settlement_events).toBe(1);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "K13 a direct payment insert against a direct cancel: exactly one wins, never cancelled with a posted payment",
    async () => {
      await repeat("K13", async () => {
        const e = await makeExpense(world, { amount: 1000 });
        const out = await raceDirect({
          payment: insertPayment(e.expenseId, 250),
          cancel: (sql) =>
            sql`update expenses set status = 'cancelled', cancelled_at = now(), cancel_reason = 'es zamanli'
                where id = ${e.expenseId}`,
        });
        expect([out.payment, out.cancel].filter((o) => o.ok)).toHaveLength(1);
        const loser = (out.payment!.ok ? out.cancel : out.payment) as {
          ok: false;
          code: string | undefined;
        };
        // payment after the cancel is FN008, cancel after the payment is FN011
        expect(loser.code).toBe(out.payment!.ok ? "FN011" : "FN008");
        await assertStateConsistent(e.expenseId);
        // no edits here, so the version is 1 plus one per settlement event plus one for the cancel
        const final = await expenseRow(e.expenseId);
        expect(final.version).toBe(
          1 + final.settlement_events + (final.status === "cancelled" ? 1 : 0),
        );
      });
    },
    TEST_TIMEOUT,
  );
});
