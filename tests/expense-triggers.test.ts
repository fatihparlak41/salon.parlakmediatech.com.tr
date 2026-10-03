import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createExpenseWorld,
  destroyExpenseWorld,
  makeExpense,
  cancelExpense,
  expectOk,
  expenseRow,
  newKey,
  uniqueText,
  type ExpenseWorld,
} from "./expense-fixtures";

/**
 * Faz FIN.1B.1 — trigger invariants (matrix group TR). Every statement here goes straight to the tables through the
 * privileged test connection, exactly as a future trusted code path (a 1B.2 materializer, a data-fix migration, an
 * operator's SQL) would: the triggers, not the RPCs, are what must hold the line.
 */

let world: ExpenseWorld;

beforeAll(async () => {
  world = await createExpenseWorld("fin1b1-tr");
});

afterAll(async () => {
  await destroyExpenseWorld(world);
});

/** Direct INSERT of an expense (no RPC): a new obligation with the column defaults. */
async function insertExpense(
  o: {
    amount?: number;
    dueDate?: string | null;
    branchId?: string | null;
    category?: string;
  } = {},
): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into expenses (tenant_id, branch_id, category_key, description, expense_date, due_date, amount, currency, created_by)
    values (${world.tenant.id}, ${o.branchId ?? null}, ${o.category ?? "supplies"}, ${uniqueText("TR gideri")}, date '2026-10-01',
            ${o.dueDate ?? null}, ${o.amount ?? 1000}, 'TRY', ${world.owner.id})
    returning id`;
  return row!.id;
}

/** Direct INSERT of a posted payment (no RPC). */
async function insertPayment(
  expenseId: string,
  amount: number,
): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into expense_payments (tenant_id, expense_id, amount, method, idempotency_key, created_by)
    values (${world.tenant.id}, ${expenseId}, ${amount}, 'cash', ${newKey()}, ${world.owner.id})
    returning id`;
  return row!.id;
}

async function voidDirect(paymentId: string): Promise<void> {
  await testDb`update expense_payments set status = 'voided', voided_at = now(), voided_by = ${world.owner.id}, void_reason = 'test' where id = ${paymentId}`;
}

const failsWith = (p: PromiseLike<unknown>, code: string) =>
  expect(Promise.resolve(p)).rejects.toMatchObject({ code });

describe("TR1 T1.1 a new obligation starts open, version 1, no settlement events", () => {
  it.each([
    ["status", "status = 'paid'"],
    ["version", "version = 2"],
    ["settlement_events", "settlement_events = 3"],
  ])(
    "a direct INSERT with a non-default %s gives FN012",
    async (_name, assignment) => {
      const base = { tenant: world.tenant.id, user: world.owner.id };
      const column = assignment.split(" ")[0]!;
      const value = assignment.split("= ")[1]!;
      const sqlText = `insert into expenses (tenant_id, category_key, description, expense_date, amount, currency, created_by, ${column})
                     values ('${base.tenant}', 'supplies', 'TR1 ${column}', date '2026-10-01', 100, 'TRY', '${base.user}', ${value})`;
      await failsWith(testDb.unsafe(sqlText), "FN012");
    },
  );
});

describe("TR2 T1.2 default-deny column immutability", () => {
  it.each([
    ["tenant_id", () => `tenant_id = '${world.otherTenant.id}'`],
    ["currency", () => `currency = 'USD'`],
    ["idempotency_key", () => `idempotency_key = '${newKey()}'`],
    [
      "idempotency_fingerprint",
      () => `idempotency_fingerprint = 'ffffffffffffffffffffffffffffffff'`,
    ],
    ["created_by", () => `created_by = '${world.manager.id}'`],
    ["created_at", () => `created_at = now() - interval '1 day'`],
    ["id", () => `id = '${newKey()}'`],
  ])(
    "changing %s gives FN012, even with no payments",
    async (_name, assignment) => {
      const e = await makeExpense(world);
      const before = await expenseRow(e.expenseId);
      await failsWith(
        testDb.unsafe(
          `update expenses set ${assignment()} where id = '${e.expenseId}'`,
        ),
        "FN012",
      );
      expect(await expenseRow(e.expenseId)).toEqual(before);
    },
  );
});

describe("TR3 T1.6 structure lock after a posted payment", () => {
  const structureEdits: [string, () => string][] = [
    ["expense_date", () => `expense_date = date '2026-10-02'`],
    ["branch_id", () => `branch_id = '${world.branchId}'`],
    ["category_key", () => `category_key = 'rent'`],
  ];

  it.each(structureEdits)(
    "with posted > 0, changing %s gives FN012",
    async (_name, assignment) => {
      const id = await insertExpense();
      await insertPayment(id, 100);
      const before = await expenseRow(id);
      await failsWith(
        testDb.unsafe(`update expenses set ${assignment()} where id = '${id}'`),
        "FN012",
      );
      expect(await expenseRow(id)).toEqual(before);
    },
  );

  it.each(structureEdits)(
    "with posted = 0, changing %s succeeds",
    async (_name, assignment) => {
      const id = await insertExpense();
      await testDb.unsafe(
        `update expenses set ${assignment()} where id = '${id}'`,
      );
      const after = await expenseRow(id);
      expect(after.version).toBe(2);
    },
  );

  it("after every payment is voided the structure fields are editable again", async () => {
    const id = await insertExpense();
    const p = await insertPayment(id, 100);
    await voidDirect(p);
    await testDb`update expenses set category_key = 'rent' where id = ${id}`;
    expect((await expenseRow(id)).category_key).toBe("rent");
  });
});

describe("TR4 T1.7 amount floor", () => {
  it("amount below the posted total gives FN012", async () => {
    const id = await insertExpense({ amount: 1000 });
    await insertPayment(id, 600);
    await failsWith(
      testDb`update expenses set amount = 500, status = 'paid' where id = ${id}`,
      "FN012",
    );
    await failsWith(
      testDb`update expenses set amount = 599.99, status = 'paid' where id = ${id}`,
      "FN012",
    );
  });

  it("amount equal to the posted total succeeds and the status becomes paid", async () => {
    const id = await insertExpense({ amount: 1000 });
    await insertPayment(id, 600);
    await testDb`update expenses set amount = 600, status = 'paid' where id = ${id}`;
    expect((await expenseRow(id)).status).toBe("paid");
  });

  it("amount above the posted total succeeds", async () => {
    const id = await insertExpense({ amount: 1000 });
    await insertPayment(id, 600);
    await testDb`update expenses set amount = 800 where id = ${id}`;
    expect((await expenseRow(id)).amount).toBe("800.00");
  });
});

describe("TR5 T1.4 cancelled is terminal", () => {
  it("any tracked-column change on a cancelled row gives FN008; a change-nothing UPDATE is accepted and does not bump the version", async () => {
    const e = await makeExpense(world);
    await expectOk(
      await cancelExpense(world.owner.id, e.expenseId, "test iptali"),
    );
    const cancelled = await expenseRow(e.expenseId);
    expect(cancelled.status).toBe("cancelled");

    await failsWith(
      testDb`update expenses set description = 'tekrar' where id = ${e.expenseId}`,
      "FN008",
    );
    await failsWith(
      testDb`update expenses set amount = 5 where id = ${e.expenseId}`,
      "FN008",
    );
    await failsWith(
      testDb`update expenses set status = 'open', cancelled_at = null, cancelled_by = null, cancel_reason = null where id = ${e.expenseId}`,
      "FN008",
    );
    expect(await expenseRow(e.expenseId)).toEqual(cancelled);

    await testDb`update expenses set description = description where id = ${e.expenseId}`;
    expect(await expenseRow(e.expenseId)).toEqual(cancelled);
  });
});

describe("TR6 T1.5 cancel needs a zero posted total", () => {
  const cancelSql = (id: string) =>
    testDb`update expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = ${world.owner.id}, cancel_reason = 'x' where id = ${id}`;

  it("entering cancelled with posted > 0 gives FN011", async () => {
    const id = await insertExpense();
    await insertPayment(id, 100);
    await failsWith(cancelSql(id), "FN011");
    expect((await expenseRow(id)).status).toBe("partially_paid");
  });

  it("with posted = 0 (including only voided history) it succeeds", async () => {
    const id = await insertExpense();
    const p = await insertPayment(id, 100);
    await voidDirect(p);
    await cancelSql(id);
    expect((await expenseRow(id)).status).toBe("cancelled");
  });
});

describe("TR7 T1.8 status is derived", () => {
  it("a status that is not the derived one gives FN012, in both directions", async () => {
    const id = await insertExpense();
    await failsWith(
      testDb`update expenses set status = 'paid' where id = ${id}`,
      "FN012",
    );
    await failsWith(
      testDb`update expenses set status = 'partially_paid' where id = ${id}`,
      "FN012",
    );
    await insertPayment(id, 100);
    await failsWith(
      testDb`update expenses set status = 'open', description = 'x' where id = ${id}`,
      "FN012",
    );
    await failsWith(
      testDb`update expenses set status = 'paid', description = 'x' where id = ${id}`,
      "FN012",
    );
  });
});

describe("TR8 T1.3 / T1.10 version and updated_at are trigger-managed", () => {
  it("an UPDATE that sets version gives FN012", async () => {
    const id = await insertExpense();
    await failsWith(
      testDb`update expenses set version = 5 where id = ${id}`,
      "FN012",
    );
    await failsWith(
      testDb`update expenses set version = version + 1, description = 'x' where id = ${id}`,
      "FN012",
    );
    expect((await expenseRow(id)).version).toBe(1);
  });

  it("a tracked-column change bumps version by exactly 1 and sets updated_at", async () => {
    const id = await insertExpense();
    const before = await expenseRow(id);
    await testDb`update expenses set description = 'degisti' where id = ${id}`;
    const after = await expenseRow(id);
    expect(after.version).toBe(before.version + 1);
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.updated_at.getTime(),
    );
  });

  it("several tracked columns in one UPDATE still bump exactly once", async () => {
    const id = await insertExpense();
    await testDb`update expenses set description = 'a', note = 'b', amount = 1500, due_date = date '2026-12-01' where id = ${id}`;
    expect((await expenseRow(id)).version).toBe(2);
  });

  it("an UPDATE that changes no tracked column leaves version and updated_at untouched", async () => {
    const id = await insertExpense();
    const before = await expenseRow(id);
    await testDb`update expenses set description = description, amount = amount where id = ${id}`;
    expect(await expenseRow(id)).toEqual(before);
  });
});

describe("TR9 T2.1 / T2.2 payment insert invariants", () => {
  it("an overpaying INSERT gives FN005; an exact fit succeeds", async () => {
    const id = await insertExpense({ amount: 100 });
    await insertPayment(id, 60);
    await failsWith(insertPayment(id, 40.01), "FN005");
    await insertPayment(id, 40);
    expect((await expenseRow(id)).status).toBe("paid");
    await failsWith(insertPayment(id, 0.01), "FN005");
  });

  it("an INSERT on a cancelled expense gives FN008", async () => {
    const e = await makeExpense(world);
    await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal"));
    await failsWith(insertPayment(e.expenseId, 10), "FN008");
  });

  it("the INSERT holds the parent row lock: a concurrent expense UPDATE waits", async () => {
    const id = await insertExpense({ amount: 100 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const insertedPromise = new Promise<void>(
      (resolve) => (inserted = resolve),
    );

    const holder = testDb.begin(async (tx) => {
      await tx`insert into expense_payments (tenant_id, expense_id, amount, method, idempotency_key)
               values (${world.tenant.id}, ${id}, 10, 'cash', ${newKey()})`;
      inserted();
      await gate;
    });
    await insertedPromise;

    const waiter = testDb.begin(async (tx) => {
      await tx`set local lock_timeout = '400ms'`;
      await tx`update expenses set description = 'bekliyor' where id = ${id}`;
    });
    await expect(waiter).rejects.toMatchObject({ code: "55P03" });
    release();
    await holder;
  });
});

describe("TR10 T2.3 / T2.4 payment rows are append-only", () => {
  const editable: [string, () => string][] = [
    ["amount", () => `amount = 1`],
    ["method", () => `method = 'card'`],
    ["paid_at", () => `paid_at = now() - interval '1 day'`],
    ["note", () => `note = 'degisti'`],
    ["expense_id", () => `expense_id = '${otherExpenseId}'`],
    ["tenant_id", () => `tenant_id = '${world.otherTenant.id}'`],
    ["idempotency_key", () => `idempotency_key = '${newKey()}'`],
    ["created_by", () => `created_by = '${world.manager.id}'`],
    ["created_at", () => `created_at = now() - interval '1 day'`],
  ];
  let otherExpenseId: string;

  beforeAll(async () => {
    otherExpenseId = await insertExpense();
  });

  it.each(editable)("changing %s gives FN012", async (_name, assignment) => {
    const id = await insertExpense();
    const paymentId = await insertPayment(id, 10);
    await failsWith(
      testDb.unsafe(
        `update expense_payments set ${assignment()} where id = '${paymentId}'`,
      ),
      "FN012",
    );
  });

  it("voided -> posted gives FN012; changing the void fields of a voided row gives FN012", async () => {
    const id = await insertExpense();
    const paymentId = await insertPayment(id, 10);
    await voidDirect(paymentId);
    await failsWith(
      testDb`update expense_payments set status = 'posted', voided_at = null, voided_by = null, void_reason = null where id = ${paymentId}`,
      "FN012",
    );
    await failsWith(
      testDb`update expense_payments set void_reason = 'baska' where id = ${paymentId}`,
      "FN012",
    );
    await failsWith(
      testDb`update expense_payments set voided_at = now() - interval '1 day' where id = ${paymentId}`,
      "FN012",
    );
  });

  it("posted -> voided with the void fields succeeds", async () => {
    const id = await insertExpense();
    const paymentId = await insertPayment(id, 10);
    await voidDirect(paymentId);
    const [row] = await testDb<
      { status: string }[]
    >`select status from expense_payments where id = ${paymentId}`;
    expect(row!.status).toBe("voided");
  });
});

describe("TR11 T3 refreshes the derived aggregate once per real settlement event", () => {
  it("a payment insert and a void each refresh status and settlement_events in one UPDATE (version +1 each)", async () => {
    const id = await insertExpense({ amount: 100 });
    expect(await expenseRow(id)).toMatchObject({
      status: "open",
      version: 1,
      settlement_events: 0,
    });
    const p1 = await insertPayment(id, 40);
    expect(await expenseRow(id)).toMatchObject({
      status: "partially_paid",
      version: 2,
      settlement_events: 1,
    });
    await insertPayment(id, 10);
    expect(await expenseRow(id)).toMatchObject({
      status: "partially_paid",
      version: 3,
      settlement_events: 2,
    });
    await voidDirect(p1);
    expect(await expenseRow(id)).toMatchObject({
      status: "partially_paid",
      version: 4,
      settlement_events: 4 - 1,
    });
  });

  it("an UPDATE OF status that leaves the status unchanged is not a settlement event", async () => {
    const id = await insertExpense({ amount: 100 });
    const p = await insertPayment(id, 40);
    const before = await expenseRow(id);
    await testDb`update expense_payments set status = status where id = ${p}`;
    expect(await expenseRow(id)).toEqual(before);
  });

  it("a cancelled parent is never touched", async () => {
    const e = await makeExpense(world);
    await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal"));
    const before = await expenseRow(e.expenseId);
    await testDb`insert into expense_payments (tenant_id, expense_id, amount, method, status, idempotency_key, voided_at, void_reason)
                 values (${world.tenant.id}, ${e.expenseId}, 5, 'cash', 'voided', ${newKey()}, now(), 'tarihce')`;
    expect(await expenseRow(e.expenseId)).toEqual(before);
  });
});

describe("TR12 input shape belongs to CHECK constraints and the RPCs, not to the triggers", () => {
  it("a 201-char description, a zero amount and a bad method fail with 23514, not an FN code", async () => {
    const id = await insertExpense();
    await failsWith(
      testDb`insert into expenses (tenant_id, category_key, description, expense_date, amount, currency)
             values (${world.tenant.id}, 'supplies', ${"x".repeat(201)}, date '2026-10-01', 10, 'TRY')`,
      "23514",
    );
    await failsWith(
      testDb`insert into expenses (tenant_id, category_key, description, expense_date, amount, currency)
             values (${world.tenant.id}, 'supplies', 'sifir', date '2026-10-01', 0, 'TRY')`,
      "23514",
    );
    await failsWith(
      testDb`insert into expense_payments (tenant_id, expense_id, amount, method, idempotency_key)
             values (${world.tenant.id}, ${id}, 10, 'cheque', ${newKey()})`,
      "23514",
    );
  });
});

describe("TR13 settlement_events is derived from the payment rows", () => {
  it("a writer that sets a wrong settlement_events gives FN012; the derived value is accepted", async () => {
    const id = await insertExpense({ amount: 100 });
    await insertPayment(id, 10);
    await failsWith(
      testDb`update expenses set description = 'x', settlement_events = 7 where id = ${id}`,
      "FN012",
    );
    await testDb`update expenses set description = 'x', settlement_events = 1 where id = ${id}`;
    expect((await expenseRow(id)).description).toBe("x");
  });
});
