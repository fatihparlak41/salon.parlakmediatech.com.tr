import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createExpenseWorld,
  destroyExpenseWorld,
  createExpense,
  cancelExpense,
  recordPayment,
  voidPayment,
  makeExpense,
  makePayment,
  validCreate,
  expectOk,
  expenseRow,
  paymentRows,
  expenseAudit,
  counts,
  tenantDigest,
  expenseDigest,
  newKey,
  instantAgo,
  instantAhead,
  ip,
  type ExpenseWorld,
  type RpcOutcome,
  type RecordPaymentInput,
} from "./expense-fixtures";

/**
 * Faz FIN.1B.1 — expense payments (matrix groups Y and IP, and the payment half of A).
 *
 * NOTE for whoever runs this file next: it needs migration 20261003090000 applied to whatever TEST_DATABASE_URL points
 * at (a disposable PROD-derived branch or the local rig, never the shared DEV database) and fails loudly when it is not.
 */

let world: ExpenseWorld;
const PAST = "2026-10-02T09:15:30.123456Z";

beforeAll(async () => {
  world = await createExpenseWorld("fin1b1-pay");
});

afterAll(async () => {
  await destroyExpenseWorld(world);
});

const T = () => world.tenant.id;

function failure(out: RpcOutcome<unknown>): string | undefined {
  expect(out.ok, `expected a failure, got ${JSON.stringify(out)}`).toBe(false);
  return out.ok ? undefined : out.code;
}

const pay = (
  expenseId: string,
  o: Partial<RecordPaymentInput> = {},
): RecordPaymentInput => ({
  expenseId,
  amount: 10,
  method: "cash",
  paidAt: instantAgo(5),
  idempotencyKey: newKey(),
  ...o,
});

describe("Y payments", () => {
  it.each([["cash"], ["card"], ["bank_transfer"], ["other"]])(
    "Y1 method %s succeeds",
    async (method) => {
      const e = await makeExpense(world);
      expect(
        (await recordPayment(world.owner.id, pay(e.expenseId, { method }))).ok,
      ).toBe(true);
    },
  );

  it.each([["cheque"], [""], [null]])(
    "Y1 method %s is FN006",
    async (method) => {
      const e = await makeExpense(world);
      expect(
        failure(
          await recordPayment(world.owner.id, pay(e.expenseId, { method })),
        ),
      ).toBe("FN006");
    },
  );

  it("Y2 exact arithmetic: 33.37 + 33.37 + 33.36 pays 100.10 exactly, with no float drift", async () => {
    const e = await makeExpense(world, { amount: "100.10" });
    expect((await makePayment(world, e.expenseId, 33.37)).status).toBe(
      "partially_paid",
    );
    expect((await makePayment(world, e.expenseId, 33.37)).status).toBe(
      "partially_paid",
    );
    expect((await makePayment(world, e.expenseId, 33.36)).status).toBe("paid");
    const [sum] = await testDb<
      { s: string }[]
    >`select sum(amount)::text as s from expense_payments where expense_id = ${e.expenseId}`;
    expect(sum!.s).toBe("100.10");
  });

  it("Y3 overpayment: above the remaining amount is FN005, exactly the remaining amount succeeds, and a paid expense takes nothing more", async () => {
    const e = await makeExpense(world, { amount: 100 });
    await makePayment(world, e.expenseId, 60);
    expect(
      failure(
        await recordPayment(
          world.owner.id,
          pay(e.expenseId, { amount: 40.01 }),
        ),
      ),
    ).toBe("FN005");
    expect((await makePayment(world, e.expenseId, 40)).status).toBe("paid");
    expect(
      failure(
        await recordPayment(world.owner.id, pay(e.expenseId, { amount: 0.01 })),
      ),
    ).toBe("FN005");
  });

  it("Y3 voided payments do not count: void, then pay up to the amount again", async () => {
    const e = await makeExpense(world, { amount: 100 });
    const p = await makePayment(world, e.expenseId, 100);
    expect(
      failure(
        await recordPayment(world.owner.id, pay(e.expenseId, { amount: 1 })),
      ),
    ).toBe("FN005");
    await expectOk(await voidPayment(world.owner.id, p.paymentId!, "yanlis"));
    expect((await makePayment(world, e.expenseId, 100)).status).toBe("paid");
  });

  it.each([
    ["0"],
    ["-1"],
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["0.001"],
    ["1.005"],
    ["10000000000"],
    ["99999999999999.99"],
    [null],
  ])("Y4 amount %s is FN004, never a raw numeric overflow", async (amount) => {
    const e = await makeExpense(world, { amount: 100 });
    const before = await counts(T());
    expect(
      failure(
        await recordPayment(world.owner.id, pay(e.expenseId, { amount })),
      ),
    ).toBe("FN004");
    expect(await counts(T())).toEqual(before);
  });

  it("Y4 a payment key is required", async () => {
    const e = await makeExpense(world);
    expect(
      failure(
        await recordPayment(
          world.owner.id,
          pay(e.expenseId, { idempotencyKey: null }),
        ),
      ),
    ).toBe("FN004");
    expect(
      failure(
        await recordPayment(
          world.owner.id,
          pay(e.expenseId, { idempotencyKey: undefined }),
        ),
      ),
    ).toBe("FN004");
  });

  it("Y5 paid_at: null, before 2000-01-01 and beyond now + 1 hour are FN004; now + 59 minutes and a date before the expense date succeed", async () => {
    const e = await makeExpense(world, {
      expenseDate: "2026-10-10",
      amount: 1000,
    });
    for (const paidAt of [null, "1999-12-31T23:59:59Z", instantAhead(61)]) {
      expect(
        failure(
          await recordPayment(world.owner.id, pay(e.expenseId, { paidAt })),
        ),
      ).toBe("FN004");
    }
    expect(
      (
        await recordPayment(
          world.owner.id,
          pay(e.expenseId, { paidAt: instantAhead(59) }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await recordPayment(
          world.owner.id,
          pay(e.expenseId, { paidAt: "2026-10-02T09:00:00Z" }),
        )
      ).ok,
    ).toBe(true); // prepayment
  });

  it("Y5 a malformed timestamp is rejected at the PostgreSQL type boundary, before the function runs", async () => {
    const e = await makeExpense(world);
    const out = await recordPayment(
      world.owner.id,
      pay(e.expenseId, { paidAt: "yarin ogleden sonra" }),
    );
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.code).toMatch(/^22/);
  });

  it("Y6 note: 501 chars is FN004, 500 passes, blank is stored as null, values are trimmed", async () => {
    const e = await makeExpense(world, { amount: 1000 });
    expect(
      failure(
        await recordPayment(
          world.owner.id,
          pay(e.expenseId, { note: "x".repeat(501) }),
        ),
      ),
    ).toBe("FN004");
    await expectOk(
      await recordPayment(
        world.owner.id,
        pay(e.expenseId, { note: "x".repeat(500) }),
      ),
    );
    await expectOk(
      await recordPayment(world.owner.id, pay(e.expenseId, { note: "   " })),
    );
    await expectOk(
      await recordPayment(
        world.owner.id,
        pay(e.expenseId, { note: "  havale  " }),
      ),
    );
    const notes = (await paymentRows(e.expenseId)).map((r) => r.note);
    expect(notes.filter((n) => n === null)).toHaveLength(1);
    expect(notes).toContain("havale");
  });

  it("Y7 a payment on a cancelled expense is FN008", async () => {
    const e = await makeExpense(world);
    await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal"));
    expect(failure(await recordPayment(world.owner.id, pay(e.expenseId)))).toBe(
      "FN008",
    );
  });

  it("Y8 void: the row is retained, trimmed reason and voided_at set, status recalculated; a second void is a noop", async () => {
    const e = await makeExpense(world, { amount: 100 });
    const p1 = await makePayment(world, e.expenseId, 60);
    await makePayment(world, e.expenseId, 40);
    expect((await expenseRow(e.expenseId)).status).toBe("paid");
    const out = await expectOk(
      await voidPayment(world.owner.id, p1.paymentId!, "  yanlis tutar  "),
    );
    expect(out).toMatchObject({ status: "partially_paid", noop: false });
    const rows = await paymentRows(e.expenseId);
    expect(rows).toHaveLength(2);
    const voided = rows.find((r) => r.id === p1.paymentId)!;
    expect(voided).toMatchObject({
      status: "voided",
      void_reason: "yanlis tutar",
    });
    expect(voided.voided_at).toBeInstanceOf(Date);

    const digest = await tenantDigest(T());
    expect(
      await expectOk(await voidPayment(world.owner.id, p1.paymentId!, "")),
    ).toMatchObject({ noop: true });
    expect(await tenantDigest(T())).toBe(digest);
  });

  it("Y8 void reason: null, blank and 501 chars are FN004; an unknown payment is FN009; another tenant's owner is FN002", async () => {
    const e = await makeExpense(world);
    const p = await makePayment(world, e.expenseId, 10);
    for (const reason of [null, "", "   ", "x".repeat(501)]) {
      expect(
        failure(await voidPayment(world.owner.id, p.paymentId!, reason)),
      ).toBe("FN004");
    }
    expect(failure(await voidPayment(world.owner.id, newKey(), "yok"))).toBe(
      "FN009",
    );
    expect(
      failure(
        await voidPayment(world.otherOwner.id, p.paymentId!, "baska salon"),
      ),
    ).toBe("FN002");
    expect(
      failure(
        await voidPayment(world.viewOnly.id, p.paymentId!, "sadece goruntule"),
      ),
    ).toBe("FN002");
    expect((await paymentRows(e.expenseId))[0]!.status).toBe("posted");
  });

  it("Y9 the Owner sequence on 3500: pay 1500 and 2000 (paid), void 2000 (partial), pay 2000 (paid): 3 rows, one voided", async () => {
    const e = await makeExpense(world, { amount: 3500 });
    await makePayment(world, e.expenseId, 1500);
    const second = await makePayment(world, e.expenseId, 2000);
    expect(second.status).toBe("paid");
    expect(
      (
        await expectOk(
          await voidPayment(world.owner.id, second.paymentId!, "yanlis"),
        )
      ).status,
    ).toBe("partially_paid");
    expect((await makePayment(world, e.expenseId, 2000)).status).toBe("paid");
    const rows = await paymentRows(e.expenseId);
    expect(rows).toHaveLength(3);
    const sum = (status: string) =>
      rows
        .filter((r) => r.status === status)
        .reduce((acc, r) => acc + Number(r.amount), 0);
    expect(sum("posted")).toBe(3500);
    expect(sum("voided")).toBe(2000);
  });

  it("Y10 payments change nothing on the expense except status, settlement_events, version and updated_at", async () => {
    const e = await makeExpense(world, {
      amount: 500,
      branchId: world.branchId,
      vendorName: "V",
      dueDate: "2026-10-30",
      note: "N",
    });
    const strip = async () => {
      const [row] = await testDb<{ j: Record<string, unknown> }[]>`
        select to_jsonb(x) - 'status' - 'version' - 'updated_at' - 'settlement_events' as j from expenses x where id = ${e.expenseId}`;
      return row!.j;
    };
    const before = await strip();
    const p = await makePayment(world, e.expenseId, 100);
    await makePayment(world, e.expenseId, 50);
    await voidPayment(world.owner.id, p.paymentId!, "yanlis");
    expect(await strip()).toEqual(before);
  });

  it("Y11 an initial payment is equivalent to create followed by record_expense_payment", async () => {
    const note = "peşin";
    const a = await expectOk(
      await createExpense(
        world.owner.id,
        validCreate(world, {
          amount: 1000,
          initialPayment: ip(400, "card", PAST, note),
        }),
      ),
    );
    const b0 = await makeExpense(world, { amount: 1000 });
    const b = await expectOk(
      await recordPayment(world.owner.id, {
        expenseId: b0.expenseId,
        amount: 400,
        method: "card",
        paidAt: PAST,
        note,
        idempotencyKey: newKey(),
      }),
    );
    expect(a).toMatchObject({ status: "partially_paid", version: 2 });
    expect(b).toMatchObject({ status: "partially_paid", version: 2 });
    const [pa] = await paymentRows(a.expenseId);
    const [pb] = await paymentRows(b.expenseId);
    const shape = (p: typeof pa) => ({
      amount: p!.amount,
      method: p!.method,
      paid_at: p!.paid_at.toISOString(),
      note: p!.note,
      status: p!.status,
    });
    expect(shape(pa)).toEqual(shape(pb));
    expect((await expenseRow(a.expenseId)).settlement_events).toBe(
      (await expenseRow(b.expenseId)).settlement_events,
    );
  });

  it("Y12 voided payments are excluded from the posted total", async () => {
    const e = await makeExpense(world, { amount: 100 });
    const p = await makePayment(world, e.expenseId, 100);
    await expectOk(await voidPayment(world.owner.id, p.paymentId!, "yanlis"));
    await makePayment(world, e.expenseId, 100);
    const [posted] = await testDb<
      { s: string }[]
    >`select private.expense_posted_total(${e.expenseId})::text as s`;
    expect(posted!.s).toBe("100.00");
    expect((await expenseRow(e.expenseId)).status).toBe("paid");
  });

  it("Y13 a payment equal to the expense amount on an open expense makes it paid directly (version 2)", async () => {
    const e = await makeExpense(world, { amount: 750 });
    expect(await makePayment(world, e.expenseId, 750)).toMatchObject({
      status: "paid",
      version: 2,
    });
  });
});

describe("IP payment idempotency", () => {
  it("IP1 the same key and payload twice: one payment, the second call is a noop, one audit event, version unchanged", async () => {
    const e = await makeExpense(world, { amount: 500 });
    const input = pay(e.expenseId, {
      amount: 125,
      method: "bank_transfer",
      paidAt: PAST,
      note: "havale",
    });
    const first = await expectOk(await recordPayment(world.owner.id, input));
    const digest = await expenseDigest(e.expenseId);
    const audits = (
      await expenseAudit(
        T(),
        "finance.expense_payment_recorded",
        first.paymentId!,
      )
    ).length;
    const second = await expectOk(await recordPayment(world.owner.id, input));
    expect(second).toMatchObject({
      noop: true,
      paymentId: first.paymentId,
      version: first.version,
      status: first.status,
    });
    expect(await expenseDigest(e.expenseId)).toBe(digest);
    expect((await paymentRows(e.expenseId)).length).toBe(1);
    expect(audits).toBe(1);
    expect(
      (
        await expenseAudit(
          T(),
          "finance.expense_payment_recorded",
          first.paymentId!,
        )
      ).length,
    ).toBe(1);
  });

  // One component at a time, under the same key.
  const variants: [
    string,
    string,
    (otherExpenseId: string) => Partial<RecordPaymentInput>,
    Partial<RecordPaymentInput>,
  ][] = [
    ["IP2a", "the expense", (other) => ({ expenseId: other }), { note: "x" }],
    ["IP2b", "the amount", () => ({ amount: 101 }), { note: "x" }],
    ["IP2c", "the method", () => ({ method: "card" }), { note: "x" }],
    [
      "IP2d",
      "paid_at by +1 microsecond",
      () => ({ paidAt: "2026-10-02T09:15:30.123457Z" }),
      { note: "x" },
    ],
    [
      "IP2e",
      "the note: null to set",
      () => ({ note: "baska" }),
      { note: null },
    ],
  ];

  it.each(variants)(
    "%s vary only %s under the same key is FN007",
    async (_id, _name, change, baseNote) => {
      const e = await makeExpense(world, { amount: 1000 });
      const other = await makeExpense(world, { amount: 1000 });
      const key = newKey();
      const base = {
        expenseId: e.expenseId,
        amount: 100,
        method: "cash",
        paidAt: PAST,
        idempotencyKey: key,
        ...baseNote,
      };
      await expectOk(await recordPayment(world.owner.id, base));
      const before = await tenantDigest(T());
      expect(
        failure(
          await recordPayment(world.owner.id, {
            ...base,
            ...change(other.expenseId),
          }),
        ),
      ).toBe("FN007");
      expect(await tenantDigest(T())).toBe(before);
    },
  );

  it("IP3 normalization: padded and blank notes and the same instant in another offset are replays, not FN007", async () => {
    const e = await makeExpense(world, { amount: 1000 });
    const key = newKey();
    const base = {
      expenseId: e.expenseId,
      amount: 100,
      method: "cash",
      paidAt: "2026-10-02T10:00:00Z",
      note: "x",
      idempotencyKey: key,
    };
    await expectOk(await recordPayment(world.owner.id, base));
    expect(
      await recordPayment(world.owner.id, { ...base, note: "  x  " }),
    ).toMatchObject({ ok: true, data: { noop: true } });
    expect(
      await recordPayment(world.owner.id, {
        ...base,
        paidAt: "2026-10-02T13:00:00+03:00",
      }),
    ).toMatchObject({ ok: true, data: { noop: true } });
    expect(
      await recordPayment(world.owner.id, { ...base, amount: "100.00" }),
    ).toMatchObject({ ok: true, data: { noop: true } });

    const k2 = newKey();
    const blank = { ...base, idempotencyKey: k2, note: null };
    await expectOk(await recordPayment(world.owner.id, blank));
    expect(
      await recordPayment(world.owner.id, { ...blank, note: "" }),
    ).toMatchObject({ ok: true, data: { noop: true } });
    expect(
      await recordPayment(world.owner.id, { ...blank, note: "   " }),
    ).toMatchObject({ ok: true, data: { noop: true } });
  });

  it("IP4 a replay in a later state is still a noop: after a void, after the expense became paid, after it was cancelled", async () => {
    // after a void
    const a = await makeExpense(world, { amount: 100 });
    const aKey = newKey();
    const aPay = {
      expenseId: a.expenseId,
      amount: 100,
      method: "cash",
      paidAt: PAST,
      idempotencyKey: aKey,
    };
    const aFirst = await expectOk(await recordPayment(world.owner.id, aPay));
    // the expense is now fully paid: a replay must not be refused as an overpayment
    expect(
      await expectOk(await recordPayment(world.owner.id, aPay)),
    ).toMatchObject({ noop: true, paymentId: aFirst.paymentId });
    await expectOk(
      await voidPayment(world.owner.id, aFirst.paymentId!, "yanlis"),
    );
    const afterVoid = await expectOk(await recordPayment(world.owner.id, aPay));
    expect(afterVoid).toMatchObject({
      noop: true,
      paymentId: aFirst.paymentId,
    });
    expect(await paymentRows(a.expenseId)).toHaveLength(1);
    expect((await paymentRows(a.expenseId))[0]!.status).toBe("voided");

    // after the expense was cancelled (possible once every payment is voided)
    await expectOk(await cancelExpense(world.owner.id, a.expenseId, "iptal"));
    expect(
      await expectOk(await recordPayment(world.owner.id, aPay)),
    ).toMatchObject({ noop: true, paymentId: aFirst.paymentId });
    expect(await paymentRows(a.expenseId)).toHaveLength(1);
  });

  it("IP5 a null key is FN004", async () => {
    const e = await makeExpense(world);
    expect(
      failure(
        await recordPayment(
          world.owner.id,
          pay(e.expenseId, { idempotencyKey: null }),
        ),
      ),
    ).toBe("FN004");
  });

  it("IP6 the key is tenant-scoped: the same uuid in another tenant creates its own payment", async () => {
    const key = newKey();
    const mine = await makeExpense(world, { amount: 100 });
    const theirs = await expectOk(
      await createExpense(world.otherOwner.id, {
        ...validCreate(world, { amount: 100 }),
        tenantId: world.otherTenant.id,
      }),
    );
    const a = await expectOk(
      await recordPayment(
        world.owner.id,
        pay(mine.expenseId, { idempotencyKey: key }),
      ),
    );
    const b = await expectOk(
      await recordPayment(
        world.otherOwner.id,
        pay(theirs.expenseId, { idempotencyKey: key }),
      ),
    );
    expect(a.paymentId).not.toBe(b.paymentId);
    expect(b.noop).toBe(false);
  });
});

describe("A audit (payment events)", () => {
  it("A5 a payment writes one event, a void writes one event with the exact shape; repeats and replays write none", async () => {
    const e = await makeExpense(world, { amount: 200 });
    const input = pay(e.expenseId, {
      amount: 80,
      method: "card",
      paidAt: PAST,
      note: "kart",
    });
    const p = await expectOk(await recordPayment(world.owner.id, input));
    await expectOk(await recordPayment(world.owner.id, input)); // replay
    const recorded = await expenseAudit(
      T(),
      "finance.expense_payment_recorded",
      p.paymentId!,
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      entity_type: "expense_payment",
      before: null,
      actor_user_id: world.owner.id,
    });
    expect(Object.keys(recorded[0]!.after!).sort()).toEqual([
      "amount",
      "expense_id",
      "method",
      "paid_at",
    ]);
    expect(JSON.stringify(recorded[0])).not.toContain('kart"');

    await expectOk(
      await voidPayment(world.owner.id, p.paymentId!, "yanlis kart"),
    );
    await expectOk(
      await voidPayment(world.owner.id, p.paymentId!, "yanlis kart"),
    ); // repeat
    const voided = await expenseAudit(
      T(),
      "finance.expense_payment_voided",
      p.paymentId!,
    );
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({
      entity_type: "expense_payment",
      before: { status: "posted" },
      after: {
        status: "voided",
        reason: "yanlis kart",
        expense_id: e.expenseId,
      },
    });
  });
});
