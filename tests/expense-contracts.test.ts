import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXPENSE_CATEGORY_ITEM_KEYS,
  EXPENSE_CURSOR_KEYS,
  EXPENSE_DETAIL_KEYS,
  EXPENSE_LIST_ITEM_KEYS,
  EXPENSE_LIST_PAGE_KEYS,
  EXPENSE_OVERVIEW_CURRENCY_KEYS,
  EXPENSE_OVERVIEW_KEYS,
  EXPENSE_PAYMENT_KEYS,
  EXPENSE_WRITE_RESULT_KEYS,
} from "@/lib/modules/expenses/types";
import {
  cancelExpense,
  createExpense,
  createExpenseWorld,
  destroyExpenseWorld,
  expectOk,
  getExpense,
  getOverview,
  instantAgo,
  ip,
  listCategories,
  listExpenses,
  makeExpense,
  makePayment,
  newKey,
  recordPayment,
  updateExpense,
  validCreate,
  voidPayment,
  type ExpenseWorld,
} from "./expense-fixtures";

/**
 * Faz FIN.1B.1 — contract tests (matrix CT1-CT3): the key sets in lib/modules/expenses/types.ts equal what the live RPCs
 * return, so a column quietly added to (or dropped from) a curated read model fails here instead of leaking to the browser or
 * breaking the UI. Needs migration 20261003090000 on TEST_DATABASE_URL (a disposable branch or the local rig), like every
 * expense DB test.
 */

let world: ExpenseWorld;

beforeAll(async () => {
  world = await createExpenseWorld("fin1b1-ct");
});

afterAll(async () => {
  await destroyExpenseWorld(world);
});

const sorted = (value: object) => Object.keys(value).sort();

describe("CT1 the detail shape", () => {
  it("get_expense returns exactly EXPENSE_DETAIL_KEYS, its payments exactly EXPENSE_PAYMENT_KEYS", async () => {
    const e = await makeExpense(world, {
      amount: 500,
      dueDate: "2026-10-30",
      vendorName: "V",
      note: "N",
    });
    const first = await makePayment(world, e.expenseId, 100, { note: "ilk" });
    await makePayment(world, e.expenseId, 50);
    await expectOk(
      await voidPayment(world.owner.id, first.paymentId!, "yanlış"),
    );
    const detail = await expectOk(
      await getExpense(world.owner.id, e.expenseId, "2026-09-15"),
    );
    expect(sorted(detail)).toEqual([...EXPENSE_DETAIL_KEYS]);
    expect(detail.payments).toHaveLength(2);
    for (const p of detail.payments)
      expect(sorted(p)).toEqual([...EXPENSE_PAYMENT_KEYS]);
    expect(detail.payments.map((p) => p.status).sort()).toEqual([
      "posted",
      "voided",
    ]);
  });

  it("the detail values have the types the TypeScript model promises", async () => {
    const e = await makeExpense(world, {
      amount: 250.5,
      dueDate: "2026-10-30",
    });
    await makePayment(world, e.expenseId, 100.25);
    const d = await expectOk(
      await getExpense(world.owner.id, e.expenseId, "2026-09-15"),
    );
    expect(typeof d.id).toBe("string");
    expect(typeof d.amount).toBe("number");
    expect(typeof d.paid).toBe("number");
    expect(typeof d.outstanding).toBe("number");
    expect(typeof d.amountFloor).toBe("number");
    expect(typeof d.version).toBe("number");
    expect(typeof d.isOverdue).toBe("boolean");
    expect(typeof d.structureLocked).toBe("boolean");
    expect(typeof d.canCancel).toBe("boolean");
    expect(d.daysOverdue).toBeNull();
    expect(d.branchId).toBeNull();
    expect(d.branchName).toBeNull();
    expect(d.vendorName).toBeNull();
    expect(d.note).toBeNull();
    expect(d.cancelledAt).toBeNull();
    expect(d.cancelReason).toBeNull();
    expect(typeof d.expenseDate).toBe("string");
    expect(typeof d.createdAt).toBe("string");
    expect(typeof (d.payments[0] as { amount: unknown }).amount).toBe("number");
    expect(typeof (d.payments[0] as { paidAt: unknown }).paidAt).toBe("string");
    expect(d.amount).toBe(250.5);
    expect(d.amountFloor).toBe(100.25);
    expect(d.outstanding).toBe(150.25);
  });
});

describe("CT2 the list, overview and category shapes", () => {
  it("list_expense_categories items are exactly EXPENSE_CATEGORY_ITEM_KEYS", async () => {
    const list = await expectOk(
      await listCategories(world.owner.id, world.tenant.id),
    );
    expect(list.length).toBeGreaterThan(0);
    for (const c of list)
      expect(sorted(c)).toEqual([...EXPENSE_CATEGORY_ITEM_KEYS]);
  });

  it("list_expenses returns exactly EXPENSE_LIST_PAGE_KEYS, items EXPENSE_LIST_ITEM_KEYS, a cursor EXPENSE_CURSOR_KEYS", async () => {
    const branchId = world.branch2Id;
    for (let n = 0; n < 3; n++)
      await makeExpense(world, { branchId, amount: 10 + n });
    const page = await expectOk(
      await listExpenses(world.owner.id, {
        tenantId: world.tenant.id,
        branchId,
        limit: 2,
      }),
    );
    expect(sorted(page)).toEqual([...EXPENSE_LIST_PAGE_KEYS]);
    expect(page.items).toHaveLength(2);
    for (const item of page.items)
      expect(sorted(item)).toEqual([...EXPENSE_LIST_ITEM_KEYS]);
    expect(page.nextCursor).not.toBeNull();
    expect(sorted(page.nextCursor!)).toEqual([...EXPENSE_CURSOR_KEYS]);
    const last = await expectOk(
      await listExpenses(world.owner.id, {
        tenantId: world.tenant.id,
        branchId,
        limit: 2,
        cursorDate: page.nextCursor!.expenseDate,
        cursorId: page.nextCursor!.id,
      }),
    );
    expect(last.nextCursor).toBeNull();
    expect(sorted(last)).toEqual([...EXPENSE_LIST_PAGE_KEYS]);
  });

  it("get_expense_overview returns exactly the overview keys, per-currency keys and the nested amount objects", async () => {
    const branchId = world.branchId;
    await makeExpense(world, {
      branchId,
      amount: 100,
      dueDate: "2026-10-30",
      expenseDate: "2026-10-01",
    });
    const overview = await expectOk(
      await getOverview(world.owner.id, world.tenant.id, {
        month: "2026-10-01",
        branchId,
        referenceDate: "2026-10-03",
      }),
    );
    expect(sorted(overview)).toEqual([...EXPENSE_OVERVIEW_KEYS]);
    expect(overview.byCurrency.length).toBeGreaterThan(0);
    for (const c of overview.byCurrency) {
      expect(sorted(c)).toEqual([...EXPENSE_OVERVIEW_CURRENCY_KEYS]);
      expect(sorted(c.outstanding)).toEqual(["count", "total"]);
      expect(sorted(c.overdue)).toEqual(["count", "total"]);
      expect(sorted(c.upcoming)).toEqual(["count", "total", "withinDays"]);
      expect(typeof c.incurred).toBe("number");
      expect(typeof c.paid).toBe("number");
      expect(typeof c.outstanding.count).toBe("number");
      expect(c.upcoming.withinDays).toBe(14);
    }
    expect(typeof overview.month).toBe("string");
    expect(typeof overview.referenceDate).toBe("string");
    expect(typeof overview.primaryCurrency).toBe("string");
  });
});

describe("CT3 the write results", () => {
  it("create_expense returns exactly {expenseId, noop, paymentId, status, version}, with and without an initial payment, fresh and replayed", async () => {
    const key = newKey();
    const input = validCreate(world, { idempotencyKey: key });
    const fresh = await expectOk(await createExpense(world.owner.id, input));
    expect(sorted(fresh)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.create]);
    expect(fresh.paymentId).toBeNull();
    const replay = await expectOk(await createExpense(world.owner.id, input));
    expect(sorted(replay)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.create]);
    expect(replay.noop).toBe(true);

    const withPayment = await expectOk(
      await createExpense(
        world.owner.id,
        validCreate(world, { initialPayment: ip(100, "cash", instantAgo(5)) }),
      ),
    );
    expect(sorted(withPayment)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.create]);
    expect(typeof withPayment.paymentId).toBe("string");
  });

  it("update_expense and cancel_expense return exactly {expenseId, noop, status, version}, real and noop", async () => {
    const e = await makeExpense(world, { amount: 100 });
    const row = {
      expenseId: e.expenseId,
      categoryKey: "supplies",
      description: "Yeni açıklama",
      expenseDate: "2026-10-01",
      amount: 100,
      expectedVersion: 1,
    };
    const real = await expectOk(await updateExpense(world.owner.id, row));
    expect(sorted(real)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.update]);
    expect(real.noop).toBe(false);
    const noop = await expectOk(
      await updateExpense(world.owner.id, {
        ...row,
        expectedVersion: real.version,
      }),
    );
    expect(sorted(noop)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.update]);
    expect(noop.noop).toBe(true);

    const cancelled = await expectOk(
      await cancelExpense(world.owner.id, e.expenseId, "iptal"),
    );
    expect(sorted(cancelled)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.cancel]);
    const again = await expectOk(
      await cancelExpense(world.owner.id, e.expenseId, "iptal"),
    );
    expect(sorted(again)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.cancel]);
    expect(again.noop).toBe(true);
  });

  it("record_expense_payment and void_expense_payment return exactly {expenseId, noop, paymentId, status, version}, real and noop", async () => {
    const e = await makeExpense(world, { amount: 100 });
    const key = newKey();
    const paidAt = instantAgo(5);
    const paid = await expectOk(
      await recordPayment(world.owner.id, {
        expenseId: e.expenseId,
        amount: 40,
        method: "cash",
        paidAt,
        idempotencyKey: key,
      }),
    );
    expect(sorted(paid)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.recordPayment]);
    const replay = await expectOk(
      await recordPayment(world.owner.id, {
        expenseId: e.expenseId,
        amount: 40,
        method: "cash",
        paidAt,
        idempotencyKey: key,
      }),
    );
    expect(sorted(replay)).toEqual([
      ...EXPENSE_WRITE_RESULT_KEYS.recordPayment,
    ]);
    expect(replay.noop).toBe(true);

    const voided = await expectOk(
      await voidPayment(world.owner.id, paid.paymentId!, "hatalı"),
    );
    expect(sorted(voided)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.voidPayment]);
    const again = await expectOk(
      await voidPayment(world.owner.id, paid.paymentId!, "hatalı"),
    );
    expect(sorted(again)).toEqual([...EXPENSE_WRITE_RESULT_KEYS.voidPayment]);
    expect(again.noop).toBe(true);
  });
});
