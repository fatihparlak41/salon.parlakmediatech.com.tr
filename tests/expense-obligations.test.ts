import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createExpenseWorld,
  destroyExpenseWorld,
  createExpense,
  updateExpense,
  cancelExpense,
  recordPayment,
  voidPayment,
  getExpense,
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
  tenantToday,
  newKey,
  instantAgo,
  instantAhead,
  uniqueText,
  ip,
  type ExpenseWorld,
  type ExpenseRow,
  type CreateExpenseInput,
  type UpdateExpenseInput,
  type RpcOutcome,
} from "./expense-fixtures";

/**
 * Faz FIN.1B.1 — expense obligations (matrix groups V, I, L, VR, C and the obligation half of A).
 *
 * NOTE for whoever runs this file next: it needs migration 20261003090000 applied to whatever TEST_DATABASE_URL points
 * at (a disposable PROD-derived branch or the local rig, never the shared DEV database) and fails loudly when it is not.
 */

let world: ExpenseWorld;
const PAST = "2026-10-02T09:15:30.123456Z"; // a fixed past instant, microsecond precision

beforeAll(async () => {
  world = await createExpenseWorld("fin1b1-obl");
});

afterAll(async () => {
  await destroyExpenseWorld(world);
});

const T = () => world.tenant.id;

function failure(out: RpcOutcome<unknown>): string | undefined {
  expect(out.ok, `expected a failure, got ${JSON.stringify(out)}`).toBe(false);
  return out.ok ? undefined : out.code;
}

/** The current state of a row as a full-state update payload (what the edit form submits). */
function stateOf(
  row: ExpenseRow,
  overrides: Partial<UpdateExpenseInput> = {},
): UpdateExpenseInput {
  return {
    expenseId: row.id,
    categoryKey: row.category_key,
    description: row.description,
    expenseDate: row.expense_date,
    amount: row.amount,
    expectedVersion: row.version,
    branchId: row.branch_id,
    vendorName: row.vendor_name,
    dueDate: row.due_date,
    note: row.note,
    ...overrides,
  };
}

// =================================================================================================================
// V — create_expense validation
// =================================================================================================================
describe("V create_expense validation", () => {
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
  ])("V1 amount %s is FN004 with zero rows", async (amount) => {
    const before = await counts(T());
    expect(
      failure(
        await createExpense(world.owner.id, validCreate(world, { amount })),
      ),
    ).toBe("FN004");
    expect(await counts(T())).toEqual(before);
  });

  it.each([
    ["0.01", "0.01"],
    ["250.5", "250.50"],
    ["250.50", "250.50"],
    ["250.500", "250.50"],
    ["9999999999.99", "9999999999.99"],
  ])("V1 amount %s is accepted and stored as %s", async (amount, stored) => {
    const e = await makeExpense(world, { amount });
    expect((await expenseRow(e.expenseId)).amount).toBe(stored);
  });

  it("V2 description: null, empty, spaces, tab/newline only and 201 chars are FN004; 200 chars passes; stored trimmed", async () => {
    for (const description of [null, "", "   ", "\t\n", "x".repeat(201)]) {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            validCreate(world, { description }),
          ),
        ),
      ).toBe("FN004");
    }
    const ok = await makeExpense(world, { description: "x".repeat(200) });
    expect((await expenseRow(ok.expenseId)).description).toHaveLength(200);
    const trimmed = await makeExpense(world, { description: "  Kira  " });
    expect((await expenseRow(trimmed.expenseId)).description).toBe("Kira");
  });

  it("V3 vendor: 201 chars is FN004; blank is stored as null; values are trimmed", async () => {
    expect(
      failure(
        await createExpense(
          world.owner.id,
          validCreate(world, { vendorName: "x".repeat(201) }),
        ),
      ),
    ).toBe("FN004");
    for (const blank of ["", "   "]) {
      const e = await makeExpense(world, { vendorName: blank });
      expect((await expenseRow(e.expenseId)).vendor_name).toBeNull();
    }
    const e = await makeExpense(world, { vendorName: "  Mülk Sahibi " });
    expect((await expenseRow(e.expenseId)).vendor_name).toBe("Mülk Sahibi");
  });

  it("V4 note: 501 chars is FN004; 500 passes; blank is stored as null", async () => {
    expect(
      failure(
        await createExpense(
          world.owner.id,
          validCreate(world, { note: "x".repeat(501) }),
        ),
      ),
    ).toBe("FN004");
    const ok = await makeExpense(world, { note: "x".repeat(500) });
    expect((await expenseRow(ok.expenseId)).note).toHaveLength(500);
    const blank = await makeExpense(world, { note: "  " });
    expect((await expenseRow(blank.expenseId)).note).toBeNull();
  });

  it("V5 category: null, empty, unknown, uppercase and padded keys are FN004; all 16 seeded keys pass", async () => {
    for (const categoryKey of [null, "", "unknown_key", "RENT", " rent"]) {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            validCreate(world, { categoryKey }),
          ),
        ),
      ).toBe("FN004");
    }
    const keys = [
      "rent",
      "electricity",
      "water",
      "internet",
      "phone",
      "accountant",
      "software",
      "pos_fees",
      "supplies",
      "beauty_products",
      "cleaning",
      "advertising",
      "food",
      "transport",
      "repairs",
      "other",
    ];
    for (const categoryKey of keys) {
      const e = await makeExpense(world, { categoryKey });
      expect((await expenseRow(e.expenseId)).category_key).toBe(categoryKey);
    }
  });

  it("V6 expense date: null, 1999-12-31, 2101-01-01 and tenant-today + 367 are FN004; 2000-01-01 and tenant-today + 366 pass", async () => {
    const plus366 = await tenantToday(T(), 366);
    const plus367 = await tenantToday(T(), 367);
    for (const expenseDate of [null, "1999-12-31", "2101-01-01", plus367]) {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            validCreate(world, { expenseDate }),
          ),
        ),
      ).toBe("FN004");
    }
    for (const expenseDate of ["2000-01-01", plus366]) {
      await makeExpense(world, { expenseDate });
    }
  });

  it("V7 due date: before the expense date or 2101-01-01 is FN004; equal, later and null pass", async () => {
    for (const dueDate of ["2026-09-30", "2101-01-01"]) {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            validCreate(world, { expenseDate: "2026-10-01", dueDate }),
          ),
        ),
      ).toBe("FN004");
    }
    for (const dueDate of ["2026-10-01", "2026-12-01", null]) {
      await makeExpense(world, { expenseDate: "2026-10-01", dueDate });
    }
  });

  it("V8 branch: a random uuid, another tenant's branch and a soft-deleted branch are FN004; null (Genel) and an own branch pass", async () => {
    for (const branchId of [
      newKey(),
      world.otherBranchId,
      world.deletedBranchId,
    ]) {
      expect(
        failure(
          await createExpense(world.owner.id, validCreate(world, { branchId })),
        ),
      ).toBe("FN004");
    }
    const genel = await makeExpense(world, { branchId: null });
    expect((await expenseRow(genel.expenseId)).branch_id).toBeNull();
    const own = await makeExpense(world, { branchId: world.branchId });
    expect((await expenseRow(own.expenseId)).branch_id).toBe(world.branchId);
  });

  it("V9 the idempotency key is required: null and omitted are FN004 with zero rows", async () => {
    const before = await counts(T());
    expect(
      failure(
        await createExpense(
          world.owner.id,
          validCreate(world, { idempotencyKey: null }),
        ),
      ),
    ).toBe("FN004");
    expect(
      failure(
        await createExpense(
          world.owner.id,
          validCreate(world, { idempotencyKey: undefined }),
        ),
      ),
    ).toBe("FN004");
    expect(await counts(T())).toEqual(before);
  });

  it("V10 a null tenant is FN004", async () => {
    expect(
      failure(
        await createExpense(
          world.owner.id,
          validCreate(world, { tenantId: null }),
        ),
      ),
    ).toBe("FN004");
  });

  describe("V11 initial payment shape and fields", () => {
    const base = (initialPayment: CreateExpenseInput["initialPayment"]) =>
      validCreate(world, { amount: 1000, initialPayment });
    const goodIp = () => ip(100, "cash", PAST);

    it.each([
      ["a scalar", 5 as unknown],
      ["a string", "abc" as unknown],
      ["an array", [1, 2] as unknown],
    ])("%s is FN004", async (_name, value) => {
      expect(
        failure(await createExpense(world.owner.id, base(value as never))),
      ).toBe("FN004");
    });

    it("an unknown field is FN004", async () => {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            base({ ...goodIp(), extra: 1 } as never),
          ),
        ),
      ).toBe("FN004");
    });

    it.each(["amount", "method", "paid_at"])(
      "a missing %s is FN004",
      async (field) => {
        const payload: Record<string, unknown> = { ...goodIp() };
        delete payload[field];
        expect(
          failure(await createExpense(world.owner.id, base(payload as never))),
        ).toBe("FN004");
      },
    );

    it.each([
      ["0"],
      ["-1"],
      ["0.001"],
      ["10000000000"],
      ["abc"],
      ["1e3"],
      ["-5"],
      ["NaN"],
      [0],
      [-1],
      [0.001],
      [10000000000],
    ])("an initial amount of %s is FN004", async (amount) => {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            base({ ...goodIp(), amount } as never),
          ),
        ),
      ).toBe("FN004");
    });

    it.each([["cheque"], [null], [5 as unknown as string]])(
      "an initial method of %s is FN006",
      async (method) => {
        expect(
          failure(
            await createExpense(
              world.owner.id,
              base({ ...goodIp(), method } as never),
            ),
          ),
        ).toBe("FN006");
      },
    );

    it.each([
      [null],
      ["yesterday"],
      ["2026-10-02T09:00:00"],
      [5 as unknown as string],
    ])("an initial paid_at of %s is FN004", async (paid_at) => {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            base({ ...goodIp(), paid_at } as never),
          ),
        ),
      ).toBe("FN004");
    });

    it("an initial paid_at beyond now + 1 hour is FN004; now + 59 minutes passes", async () => {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            base(ip(100, "cash", instantAhead(61))),
          ),
        ),
      ).toBe("FN004");
      await expectOk(
        await createExpense(
          world.owner.id,
          base(ip(100, "cash", instantAhead(59))),
        ),
      );
    });

    it("an initial note over 500 chars is FN004", async () => {
      expect(
        failure(
          await createExpense(
            world.owner.id,
            base(ip(100, "cash", PAST, "x".repeat(501))),
          ),
        ),
      ).toBe("FN004");
    });

    it("an initial amount above the expense amount is FN005; equal gives paid; less gives partially_paid", async () => {
      expect(
        failure(
          await createExpense(world.owner.id, base(ip(1000.01, "cash", PAST))),
        ),
      ).toBe("FN005");
      const paid = await expectOk(
        await createExpense(world.owner.id, base(ip(1000, "cash", PAST))),
      );
      expect(paid.status).toBe("paid");
      const partial = await expectOk(
        await createExpense(world.owner.id, base(ip(400, "cash", PAST))),
      );
      expect(partial.status).toBe("partially_paid");
    });

    it("the initial amount may be a JSON number or a plain decimal string", async () => {
      const a = await expectOk(
        await createExpense(world.owner.id, base(ip(250.5, "cash", PAST))),
      );
      const b = await expectOk(
        await createExpense(world.owner.id, base(ip("250.5", "cash", PAST))),
      );
      expect((await paymentRows(a.expenseId))[0]!.amount).toBe("250.50");
      expect((await paymentRows(b.expenseId))[0]!.amount).toBe("250.50");
    });
  });

  describe("V12 create with an initial payment is atomic", () => {
    const failuresThatMustLeaveNothing: [
      string,
      () => CreateExpenseInput,
      string,
    ][] = [
      [
        "a bad amount",
        () => validCreate(world, { initialPayment: ip("abc", "cash", PAST) }),
        "FN004",
      ],
      [
        "a bad method",
        () => validCreate(world, { initialPayment: ip(10, "cheque", PAST) }),
        "FN006",
      ],
      [
        "a future paid_at",
        () =>
          validCreate(world, {
            initialPayment: ip(10, "cash", instantAhead(120)),
          }),
        "FN004",
      ],
      [
        "a long note",
        () =>
          validCreate(world, {
            initialPayment: ip(10, "cash", PAST, "x".repeat(501)),
          }),
        "FN004",
      ],
      [
        "an initial amount above the expense amount",
        () =>
          validCreate(world, {
            amount: 100,
            initialPayment: ip(100.01, "cash", PAST),
          }),
        "FN005",
      ],
    ];

    it.each(failuresThatMustLeaveNothing)(
      "%s leaves 0 expense rows, 0 payment rows, 0 audit rows",
      async (_name, make, code) => {
        const before = await counts(T());
        expect(failure(await createExpense(world.owner.id, make()))).toBe(code);
        expect(await counts(T())).toEqual(before);
      },
    );

    it("a payment-key collision with another expense's payment is FN007 and leaves nothing", async () => {
      const other = await makeExpense(world, { amount: 500 });
      const key = newKey();
      await makePayment(world, other.expenseId, 10, { idempotencyKey: key });
      const before = await counts(T());
      expect(
        failure(
          await createExpense(
            world.owner.id,
            validCreate(world, {
              idempotencyKey: key,
              initialPayment: ip(10, "cash", PAST),
            }),
          ),
        ),
      ).toBe("FN007");
      expect(await counts(T())).toEqual(before);
    });

    it("a failure inside the payment insert, after the expense row exists, rolls the expense back too", async () => {
      await testDb.unsafe(`
        create function public.zz_force_fail() returns trigger language plpgsql as $$ begin raise exception 'forced failure' using errcode = 'P0001'; end; $$;
        create trigger aa_zz_force_fail before insert on public.expense_payments for each row execute function public.zz_force_fail();
      `);
      try {
        const before = await counts(T());
        const out = await createExpense(
          world.owner.id,
          validCreate(world, { initialPayment: ip(10, "cash", PAST) }),
        );
        expect(failure(out)).toBe("P0001");
        expect(await counts(T())).toEqual(before);
      } finally {
        await testDb.unsafe(
          `drop trigger if exists aa_zz_force_fail on public.expense_payments; drop function if exists public.zz_force_fail();`,
        );
      }
    });
  });

  it("V13 stored values: tenant currency, derived status, version, creator, and the stored fingerprint", async () => {
    const plain = await makeExpense(world, {
      branchId: world.branchId,
      vendorName: "V",
      dueDate: "2026-10-20",
      note: "N",
      amount: 1000,
    });
    const row = await expenseRow(plain.expenseId);
    expect(row).toMatchObject({
      currency: "TRY",
      status: "open",
      version: 1,
      settlement_events: 0,
      created_by: world.owner.id,
    });
    expect(plain).toMatchObject({
      status: "open",
      version: 1,
      noop: false,
      paymentId: null,
    });
    const [fp] = await testDb<{ f: string }[]>`
      select private.expense_create_fingerprint(${row.branch_id}::uuid, ${row.category_key}, ${row.expense_date}::date, ${row.due_date}::date,
        ${row.amount}::numeric, ${row.description}, ${row.vendor_name}, ${row.note}, null::numeric, null, null::timestamptz, null) as f`;
    expect(row.idempotency_fingerprint).toBe(fp!.f);
    expect(row.idempotency_fingerprint).toMatch(/^[0-9a-f]{32}$/);

    const withIp = await makeExpense(world, {
      amount: 1000,
      initialPayment: ip(400, "cash", PAST, "peşin"),
    });
    expect(withIp).toMatchObject({
      status: "partially_paid",
      version: 2,
      noop: false,
    });
    expect(withIp.paymentId).toBeTruthy();
    const paid = await makeExpense(world, {
      amount: 1000,
      initialPayment: ip(1000, "card", PAST),
    });
    expect(paid).toMatchObject({ status: "paid", version: 2 });
  });

  it("V14 currency is a snapshot of the tenant currency at creation", async () => {
    const old = await makeExpense(world);
    await testDb`update tenants set currency = 'EUR' where id = ${T()}`;
    try {
      const fresh = await makeExpense(world);
      expect((await expenseRow(fresh.expenseId)).currency).toBe("EUR");
      expect((await expenseRow(old.expenseId)).currency).toBe("TRY");
      const edited = await expectOk(
        await updateExpense(
          world.owner.id,
          stateOf(await expenseRow(old.expenseId), { description: "yeni" }),
        ),
      );
      expect(edited.noop).toBe(false);
      expect((await expenseRow(old.expenseId)).currency).toBe("TRY");
    } finally {
      await testDb`update tenants set currency = 'TRY' where id = ${T()}`;
    }
  });
});

// =================================================================================================================
// I — create idempotency
// =================================================================================================================
describe("I create idempotency", () => {
  it("I1 the same key and payload twice: one expense, same ids, the second call is a noop, one audit pair", async () => {
    const input = validCreate(world, {
      amount: 1000,
      initialPayment: ip(400, "cash", PAST, "peşin"),
    });
    const first = await expectOk(await createExpense(world.owner.id, input));
    const afterFirst = await counts(T());
    const second = await expectOk(await createExpense(world.owner.id, input));
    expect(second).toMatchObject({
      expenseId: first.expenseId,
      paymentId: first.paymentId,
      noop: true,
      version: first.version,
      status: first.status,
    });
    expect(await counts(T())).toEqual(afterFirst);
    expect(
      (await expenseAudit(T(), "finance.expense_created", first.expenseId))
        .length,
    ).toBe(1);
    expect(
      (
        await expenseAudit(
          T(),
          "finance.expense_payment_recorded",
          first.paymentId!,
        )
      ).length,
    ).toBe(1);
    expect((await paymentRows(first.expenseId)).length).toBe(1);

    const plain = validCreate(world);
    const a = await expectOk(await createExpense(world.owner.id, plain));
    const b = await expectOk(await createExpense(world.owner.id, plain));
    expect(b).toMatchObject({
      expenseId: a.expenseId,
      noop: true,
      version: 1,
      paymentId: null,
    });
  });

  // Faz 2F.1's lesson: a test must prove the comparison is COMPLETE, not only that the compared fields compare. One
  // sub-case per canonical component, varying exactly one thing under the same key.
  const A = (): Partial<CreateExpenseInput> => ({
    categoryKey: "supplies",
    description: "Sabit gider tanimi",
    expenseDate: "2026-10-01",
    amount: 1000,
    branchId: world.branchId,
    vendorName: "Tedarikçi",
    dueDate: "2026-10-20",
    note: "gider notu",
    initialPayment: ip(400, "cash", PAST, "ilk ödeme notu"),
  });
  const B = (): Partial<CreateExpenseInput> => ({
    categoryKey: "supplies",
    description: "Sabit gider tanimi",
    expenseDate: "2026-10-01",
    amount: 1000,
    branchId: null,
    vendorName: null,
    dueDate: null,
    note: null,
    initialPayment: null,
  });
  const variants: [
    string,
    string,
    () => Partial<CreateExpenseInput>,
    () => Partial<CreateExpenseInput>,
  ][] = [
    [
      "I2a",
      "branch: null to set",
      B,
      () => ({ ...B(), branchId: world.branchId }),
    ],
    [
      "I2b",
      "branch: set to another",
      A,
      () => ({ ...A(), branchId: world.branch2Id }),
    ],
    ["I2c", "category", A, () => ({ ...A(), categoryKey: "rent" })],
    ["I2d", "expense date", A, () => ({ ...A(), expenseDate: "2026-10-02" })],
    [
      "I2e",
      "due date: null to set",
      B,
      () => ({ ...B(), dueDate: "2026-10-20" }),
    ],
    [
      "I2f",
      "due date: set to another",
      A,
      () => ({ ...A(), dueDate: "2026-10-21" }),
    ],
    ["I2g", "amount", A, () => ({ ...A(), amount: 1000.01 })],
    [
      "I2h",
      "description",
      A,
      () => ({ ...A(), description: "Sabit gider tanimi!" }),
    ],
    [
      "I2i",
      "vendor: null to set",
      B,
      () => ({ ...B(), vendorName: "Tedarikçi" }),
    ],
    [
      "I2j",
      "vendor: set to another",
      A,
      () => ({ ...A(), vendorName: "Başka tedarikçi" }),
    ],
    ["I2k", "note: null to set", B, () => ({ ...B(), note: "gider notu" })],
    ["I2l", "note: set to another", A, () => ({ ...A(), note: "baska not" })],
    [
      "I2m",
      "initial payment: absent to present",
      B,
      () => ({ ...B(), initialPayment: ip(400, "cash", PAST) }),
    ],
    [
      "I2n",
      "initial amount",
      A,
      () => ({
        ...A(),
        initialPayment: ip(401, "cash", PAST, "ilk ödeme notu"),
      }),
    ],
    [
      "I2o",
      "initial method",
      A,
      () => ({
        ...A(),
        initialPayment: ip(400, "card", PAST, "ilk ödeme notu"),
      }),
    ],
    [
      "I2p",
      "initial paid_at by +1 microsecond",
      A,
      () => ({
        ...A(),
        initialPayment: ip(
          400,
          "cash",
          "2026-10-02T09:15:30.123457Z",
          "ilk ödeme notu",
        ),
      }),
    ],
    [
      "I2q",
      "initial note: null to set",
      () => ({ ...A(), initialPayment: ip(400, "cash", PAST, null) }),
      () => ({
        ...A(),
        initialPayment: ip(400, "cash", PAST, "ilk ödeme notu"),
      }),
    ],
    [
      "I2r",
      "initial note: set to another",
      A,
      () => ({
        ...A(),
        initialPayment: ip(400, "cash", PAST, "baska ilk ödeme notu"),
      }),
    ],
  ];

  it("has one sub-case for each of the 12 payload components (18 variants)", () => {
    expect(variants).toHaveLength(18);
  });

  it.each(variants)(
    "%s vary only the %s under the same key is FN007 with rows unchanged",
    async (_id, _name, makeBase, makeChanged) => {
      const key = newKey();
      const first = await expectOk(
        await createExpense(
          world.owner.id,
          validCreate(world, { ...makeBase(), idempotencyKey: key }),
        ),
      );
      const before = await tenantDigest(T());
      const second = await createExpense(
        world.owner.id,
        validCreate(world, { ...makeChanged(), idempotencyKey: key }),
      );
      expect(failure(second)).toBe("FN007");
      expect(await tenantDigest(T())).toBe(before);
      expect((await expenseRow(first.expenseId)).version).toBe(first.version);
    },
  );

  it("I3 normalization equivalence: the same request written differently is a replay, not FN007", async () => {
    const key = newKey();
    const base = validCreate(world, {
      idempotencyKey: key,
      description: "X",
      vendorName: null,
      note: null,
      amount: "250.5",
      initialPayment: ip(100, "cash", "2026-10-02T10:00:00Z", null),
    });
    const first = await expectOk(await createExpense(world.owner.id, base));
    const equivalents: Partial<CreateExpenseInput>[] = [
      { description: "  X  " },
      { vendorName: "" },
      { vendorName: "   " },
      { note: "" },
      { note: "  " },
      { amount: "250.50" },
      { amount: "250.500" },
      { initialPayment: ip(100, "cash", "2026-10-02T10:00:00Z", "") },
      { initialPayment: ip(100, "cash", "2026-10-02T10:00:00Z", "   ") },
      {
        initialPayment: ip("100.00", "cash", "2026-10-02T13:00:00+03:00", null),
      },
    ];
    for (const change of equivalents) {
      const replay = await createExpense(world.owner.id, {
        ...base,
        ...change,
      });
      expect(replay, JSON.stringify(change)).toMatchObject({
        ok: true,
        data: { expenseId: first.expenseId, noop: true },
      });
    }
  });

  it("I4 replay after an edit returns the existing expense and never FN007; the row keeps its edited values", async () => {
    const input = validCreate(world, {
      amount: 1000,
      description: "ilk tanim",
    });
    const first = await expectOk(await createExpense(world.owner.id, input));
    const edited = await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(first.expenseId), {
          amount: 1200,
          description: "degisen tanim",
        }),
      ),
    );
    const replay = await expectOk(await createExpense(world.owner.id, input));
    expect(replay).toMatchObject({
      expenseId: first.expenseId,
      noop: true,
      version: edited.version,
    });
    const row = await expenseRow(first.expenseId);
    expect(row).toMatchObject({
      amount: "1200.00",
      description: "degisen tanim",
    });
  });

  it("I5 replay after payments, a full payment or a cancel is a noop with no new row, payment or audit", async () => {
    for (const scenario of ["partial", "full", "cancelled"] as const) {
      const input = validCreate(world, { amount: 500 });
      const first = await expectOk(await createExpense(world.owner.id, input));
      if (scenario === "partial")
        await makePayment(world, first.expenseId, 100);
      if (scenario === "full") await makePayment(world, first.expenseId, 500);
      if (scenario === "cancelled")
        await expectOk(
          await cancelExpense(world.owner.id, first.expenseId, "iptal"),
        );
      const before = await tenantDigest(T());
      const replay = await expectOk(await createExpense(world.owner.id, input));
      expect(replay).toMatchObject({ expenseId: first.expenseId, noop: true });
      expect(await tenantDigest(T())).toBe(before);
    }
  });

  it("I6 the key is tenant-scoped; a second finance.manage user of the same tenant replaying an identical payload gets a noop", async () => {
    const key = newKey();
    const mine = await expectOk(
      await createExpense(
        world.owner.id,
        validCreate(world, { idempotencyKey: key }),
      ),
    );
    const theirs = await expectOk(
      await createExpense(world.otherOwner.id, {
        ...validCreate(world, { idempotencyKey: key }),
        tenantId: world.otherTenant.id,
      }),
    );
    expect(theirs.expenseId).not.toBe(mine.expenseId);
    expect(theirs.noop).toBe(false);

    const payload = validCreate(world);
    const first = await expectOk(await createExpense(world.owner.id, payload));
    const replayByColleague = await expectOk(
      await createExpense(world.accountant.id, payload),
    );
    expect(replayByColleague).toMatchObject({
      expenseId: first.expenseId,
      noop: true,
    });
  });

  it("I7 a replay without finance.manage is FN002", async () => {
    const payload = validCreate(world);
    await expectOk(await createExpense(world.owner.id, payload));
    expect(failure(await createExpense(world.viewOnly.id, payload))).toBe(
      "FN002",
    );
  });

  it("I8 the same uuid may be used as a create key and as a later payment key (different namespaces)", async () => {
    const key = newKey();
    const e = await expectOk(
      await createExpense(
        world.owner.id,
        validCreate(world, { idempotencyKey: key, amount: 500 }),
      ),
    );
    const paid = await recordPayment(world.owner.id, {
      expenseId: e.expenseId,
      amount: 100,
      method: "cash",
      paidAt: instantAgo(5),
      idempotencyKey: key,
    });
    expect(paid).toMatchObject({ ok: true, data: { noop: false } });
  });

  it("I9 the stored fingerprint is frozen: edits, payments and a cancel never change it", async () => {
    const e = await expectOk(
      await createExpense(world.owner.id, validCreate(world, { amount: 1000 })),
    );
    const original = (await expenseRow(e.expenseId)).idempotency_fingerprint;
    await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(e.expenseId), {
          amount: 1500,
          description: "yeni",
        }),
      ),
    );
    await makePayment(world, e.expenseId, 100);
    expect((await expenseRow(e.expenseId)).idempotency_fingerprint).toBe(
      original,
    );
    const c = await expectOk(
      await createExpense(world.owner.id, validCreate(world)),
    );
    const originalC = (await expenseRow(c.expenseId)).idempotency_fingerprint;
    await expectOk(await cancelExpense(world.owner.id, c.expenseId, "iptal"));
    expect((await expenseRow(c.expenseId)).idempotency_fingerprint).toBe(
      originalC,
    );
  });

  it("I10 the initial payment reuses the create key: the same key and payload on record_expense_payment is a noop returning it; a different payload is FN007", async () => {
    const key = newKey();
    const e = await expectOk(
      await createExpense(
        world.owner.id,
        validCreate(world, {
          idempotencyKey: key,
          amount: 1000,
          initialPayment: ip(400, "cash", PAST, "peşin"),
        }),
      ),
    );
    const same = await expectOk(
      await recordPayment(world.owner.id, {
        expenseId: e.expenseId,
        amount: 400,
        method: "cash",
        paidAt: PAST,
        note: "peşin",
        idempotencyKey: key,
      }),
    );
    expect(same).toMatchObject({
      noop: true,
      paymentId: e.paymentId,
      expenseId: e.expenseId,
    });
    expect(
      failure(
        await recordPayment(world.owner.id, {
          expenseId: e.expenseId,
          amount: 401,
          method: "cash",
          paidAt: PAST,
          note: "peşin",
          idempotencyKey: key,
        }),
      ),
    ).toBe("FN007");
  });
});

// =================================================================================================================
// L — lifecycle and mutability
// =================================================================================================================
describe("L lifecycle and mutability", () => {
  const baseline: Partial<CreateExpenseInput> = {
    categoryKey: "supplies",
    description: "Yaşam döngüsü",
    expenseDate: "2026-10-01",
    amount: 1000,
  };

  describe("L1 unpaid: every editable field is editable", () => {
    const cases: [
      string,
      () => Partial<CreateExpenseInput>,
      () => Partial<UpdateExpenseInput>,
    ][] = [
      ["expense_date", () => ({}), () => ({ expenseDate: "2026-10-05" })],
      ["branch: to a branch", () => ({}), () => ({ branchId: world.branchId })],
      [
        "branch: to null",
        () => ({ branchId: world.branchId }),
        () => ({ branchId: null }),
      ],
      ["category", () => ({}), () => ({ categoryKey: "rent" })],
      ["amount up", () => ({}), () => ({ amount: 1500 })],
      ["amount down", () => ({}), () => ({ amount: 250.5 })],
      ["due_date: set", () => ({}), () => ({ dueDate: "2026-11-01" })],
      [
        "due_date: clear",
        () => ({ dueDate: "2026-11-01" }),
        () => ({ dueDate: null }),
      ],
      ["description", () => ({}), () => ({ description: "yeni tanim" })],
      ["vendor: set", () => ({}), () => ({ vendorName: "Yeni Tedarikçi" })],
      [
        "vendor: clear",
        () => ({ vendorName: "Eski" }),
        () => ({ vendorName: null }),
      ],
      ["note: set", () => ({}), () => ({ note: "yeni not" })],
      ["note: clear", () => ({ note: "eski not" }), () => ({ note: null })],
    ];

    it.each(cases)("%s", async (_name, initial, change) => {
      const e = await makeExpense(world, { ...baseline, ...initial() });
      const row = await expenseRow(e.expenseId);
      const out = await expectOk(
        await updateExpense(world.owner.id, stateOf(row, change())),
      );
      expect(out).toMatchObject({ noop: false, status: "open", version: 2 });
      expect(
        (await expenseAudit(T(), "finance.expense_updated", e.expenseId))
          .length,
      ).toBe(1);
    });
  });

  it("L2 after every payment is voided, the structure fields are editable again", async () => {
    const e = await makeExpense(world, baseline);
    const p = await makePayment(world, e.expenseId, 300);
    await expectOk(await voidPayment(world.owner.id, p.paymentId!, "yanlis"));
    const row = await expenseRow(e.expenseId);
    const out = await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(row, {
          categoryKey: "rent",
          branchId: world.branchId,
          expenseDate: "2026-10-09",
        }),
      ),
    );
    expect(out.status).toBe("open");
    expect(await expenseRow(e.expenseId)).toMatchObject({
      category_key: "rent",
      branch_id: world.branchId,
      expense_date: "2026-10-09",
    });
  });

  describe("L3 partially paid: the structure fields are locked", () => {
    it.each([
      ["expense date", () => ({ expenseDate: "2026-10-09" })],
      ["branch", () => ({ branchId: world.branchId })],
      ["category", () => ({ categoryKey: "rent" })],
    ] as [string, () => Partial<UpdateExpenseInput>][])(
      "changing the %s is FN012, the row is byte-identical, 0 audit, version unchanged",
      async (_name, change) => {
        const e = await makeExpense(world, baseline);
        await makePayment(world, e.expenseId, 300);
        const row = await expenseRow(e.expenseId);
        const digest = await expenseDigest(e.expenseId);
        const auditBefore = (await expenseAudit(T(), "finance.expense_updated"))
          .length;
        expect(
          failure(await updateExpense(world.owner.id, stateOf(row, change()))),
        ).toBe("FN012");
        expect(await expenseDigest(e.expenseId)).toBe(digest);
        expect(
          (await expenseAudit(T(), "finance.expense_updated")).length,
        ).toBe(auditBefore);
      },
    );
  });

  it("L4 partially paid: other edits work; the amount rises, meets the posted total (paid) or falls below it (FN012)", async () => {
    const e = await makeExpense(world, baseline);
    await makePayment(world, e.expenseId, 300);
    let row = await expenseRow(e.expenseId);
    for (const change of [
      { dueDate: "2026-11-02" },
      { description: "degisti" },
      { vendorName: "Yeni" },
      { note: "yeni not" },
    ]) {
      const out = await expectOk(
        await updateExpense(world.owner.id, stateOf(row, change)),
      );
      expect(out.noop).toBe(false);
      row = await expenseRow(e.expenseId);
    }
    expect(
      (
        await expectOk(
          await updateExpense(world.owner.id, stateOf(row, { amount: 1200 })),
        )
      ).status,
    ).toBe("partially_paid");
    row = await expenseRow(e.expenseId);
    expect(
      failure(
        await updateExpense(world.owner.id, stateOf(row, { amount: 299.99 })),
      ),
    ).toBe("FN012");
    expect(
      (
        await expectOk(
          await updateExpense(world.owner.id, stateOf(row, { amount: 300 })),
        )
      ).status,
    ).toBe("paid");
  });

  it("L5 paid: structure locked; amount equal is a noop; above reopens to partially_paid; below is FN012; the soft fields stay editable", async () => {
    const e = await makeExpense(world, baseline);
    await makePayment(world, e.expenseId, 1000);
    let row = await expenseRow(e.expenseId);
    expect(row.status).toBe("paid");
    for (const change of [
      { expenseDate: "2026-10-09" },
      { branchId: world.branchId },
      { categoryKey: "rent" },
    ]) {
      expect(
        failure(await updateExpense(world.owner.id, stateOf(row, change))),
      ).toBe("FN012");
    }
    expect(
      await expectOk(
        await updateExpense(world.owner.id, stateOf(row, { amount: 1000 })),
      ),
    ).toMatchObject({ noop: true, status: "paid" });
    expect(
      failure(
        await updateExpense(world.owner.id, stateOf(row, { amount: 999.99 })),
      ),
    ).toBe("FN012");
    for (const change of [
      { dueDate: "2026-11-02" },
      { description: "odendi" },
      { vendorName: "Y" },
      { note: "n" },
    ]) {
      row = await expenseRow(e.expenseId);
      expect(
        (
          await expectOk(
            await updateExpense(world.owner.id, stateOf(row, change)),
          )
        ).status,
      ).toBe("paid");
    }
    row = await expenseRow(e.expenseId);
    expect(
      (
        await expectOk(
          await updateExpense(world.owner.id, stateOf(row, { amount: 1100 })),
        )
      ).status,
    ).toBe("partially_paid");
  });

  it("L6 a full-state submit with the locked fields at their current values (branch null to null) is accepted", async () => {
    const e = await makeExpense(world, { ...baseline, branchId: null });
    await makePayment(world, e.expenseId, 200);
    const row = await expenseRow(e.expenseId);
    expect(row.branch_id).toBeNull();
    const out = await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(row, { description: "aynı yapı, yeni tanım" }),
      ),
    );
    expect(out.noop).toBe(false);
  });

  it("L7 nothing changed with the current version: noop, no UPDATE, version and updated_at untouched, 0 audit", async () => {
    const e = await makeExpense(world, baseline);
    const row = await expenseRow(e.expenseId);
    const digest = await expenseDigest(e.expenseId);
    const auditBefore = (await expenseAudit(T())).length;
    const out = await expectOk(
      await updateExpense(world.owner.id, stateOf(row)),
    );
    expect(out).toMatchObject({
      noop: true,
      version: row.version,
      status: row.status,
    });
    expect(await expenseDigest(e.expenseId)).toBe(digest);
    expect((await expenseAudit(T())).length).toBe(auditBefore);
  });

  it("L8 a cancelled expense: a changing edit is FN008, an identical-state edit is a noop", async () => {
    const e = await makeExpense(world, baseline);
    await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal"));
    const row = await expenseRow(e.expenseId);
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(row, { description: "tekrar" }),
        ),
      ),
    ).toBe("FN008");
    expect(
      failure(await updateExpense(world.owner.id, stateOf(row, { amount: 5 }))),
    ).toBe("FN008");
    expect(
      await expectOk(await updateExpense(world.owner.id, stateOf(row))),
    ).toMatchObject({ noop: true, status: "cancelled" });
  });

  it("L9 expected version: null is FN004; stale is FN013 with zero changes; reusing a spent version is FN013; any payment makes a fetched version stale", async () => {
    const e = await makeExpense(world, baseline);
    const row = await expenseRow(e.expenseId);
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(row, { expectedVersion: null }),
        ),
      ),
    ).toBe("FN004");
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(row, { expectedVersion: undefined }),
        ),
      ),
    ).toBe("FN004");
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(row, { expectedVersion: 99, description: "x" }),
        ),
      ),
    ).toBe("FN013");

    await expectOk(
      await updateExpense(world.owner.id, stateOf(row, { description: "bir" })),
    );
    const digest = await expenseDigest(e.expenseId);
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(row, { description: "iki" }),
        ),
      ),
    ).toBe("FN013");
    expect(await expenseDigest(e.expenseId)).toBe(digest);

    const fetched = await expenseRow(e.expenseId);
    await makePayment(world, e.expenseId, 10);
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(fetched, { description: "uc" }),
        ),
      ),
    ).toBe("FN013");
  });

  it("L10 edit validation: the create rules apply to the changed fields", async () => {
    const e = await makeExpense(world, baseline);
    const row = await expenseRow(e.expenseId);
    const bad: Partial<UpdateExpenseInput>[] = [
      { amount: "0" },
      { amount: "NaN" },
      { amount: "1.005" },
      { amount: "10000000000" },
      { description: "" },
      { description: "x".repeat(201) },
      { vendorName: "x".repeat(201) },
      { note: "x".repeat(501) },
      { dueDate: "2026-09-30" },
      { categoryKey: "unknown_key" },
      { categoryKey: "RENT" },
      { branchId: world.otherBranchId },
      { branchId: world.deletedBranchId },
      { branchId: newKey() },
      { expenseDate: "1999-12-31" },
      { expenseDate: await tenantToday(T(), 367) },
    ];
    for (const change of bad) {
      expect(
        failure(await updateExpense(world.owner.id, stateOf(row, change))),
        JSON.stringify(change),
      ).toBe("FN004");
    }
    expect((await expenseRow(e.expenseId)).version).toBe(1);
  });

  it("L11 unchanged legacy values are never re-validated, while CHANGING to them is rejected", async () => {
    const legacy = await makeExpense(world, {
      ...baseline,
      categoryKey: "water",
      branchId: world.branch2Id,
    });
    const other = await makeExpense(world, baseline);
    const dated = await makeExpense(world, baseline);
    await testDb`update expense_categories set is_active = false where key = 'water'`;
    await testDb`update branches set deleted_at = now() where id = ${world.branch2Id}`;
    const farDate = await tenantToday(T(), 400);
    await testDb`update expenses set expense_date = ${farDate}::date where id = ${dated.expenseId}`;
    try {
      // a retired category, a soft-deleted branch and an out-of-window date that were already stored do not block an edit of something else
      expect(
        (
          await expectOk(
            await updateExpense(
              world.owner.id,
              stateOf(await expenseRow(legacy.expenseId), {
                description: "eski değerler duruyor",
              }),
            ),
          )
        ).noop,
      ).toBe(false);
      expect(
        (
          await expectOk(
            await updateExpense(
              world.owner.id,
              stateOf(await expenseRow(dated.expenseId), {
                description: "uzak tarih duruyor",
              }),
            ),
          )
        ).noop,
      ).toBe(false);
      // ...but CHANGING to the retired category or the deleted branch is rejected
      const row = await expenseRow(other.expenseId);
      expect(
        failure(
          await updateExpense(
            world.owner.id,
            stateOf(row, { categoryKey: "water" }),
          ),
        ),
      ).toBe("FN004");
      expect(
        failure(
          await updateExpense(
            world.owner.id,
            stateOf(row, { branchId: world.branch2Id }),
          ),
        ),
      ).toBe("FN004");
      // and changing the date TO a far-future one is rejected too
      expect(
        failure(
          await updateExpense(
            world.owner.id,
            stateOf(row, { expenseDate: farDate }),
          ),
        ),
      ).toBe("FN004");
    } finally {
      await testDb`update expense_categories set is_active = true where key = 'water'`;
      await testDb`update branches set deleted_at = null where id = ${world.branch2Id}`;
    }
  });

  it("L12 the amount transition table", async () => {
    // P = 0: any amount keeps the expense open
    const open = await makeExpense(world, baseline);
    expect(
      (
        await expectOk(
          await updateExpense(
            world.owner.id,
            stateOf(await expenseRow(open.expenseId), { amount: 50 }),
          ),
        )
      ).status,
    ).toBe("open");

    // 0 < P < A: N > P stays partially_paid; N = P becomes paid; N < P is FN012
    const part = await makeExpense(world, baseline);
    await makePayment(world, part.expenseId, 400);
    expect(
      (
        await expectOk(
          await updateExpense(
            world.owner.id,
            stateOf(await expenseRow(part.expenseId), { amount: 700 }),
          ),
        )
      ).status,
    ).toBe("partially_paid");
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(await expenseRow(part.expenseId), { amount: 399 }),
        ),
      ),
    ).toBe("FN012");
    expect(
      (
        await expectOk(
          await updateExpense(
            world.owner.id,
            stateOf(await expenseRow(part.expenseId), { amount: 400 }),
          ),
        )
      ).status,
    ).toBe("paid");

    // P = A: N = A unchanged; N > A reopens
    const paid = await makeExpense(world, baseline);
    await makePayment(world, paid.expenseId, 1000);
    expect(
      await expectOk(
        await updateExpense(
          world.owner.id,
          stateOf(await expenseRow(paid.expenseId), { amount: 1000 }),
        ),
      ),
    ).toMatchObject({ noop: true });
    expect(
      (
        await expectOk(
          await updateExpense(
            world.owner.id,
            stateOf(await expenseRow(paid.expenseId), { amount: 1000.01 }),
          ),
        )
      ).status,
    ).toBe("partially_paid");
  });

  it("L13 the reclassification path: void every payment, edit the structure, pay again", async () => {
    const e = await makeExpense(world, {
      ...baseline,
      categoryKey: "supplies",
      branchId: null,
    });
    const p1 = await makePayment(world, e.expenseId, 600);
    const p2 = await makePayment(world, e.expenseId, 400);
    expect((await expenseRow(e.expenseId)).status).toBe("paid");
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(await expenseRow(e.expenseId), { categoryKey: "rent" }),
        ),
      ),
    ).toBe("FN012");
    await expectOk(
      await voidPayment(world.owner.id, p1.paymentId!, "yanlis kategori"),
    );
    await expectOk(
      await voidPayment(world.owner.id, p2.paymentId!, "yanlis kategori"),
    );
    await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(e.expenseId), {
          categoryKey: "rent",
          branchId: world.branchId,
          expenseDate: "2026-10-12",
        }),
      ),
    );
    await makePayment(world, e.expenseId, 1000);
    const row = await expenseRow(e.expenseId);
    expect(row).toMatchObject({
      status: "paid",
      category_key: "rent",
      branch_id: world.branchId,
    });
    const rows = await paymentRows(e.expenseId);
    expect(rows.map((r) => r.status).sort()).toEqual([
      "posted",
      "voided",
      "voided",
    ]);
  });

  it("L14 the read-model flags predict what the triggers do at every stage", async () => {
    const check = async (expenseId: string) => {
      const detail = (await expectOk(
        await getExpense(world.owner.id, expenseId),
      )) as Record<string, unknown>;
      const row = await expenseRow(expenseId);
      const structure = await updateExpense(
        world.owner.id,
        stateOf(row, {
          categoryKey: row.category_key === "rent" ? "water" : "rent",
        }),
      );
      if (detail.structureLocked)
        expect(failure(structure)).toBe(
          row.status === "cancelled" ? "FN008" : "FN012",
        );
      else expect(structure.ok).toBe(true);
      return detail;
    };
    const unpaid = await makeExpense(world, baseline);
    expect(await check(unpaid.expenseId)).toMatchObject({
      structureLocked: false,
      canCancel: true,
      amountFloor: 0,
    });
    const partial = await makeExpense(world, baseline);
    await makePayment(world, partial.expenseId, 250);
    expect(await check(partial.expenseId)).toMatchObject({
      structureLocked: true,
      canCancel: false,
      amountFloor: 250,
    });
    const paid = await makeExpense(world, baseline);
    await makePayment(world, paid.expenseId, 1000);
    expect(await check(paid.expenseId)).toMatchObject({
      structureLocked: true,
      canCancel: false,
      amountFloor: 1000,
    });
    const cancelled = await makeExpense(world, baseline);
    await expectOk(
      await cancelExpense(world.owner.id, cancelled.expenseId, "iptal"),
    );
    expect(await check(cancelled.expenseId)).toMatchObject({
      structureLocked: true,
      canCancel: false,
    });
    // canCancel false means FN011 on a cancel attempt
    expect(
      failure(await cancelExpense(world.owner.id, partial.expenseId, "olmaz")),
    ).toBe("FN011");
    expect(
      (await cancelExpense(world.owner.id, unpaid.expenseId, "olur")).ok,
    ).toBe(true);
  });

  it("L15 the update audit lists every changed field by name", async () => {
    const e = await makeExpense(world, baseline);
    await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(e.expenseId), {
          description: "d2",
          note: "n2",
          vendorName: "v2",
          amount: 1111,
          dueDate: "2026-11-11",
        }),
      ),
    );
    const [event] = await expenseAudit(
      T(),
      "finance.expense_updated",
      e.expenseId,
    );
    expect((event!.after!.changed_fields as string[]).slice().sort()).toEqual([
      "amount",
      "description",
      "due_date",
      "note",
      "vendor_name",
    ]);
  });
});

// =================================================================================================================
// VR — the version ledger (one owner: trigger T1; every real settlement mutation bumps it)
// =================================================================================================================
describe("VR version ledger", () => {
  const baseline: Partial<CreateExpenseInput> = {
    categoryKey: "supplies",
    description: "Versiyon",
    expenseDate: "2026-10-01",
    amount: 1000,
  };
  const version = async (id: string) => (await expenseRow(id)).version;

  it("VR1 create without an initial payment is version 1", async () => {
    const e = await makeExpense(world, baseline);
    expect(e.version).toBe(1);
    expect(await expenseRow(e.expenseId)).toMatchObject({
      version: 1,
      settlement_events: 0,
    });
  });

  it("VR2 create with an initial payment ends at version 2, partial or full", async () => {
    const partial = await makeExpense(world, {
      ...baseline,
      initialPayment: ip(400, "cash", PAST),
    });
    expect(partial).toMatchObject({ status: "partially_paid", version: 2 });
    const full = await makeExpense(world, {
      ...baseline,
      initialPayment: ip(1000, "cash", PAST),
    });
    expect(full).toMatchObject({ status: "paid", version: 2 });
    expect((await expenseRow(full.expenseId)).settlement_events).toBe(1);
  });

  it("VR3 a multi-field update bumps exactly once", async () => {
    const e = await makeExpense(world, baseline);
    const out = await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(e.expenseId), {
          description: "a",
          note: "b",
          amount: 1500,
          dueDate: "2026-12-01",
          categoryKey: "rent",
        }),
      ),
    );
    expect(out.version).toBe(2);
  });

  it("VR4 an identical update changes nothing", async () => {
    const e = await makeExpense(world, baseline);
    const out = await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(e.expenseId)),
      ),
    );
    expect(out).toMatchObject({ noop: true, version: 1 });
  });

  it("VR5 an amount edit that flips the status bumps exactly once, never twice", async () => {
    const e = await makeExpense(world, baseline);
    await makePayment(world, e.expenseId, 1000); // open -> paid: v2
    const out = await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(e.expenseId), { amount: 1200 }),
      ),
    );
    expect(out).toMatchObject({ status: "partially_paid", version: 3 });
  });

  it("VR6 cancel bumps once; cancelling again changes nothing", async () => {
    const e = await makeExpense(world, baseline);
    expect(
      await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal")),
    ).toMatchObject({ noop: false, version: 2 });
    expect(
      await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal")),
    ).toMatchObject({ noop: true, version: 2 });
  });

  it("VR7 status-changing payments each bump once (open to partial, partial to paid, open to paid)", async () => {
    const a = await makeExpense(world, baseline);
    expect((await makePayment(world, a.expenseId, 400)).version).toBe(2); // open -> partially_paid
    expect((await makePayment(world, a.expenseId, 600)).version).toBe(3); // partially_paid -> paid
    const b = await makeExpense(world, baseline);
    expect((await makePayment(world, b.expenseId, 1000)).version).toBe(2); // open -> paid
  });

  it("VR8 a payment that leaves the status unchanged STILL bumps the version once", async () => {
    const e = await makeExpense(world, baseline);
    await makePayment(world, e.expenseId, 300);
    const v = await version(e.expenseId);
    const out = await makePayment(world, e.expenseId, 200);
    expect(out.status).toBe("partially_paid");
    expect(out.version).toBe(v + 1);
  });

  it("VR9 a void bumps exactly once whether or not the status changes; voiding a voided payment changes nothing", async () => {
    const e = await makeExpense(world, baseline);
    const p1 = await makePayment(world, e.expenseId, 400);
    const p2 = await makePayment(world, e.expenseId, 600); // paid
    let v = await version(e.expenseId);
    const stayPartial = await expectOk(
      await voidPayment(world.owner.id, p2.paymentId!, "yanlis"),
    ); // paid -> partially_paid
    expect(stayPartial).toMatchObject({
      status: "partially_paid",
      version: v + 1,
    });
    v = stayPartial.version;
    const p3 = await makePayment(world, e.expenseId, 100);
    expect(p3.version).toBe(v + 1);
    v = p3.version;
    const sameStatusVoid = await expectOk(
      await voidPayment(world.owner.id, p3.paymentId!, "yanlis"),
    ); // partial -> partial
    expect(sameStatusVoid).toMatchObject({
      status: "partially_paid",
      version: v + 1,
    });
    v = sameStatusVoid.version;
    const toOpen = await expectOk(
      await voidPayment(world.owner.id, p1.paymentId!, "yanlis"),
    ); // partial -> open
    expect(toOpen).toMatchObject({ status: "open", version: v + 1 });
    const again = await expectOk(
      await voidPayment(world.owner.id, p1.paymentId!, "bir daha"),
    );
    expect(again).toMatchObject({ noop: true, version: toOpen.version });
  });

  it("VR10 replays of a create and of a payment change nothing", async () => {
    const input = validCreate(world, {
      ...baseline,
      initialPayment: ip(100, "cash", PAST),
    });
    const e = await expectOk(await createExpense(world.owner.id, input));
    const key = newKey();
    const pay = {
      expenseId: e.expenseId,
      amount: 50,
      method: "cash",
      paidAt: PAST,
      idempotencyKey: key,
    };
    const first = await expectOk(await recordPayment(world.owner.id, pay));
    const digest = await expenseDigest(e.expenseId);
    expect(
      await expectOk(await createExpense(world.owner.id, input)),
    ).toMatchObject({ noop: true, version: first.version });
    expect(
      await expectOk(await recordPayment(world.owner.id, pay)),
    ).toMatchObject({ noop: true, version: first.version });
    expect(await expenseDigest(e.expenseId)).toBe(digest);
  });

  it("VR11 the 12-step trace produces exactly the planned (status, version) sequence", async () => {
    const steps: [string, string, number][] = [];
    const e = await expectOk(
      await createExpense(
        world.owner.id,
        validCreate(world, { ...baseline, amount: 1000 }),
      ),
    );
    steps.push(["create", e.status, e.version]);
    const id = e.expenseId;
    const edit = async (change: Partial<UpdateExpenseInput>) =>
      expectOk(
        await updateExpense(
          world.owner.id,
          stateOf(await expenseRow(id), change),
        ),
      );
    let r = await edit({ description: "iki" });
    steps.push(["update description", r.status, r.version]);
    r = await edit({});
    steps.push(["same-state update", r.status, r.version]);
    const p400 = await makePayment(world, id, 400);
    steps.push(["pay 400", p400.status, p400.version]);
    const p300 = await makePayment(world, id, 300);
    steps.push(["pay 300", p300.status, p300.version]);
    const v300 = await expectOk(
      await voidPayment(world.owner.id, p300.paymentId!, "yanlis"),
    );
    steps.push(["void the 300", v300.status, v300.version]);
    r = await edit({ amount: 700 });
    steps.push(["amount 700", r.status, r.version]);
    r = await edit({ amount: 400 });
    steps.push(["amount 400", r.status, r.version]);
    r = await edit({ dueDate: "2026-12-01" });
    steps.push(["due date", r.status, r.version]);
    const v400 = await expectOk(
      await voidPayment(world.owner.id, p400.paymentId!, "yanlis"),
    );
    steps.push(["void the 400", v400.status, v400.version]);
    r = await expectOk(await cancelExpense(world.owner.id, id, "iptal"));
    steps.push(["cancel", r.status, r.version]);
    r = await expectOk(await cancelExpense(world.owner.id, id, "iptal"));
    steps.push(["cancel again", r.status, r.version]);
    expect(steps).toEqual([
      ["create", "open", 1],
      ["update description", "open", 2],
      ["same-state update", "open", 2],
      ["pay 400", "partially_paid", 3],
      ["pay 300", "partially_paid", 4],
      ["void the 300", "partially_paid", 5],
      ["amount 700", "partially_paid", 6],
      ["amount 400", "paid", 7],
      ["due date", "paid", 8],
      ["void the 400", "open", 9],
      ["cancel", "cancelled", 10],
      ["cancel again", "cancelled", 10],
    ]);
  });

  it("VR12 no RPC assigns version or updated_at: only the column default and trigger T1 do", () => {
    const file = path.join(
      process.cwd(),
      "supabase/migrations/20261003090000_expense_obligations_and_settlements.sql",
    );
    const sql = readFileSync(file, "utf8");
    const bodies = [
      ...sql.matchAll(/create function ([a-z_.]+)\(([\s\S]*?)\n\$\$;/g),
    ].map((m) => ({ name: m[1]!, text: m[0] }));
    expect(bodies.length).toBe(30);
    const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");
    const offenders: string[] = [];
    for (const { name, text } of bodies) {
      if (name === "private.enforce_expense_invariants") continue; // T1 is the single owner
      const code = stripComments(text);
      if (/\bset\b[^;]*?\b(version|updated_at)\s*=/i.test(code))
        offenders.push(`${name}: update set version/updated_at`);
      if (/\bnew\.(version|updated_at)\s*:=/i.test(code))
        offenders.push(`${name}: new.version/updated_at :=`);
      if (
        /insert\s+into\s+public\.expenses\s*\([^)]*\b(version|updated_at)\b/i.test(
          code,
        )
      )
        offenders.push(`${name}: insert column version/updated_at`);
    }
    expect(offenders).toEqual([]);
    const t1 = bodies.find(
      (b) => b.name === "private.enforce_expense_invariants",
    )!;
    expect(stripComments(t1.text)).toMatch(/new\.version := old\.version \+ 1/);
  });

  it("VR13 updated_at moves if and only if the version moves", async () => {
    const e = await makeExpense(world, baseline);
    const v1 = await expenseRow(e.expenseId);
    const payKey = "00000000-0000-4000-8000-000000000042";
    const keyed = {
      expenseId: e.expenseId,
      amount: 100,
      method: "cash",
      paidAt: PAST,
      idempotencyKey: payKey,
    };
    const steps: [string, () => Promise<unknown>, boolean][] = [
      [
        "a real edit",
        () => updateExpense(world.owner.id, stateOf(v1, { description: "x" })),
        true,
      ],
      [
        "the same edit again with the spent version (FN013)",
        () => updateExpense(world.owner.id, stateOf(v1, { description: "x" })),
        false,
      ],
      ["a real payment", () => makePayment(world, e.expenseId, 100), true],
      ["a keyed payment", () => recordPayment(world.owner.id, keyed), true],
      [
        "a replay of that keyed payment",
        () => recordPayment(world.owner.id, keyed),
        false,
      ],
    ];
    let prev = await expenseRow(e.expenseId);
    for (const [name, run, moves] of steps) {
      await run();
      const now = await expenseRow(e.expenseId);
      expect(now.version !== prev.version, `${name}: version moved`).toBe(
        moves,
      );
      expect(
        now.updated_at.getTime() !== prev.updated_at.getTime(),
        `${name}: updated_at moved`,
      ).toBe(moves);
      prev = now;
    }
  });

  it("VR14 stale-form scenarios: any real payment or void makes a fetched version stale; the floor still holds against the CURRENT posted total", async () => {
    const e = await makeExpense(world, baseline);
    await makePayment(world, e.expenseId, 400);
    const fetched = await expenseRow(e.expenseId);
    await makePayment(world, e.expenseId, 100); // status stays partially_paid, but the version moved
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(fetched, { description: "bayat" }),
        ),
      ),
    ).toBe("FN013");

    const fresh = await expenseRow(e.expenseId);
    expect(
      failure(
        await updateExpense(world.owner.id, stateOf(fresh, { amount: 450 })),
      ),
    ).toBe("FN012"); // below the new posted total 500
    expect(
      (
        await expectOk(
          await updateExpense(world.owner.id, stateOf(fresh, { amount: 500 })),
        )
      ).status,
    ).toBe("paid");
  });

  // The five explicit tests required by the Owner's review.
  it("VR-X1 a partial payment that leaves the status partially_paid increments the version", async () => {
    const e = await makeExpense(world, baseline);
    await makePayment(world, e.expenseId, 400);
    const before = await expenseRow(e.expenseId);
    expect(before).toMatchObject({ status: "partially_paid", version: 2 });
    const out = await makePayment(world, e.expenseId, 100);
    expect(out).toMatchObject({
      status: "partially_paid",
      version: 3,
      noop: false,
    });
    expect(await expenseRow(e.expenseId)).toMatchObject({
      status: "partially_paid",
      version: 3,
    });
  });

  it("VR-X2 a void that leaves the status partially_paid increments the version", async () => {
    const e = await makeExpense(world, baseline);
    const p1 = await makePayment(world, e.expenseId, 400);
    await makePayment(world, e.expenseId, 100);
    const before = await expenseRow(e.expenseId);
    expect(before).toMatchObject({ status: "partially_paid" });
    const out = await expectOk(
      await voidPayment(world.owner.id, p1.paymentId!, "yanlis"),
    );
    expect(out).toMatchObject({
      status: "partially_paid",
      version: before.version + 1,
      noop: false,
    });
  });

  it("VR-X3 an idempotent payment replay does not increment the version", async () => {
    const e = await makeExpense(world, baseline);
    const pay = {
      expenseId: e.expenseId,
      amount: 250,
      method: "bank_transfer",
      paidAt: PAST,
      note: "havale",
      idempotencyKey: newKey(),
    };
    const first = await expectOk(await recordPayment(world.owner.id, pay));
    const digest = await expenseDigest(e.expenseId);
    const auditCount = (await expenseAudit(T())).length;
    const replay = await expectOk(await recordPayment(world.owner.id, pay));
    expect(replay).toMatchObject({
      noop: true,
      version: first.version,
      paymentId: first.paymentId,
    });
    expect(await expenseDigest(e.expenseId)).toBe(digest);
    expect((await expenseAudit(T())).length).toBe(auditCount);
  });

  it("VR-X4 a stale update whose payload equals the current state still returns FN013", async () => {
    const e = await makeExpense(world, baseline);
    const original = await expenseRow(e.expenseId);
    await makePayment(world, e.expenseId, 10); // the version moves; the edited fields do NOT
    const current = await expenseRow(e.expenseId);
    expect(current.version).toBeGreaterThan(original.version);
    // the submitted values equal the current ones, but the expected version is the stale one
    const stalePayloadEqualToCurrent = stateOf(current, {
      expectedVersion: original.version,
    });
    expect(
      failure(await updateExpense(world.owner.id, stalePayloadEqualToCurrent)),
    ).toBe("FN013");
    // ...and a stale form with an invalid payload is also FN013: the version is validated first
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(current, { expectedVersion: original.version, amount: "0" }),
        ),
      ),
    ).toBe("FN013");
  });

  it("VR-X5 an identical update at the current version is a noop: no version change, no audit event", async () => {
    const e = await makeExpense(world, baseline);
    await makePayment(world, e.expenseId, 10);
    const current = await expenseRow(e.expenseId);
    const digest = await expenseDigest(e.expenseId);
    const auditCount = (await expenseAudit(T())).length;
    const out = await expectOk(
      await updateExpense(world.owner.id, stateOf(current)),
    );
    expect(out).toMatchObject({ noop: true, version: current.version });
    expect(await expenseDigest(e.expenseId)).toBe(digest);
    expect((await expenseAudit(T())).length).toBe(auditCount);
  });
});

// =================================================================================================================
// C — cancel
// =================================================================================================================
describe("C cancel", () => {
  const baseline: Partial<CreateExpenseInput> = {
    categoryKey: "supplies",
    description: "Iptal",
    expenseDate: "2026-10-01",
    amount: 1000,
  };

  it("C1 an unpaid expense becomes cancelled with its metadata, one audit event, and leaves the overview", async () => {
    const e = await makeExpense(world, {
      ...baseline,
      expenseDate: "2026-07-15",
    });
    const out = await expectOk(
      await cancelExpense(world.owner.id, e.expenseId, "  yanlis giris  "),
    );
    expect(out).toMatchObject({ status: "cancelled", version: 2, noop: false });
    const row = await expenseRow(e.expenseId);
    expect(row).toMatchObject({
      status: "cancelled",
      cancel_reason: "yanlis giris",
      cancelled_by: world.owner.id,
    });
    expect(row.cancelled_at).toBeInstanceOf(Date);
    expect(
      (await expenseAudit(T(), "finance.expense_cancelled", e.expenseId))
        .length,
    ).toBe(1);
  });

  it("C2 with posted payments, partial or full, cancel is FN011 and changes nothing", async () => {
    for (const amount of [300, 1000]) {
      const e = await makeExpense(world, baseline);
      await makePayment(world, e.expenseId, amount);
      const digest = await tenantDigest(T());
      expect(
        failure(await cancelExpense(world.owner.id, e.expenseId, "olmaz")),
      ).toBe("FN011");
      expect(await tenantDigest(T())).toBe(digest);
    }
  });

  it("C3 with only voided payments, cancel succeeds and the voided rows stay voided", async () => {
    const e = await makeExpense(world, baseline);
    const p = await makePayment(world, e.expenseId, 300);
    await expectOk(await voidPayment(world.owner.id, p.paymentId!, "yanlis"));
    await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal"));
    expect((await paymentRows(e.expenseId)).map((r) => r.status)).toEqual([
      "voided",
    ]);
    expect((await expenseRow(e.expenseId)).status).toBe("cancelled");
  });

  it("C4 the reason: null, blank and 501 chars are FN004 (even when payments exist); trimmed otherwise", async () => {
    const e = await makeExpense(world, baseline);
    for (const reason of [null, "", "   ", "x".repeat(501)]) {
      expect(
        failure(await cancelExpense(world.owner.id, e.expenseId, reason)),
      ).toBe("FN004");
    }
    const paid = await makeExpense(world, baseline);
    await makePayment(world, paid.expenseId, 100);
    // request validation precedes the lifecycle rule: a blank reason is FN004 even though FN011 would also apply
    expect(
      failure(await cancelExpense(world.owner.id, paid.expenseId, "")),
    ).toBe("FN004");
    expect(
      failure(
        await cancelExpense(world.owner.id, paid.expenseId, "gecerli neden"),
      ),
    ).toBe("FN011");
  });

  it("C5 cancelling an already cancelled expense is a noop: 0 audit, reason not re-validated, version unchanged", async () => {
    const e = await makeExpense(world, baseline);
    await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal"));
    const digest = await tenantDigest(T());
    expect(
      await expectOk(await cancelExpense(world.owner.id, e.expenseId, "")),
    ).toMatchObject({ noop: true, status: "cancelled", version: 2 });
    expect(await tenantDigest(T())).toBe(digest);
  });

  it("C6 cancelled is terminal: payments and changing edits are FN008, an identical edit is a noop, nothing reopens it", async () => {
    const e = await makeExpense(world, baseline);
    await expectOk(await cancelExpense(world.owner.id, e.expenseId, "iptal"));
    expect(
      failure(
        await recordPayment(world.owner.id, {
          expenseId: e.expenseId,
          amount: 10,
          method: "cash",
          paidAt: instantAgo(5),
          idempotencyKey: newKey(),
        }),
      ),
    ).toBe("FN008");
    const row = await expenseRow(e.expenseId);
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(row, { description: "yeni" }),
        ),
      ),
    ).toBe("FN008");
    expect(
      (await expectOk(await updateExpense(world.owner.id, stateOf(row)))).noop,
    ).toBe(true);
    await expect(
      testDb`update expenses set status = 'open', cancelled_at = null, cancelled_by = null, cancel_reason = null where id = ${e.expenseId}`,
    ).rejects.toMatchObject({ code: "FN008" });
  });

  it("C7 cross-tenant, view-only and ordinary-staff callers are FN002", async () => {
    const e = await makeExpense(world, baseline);
    for (const who of [world.otherOwner, world.viewOnly, world.neither]) {
      expect(failure(await cancelExpense(who.id, e.expenseId, "olmaz"))).toBe(
        "FN002",
      );
    }
    expect((await expenseRow(e.expenseId)).status).toBe("open");
  });
});

// =================================================================================================================
// A — audit (the obligation half; payment, read and gate checks live in the other files)
// =================================================================================================================
describe("A audit", () => {
  it("A1 create without an initial payment writes exactly one finance.expense_created with the exact keys", async () => {
    const e = await makeExpense(world, {
      branchId: world.branchId,
      dueDate: "2026-10-20",
      amount: 321.5,
      categoryKey: "rent",
    });
    const events = await expenseAudit(T(), undefined, e.expenseId);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      action: "finance.expense_created",
      entity_type: "expense",
      entity_id: e.expenseId,
      before: null,
      tenant_id: T(),
    });
    expect(Object.keys(event!.after!).sort()).toEqual([
      "amount",
      "branch_id",
      "category_key",
      "currency",
      "due_date",
      "expense_date",
      "status",
    ]);
    expect(event!.after).toMatchObject({
      amount: 321.5,
      currency: "TRY",
      category_key: "rent",
      branch_id: world.branchId,
      status: "open",
    });
  });

  it("A2 create with an initial payment writes exactly two events in one transaction; a replay adds none", async () => {
    const input = validCreate(world, {
      amount: 1000,
      initialPayment: ip(400, "bank_transfer", PAST, "havale"),
    });
    const e = await expectOk(await createExpense(world.owner.id, input));
    const created = await expenseAudit(
      T(),
      "finance.expense_created",
      e.expenseId,
    );
    const recorded = await expenseAudit(
      T(),
      "finance.expense_payment_recorded",
      e.paymentId!,
    );
    expect(created).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      entity_type: "expense_payment",
      entity_id: e.paymentId,
      before: null,
    });
    expect(Object.keys(recorded[0]!.after!).sort()).toEqual([
      "amount",
      "expense_id",
      "method",
      "paid_at",
    ]);
    expect(recorded[0]!.after).toMatchObject({
      expense_id: e.expenseId,
      amount: 400,
      method: "bank_transfer",
    });
    expect(recorded[0]!.actor_user_id).toBe(created[0]!.actor_user_id);
    const [same] = await testDb<
      { same: boolean }[]
    >`select (select created_at from audit_logs where id = ${created[0]!.id}) = (select created_at from audit_logs where id = ${recorded[0]!.id}) as same`;
    expect(same!.same, "both events are written by one transaction").toBe(true);
    await expectOk(await createExpense(world.owner.id, input));
    expect((await expenseAudit(T(), undefined, e.expenseId)).length).toBe(1);
    expect((await expenseAudit(T(), undefined, e.paymentId!)).length).toBe(1);
  });

  it("A3 update writes one finance.expense_updated with only the changed non-text fields; a noop and a stale call write none", async () => {
    const e = await makeExpense(world, {
      categoryKey: "supplies",
      amount: 1000,
      dueDate: "2026-10-20",
      description: "ilk",
    });
    const row = await expenseRow(e.expenseId);
    await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(row, {
          amount: 1200,
          description: "ikinci",
          categoryKey: "rent",
        }),
      ),
    );
    const events = await expenseAudit(
      T(),
      "finance.expense_updated",
      e.expenseId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.before).toEqual({
      amount: 1000,
      category_key: "supplies",
    });
    expect(events[0]!.after).toMatchObject({
      amount: 1200,
      category_key: "rent",
      version: 2,
    });
    expect(
      (events[0]!.after!.changed_fields as string[]).slice().sort(),
    ).toEqual(["amount", "category_key", "description"]);
    expect(JSON.stringify(events[0])).not.toContain("ikinci");
    const next = await expenseRow(e.expenseId);
    await expectOk(await updateExpense(world.owner.id, stateOf(next)));
    expect(
      failure(
        await updateExpense(
          world.owner.id,
          stateOf(next, { expectedVersion: 1, description: "bayat" }),
        ),
      ),
    ).toBe("FN013");
    expect(
      (await expenseAudit(T(), "finance.expense_updated", e.expenseId)).length,
    ).toBe(1);
  });

  it("A4 cancel writes one finance.expense_cancelled with the reason; repeating writes none", async () => {
    const e = await makeExpense(world);
    await expectOk(
      await cancelExpense(world.owner.id, e.expenseId, "yanlis giris"),
    );
    await expectOk(
      await cancelExpense(world.owner.id, e.expenseId, "yanlis giris"),
    );
    const events = await expenseAudit(
      T(),
      "finance.expense_cancelled",
      e.expenseId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      before: { status: "open" },
      after: { status: "cancelled", reason: "yanlis giris" },
    });
  });

  it("A6 every failing call writes no audit row and no data row", async () => {
    const paid = await makeExpense(world, { amount: 100 });
    await makePayment(world, paid.expenseId, 100);
    const open = await makeExpense(world, { amount: 100 });
    const cancelled = await makeExpense(world);
    await expectOk(
      await cancelExpense(world.owner.id, cancelled.expenseId, "iptal"),
    );
    const paidRow = await expenseRow(paid.expenseId);
    const openRow = await expenseRow(open.expenseId);
    const cancelledRow = await expenseRow(cancelled.expenseId);
    const calls: [string, () => Promise<RpcOutcome<unknown>>, string][] = [
      [
        "create with a bad amount",
        () =>
          createExpense(world.owner.id, validCreate(world, { amount: "0" })),
        "FN004",
      ],
      [
        "create without a key",
        () =>
          createExpense(
            world.owner.id,
            validCreate(world, { idempotencyKey: null }),
          ),
        "FN004",
      ],
      [
        "create by a viewer",
        () => createExpense(world.viewOnly.id, validCreate(world)),
        "FN002",
      ],
      [
        "create with a bad initial payment",
        () =>
          createExpense(
            world.owner.id,
            validCreate(world, { initialPayment: ip(10, "cheque", PAST) }),
          ),
        "FN006",
      ],
      [
        "update with a stale version",
        () =>
          updateExpense(
            world.owner.id,
            stateOf(openRow, { expectedVersion: 99, description: "x" }),
          ),
        "FN013",
      ],
      [
        "update of locked structure",
        () =>
          updateExpense(
            world.owner.id,
            stateOf(paidRow, { categoryKey: "rent" }),
          ),
        "FN012",
      ],
      [
        "update below the posted total",
        () => updateExpense(world.owner.id, stateOf(paidRow, { amount: 50 })),
        "FN012",
      ],
      [
        "update of a cancelled expense",
        () =>
          updateExpense(
            world.owner.id,
            stateOf(cancelledRow, { description: "x" }),
          ),
        "FN008",
      ],
      [
        "cancel with payments",
        () => cancelExpense(world.owner.id, paid.expenseId, "olmaz"),
        "FN011",
      ],
      [
        "cancel without a reason",
        () => cancelExpense(world.owner.id, open.expenseId, ""),
        "FN004",
      ],
      [
        "payment above the remaining amount",
        () =>
          recordPayment(world.owner.id, {
            expenseId: paid.expenseId,
            amount: 1,
            method: "cash",
            paidAt: instantAgo(5),
            idempotencyKey: newKey(),
          }),
        "FN005",
      ],
      [
        "payment with a bad method",
        () =>
          recordPayment(world.owner.id, {
            expenseId: open.expenseId,
            amount: 1,
            method: "cheque",
            paidAt: instantAgo(5),
            idempotencyKey: newKey(),
          }),
        "FN006",
      ],
      [
        "payment on a cancelled expense",
        () =>
          recordPayment(world.owner.id, {
            expenseId: cancelled.expenseId,
            amount: 1,
            method: "cash",
            paidAt: instantAgo(5),
            idempotencyKey: newKey(),
          }),
        "FN008",
      ],
      [
        "void of an unknown payment",
        () => voidPayment(world.owner.id, newKey(), "yok"),
        "FN009",
      ],
    ];
    for (const [name, call, code] of calls) {
      const before = await tenantDigest(T());
      expect(failure(await call()), name).toBe(code);
      expect(await tenantDigest(T()), name).toBe(before);
    }
  });

  it("A7 no free text ever reaches an audit payload", async () => {
    const sentinels = {
      desc: uniqueText("SENT-DESC"),
      vendor: uniqueText("SENT-VENDOR"),
      note: uniqueText("SENT-NOTE"),
      pnote: uniqueText("SENT-PNOTE"),
    };
    const e = await expectOk(
      await createExpense(
        world.owner.id,
        validCreate(world, {
          description: sentinels.desc,
          vendorName: sentinels.vendor,
          note: sentinels.note,
          amount: 1000,
          initialPayment: ip(100, "cash", PAST, sentinels.pnote),
        }),
      ),
    );
    const edit = {
      desc: uniqueText("SENT-DESC2"),
      vendor: uniqueText("SENT-VENDOR2"),
      note: uniqueText("SENT-NOTE2"),
    };
    await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(e.expenseId), {
          description: edit.desc,
          vendorName: edit.vendor,
          note: edit.note,
        }),
      ),
    );
    const pnote2 = uniqueText("SENT-PNOTE2");
    await makePayment(world, e.expenseId, 50, { note: pnote2 });
    const payloads = JSON.stringify(
      (await expenseAudit(T())).filter(
        (r) =>
          r.entity_id === e.expenseId ||
          r.entity_id === e.paymentId ||
          (r.after as Record<string, unknown> | null)?.expense_id ===
            e.expenseId,
      ),
    );
    for (const value of [
      ...Object.values(sentinels),
      ...Object.values(edit),
      pnote2,
    ]) {
      expect(payloads).not.toContain(value);
    }
  });

  it("A8 the Owner sequence writes exactly six events: create + initial payment, edit, second payment, void, replacement payment, and a refused cancel", async () => {
    const e = await expectOk(
      await createExpense(
        world.owner.id,
        validCreate(world, {
          amount: 3500,
          initialPayment: ip(1500, "cash", PAST),
        }),
      ),
    );
    expect(e).toMatchObject({ version: 2, status: "partially_paid" });
    await expectOk(
      await updateExpense(
        world.owner.id,
        stateOf(await expenseRow(e.expenseId), { description: "duzenlendi" }),
      ),
    );
    const second = await makePayment(world, e.expenseId, 2000, {
      method: "card",
    });
    expect(second).toMatchObject({ status: "paid", version: 4 });
    await expectOk(
      await voidPayment(world.owner.id, second.paymentId!, "yanlis kart"),
    );
    const replacement = await makePayment(world, e.expenseId, 2000, {
      method: "bank_transfer",
    });
    expect(replacement).toMatchObject({ status: "paid", version: 6 });
    expect(
      failure(await cancelExpense(world.owner.id, e.expenseId, "olmaz")),
    ).toBe("FN011");
    const events = (await expenseAudit(T())).filter(
      (r) =>
        r.entity_id === e.expenseId ||
        (r.after as Record<string, unknown> | null)?.expense_id === e.expenseId,
    );
    expect(events.map((r) => r.action).sort()).toEqual(
      [
        "finance.expense_created",
        "finance.expense_payment_recorded",
        "finance.expense_payment_recorded",
        "finance.expense_payment_recorded",
        "finance.expense_payment_voided",
        "finance.expense_updated",
      ].sort(),
    );
    expect(events).toHaveLength(6);
  });

  it("A11 the audit actor is the caller, actor_type is user, and the tenant is right", async () => {
    const e = await makeExpense(world, {}, world.accountant);
    const [event] = await expenseAudit(
      T(),
      "finance.expense_created",
      e.expenseId,
    );
    expect(event).toMatchObject({
      actor_user_id: world.accountant.id,
      actor_type: "user",
      tenant_id: T(),
    });
  });
});
