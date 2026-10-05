import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createExpenseWorld,
  destroyExpenseWorld,
  createExpense,
  cancelExpense,
  voidPayment,
  getExpense,
  getOverview,
  listExpenses,
  listCategories,
  makeExpense,
  makePayment,
  validCreate,
  expectOk,
  expenseRow,
  tenantDigest,
  tenantToday,
  newKey,
  uniqueText,
  type ExpenseWorld,
  type ExpenseListItem,
  type ExpenseListResult,
  type RpcOutcome,
} from "./expense-fixtures";
import { createBranch } from "./helpers";

/**
 * Faz FIN.1B.1 — read models and overview semantics (matrix group R) and A9. Every overview and list assertion is scoped
 * to a branch created for that test, so rows from other tests in the same tenant never leak into a total, and every
 * time-dependent read passes an explicit p_reference_date.
 *
 * NOTE for whoever runs this file next: it needs migration 20261003090000 applied to whatever TEST_DATABASE_URL points
 * at (a disposable PROD-derived branch or the local rig, never the shared DEV database) and fails loudly when it is not.
 */

let world: ExpenseWorld;

beforeAll(async () => {
  world = await createExpenseWorld("fin1b1-rd");
});

afterAll(async () => {
  await destroyExpenseWorld(world);
});

const T = () => world.tenant.id;
const owner = () => world.owner.id;

async function freshBranch(label: string): Promise<string> {
  return createBranch(T(), `${label} ${uniqueText("sube")}`);
}

function failure(out: RpcOutcome<unknown>): string | undefined {
  expect(out.ok, `expected a failure, got ${JSON.stringify(out)}`).toBe(false);
  return out.ok ? undefined : out.code;
}

/** Bulk-insert plain open expenses straight into the table (fast fixture for list/pagination tests). */
async function bulkInsert(
  branchId: string,
  rows: {
    date: string;
    description: string;
    amount?: number;
    category?: string;
    vendor?: string | null;
    due?: string | null;
  }[],
) {
  for (const r of rows) {
    await testDb`
      insert into expenses (tenant_id, branch_id, category_key, description, vendor_name, expense_date, due_date, amount, currency, created_by)
      values (${T()}, ${branchId}, ${r.category ?? "supplies"}, ${r.description}, ${r.vendor ?? null}, ${r.date}::date, ${r.due ?? null}::date, ${r.amount ?? 100}, 'TRY', ${world.owner.id})`;
  }
}

describe("R read models", () => {
  it("R11 an empty tenant: zeros, an empty list, and the primary currency entry present", async () => {
    const overview = await expectOk(
      await getOverview(world.otherOwner.id, world.otherTenant.id, {
        month: "2026-09-01",
        referenceDate: "2026-09-15",
      }),
    );
    expect(overview.primaryCurrency).toBe("TRY");
    expect(overview.byCurrency).toEqual([
      {
        currency: "TRY",
        incurred: 0,
        paid: 0,
        outstanding: { total: 0, count: 0 },
        overdue: { total: 0, count: 0 },
        upcoming: { total: 0, count: 0, withinDays: 14 },
      },
    ]);
    const list = await expectOk(
      await listExpenses(world.otherOwner.id, {
        tenantId: world.otherTenant.id,
      }),
    );
    expect(list).toEqual({ items: [], nextCursor: null });
  });

  it("R1 tenant isolation: another tenant's rows never appear and a foreign id is FN002", async () => {
    const mine = await makeExpense(world, {
      description: uniqueText("benim gider"),
    });
    const theirs = await expectOk(
      await createExpense(world.otherOwner.id, {
        ...validCreate(world, { description: uniqueText("onlarin gider") }),
        tenantId: world.otherTenant.id,
      }),
    );
    const myList = await expectOk(
      await listExpenses(owner(), { tenantId: T(), limit: 100 }),
    );
    expect(myList.items.some((i) => i.id === theirs.expenseId)).toBe(false);
    expect(myList.items.some((i) => i.id === mine.expenseId)).toBe(true);
    const theirList = await expectOk(
      await listExpenses(world.otherOwner.id, {
        tenantId: world.otherTenant.id,
        limit: 100,
      }),
    );
    expect(theirList.items.map((i) => i.id)).toEqual([theirs.expenseId]);
    expect(failure(await getExpense(owner(), theirs.expenseId))).toBe("FN002");
    expect(failure(await getExpense(world.otherOwner.id, mine.expenseId))).toBe(
      "FN002",
    );
    expect(
      failure(await listExpenses(owner(), { tenantId: world.otherTenant.id })),
    ).toBe("FN002");
    expect(failure(await getOverview(owner(), world.otherTenant.id))).toBe(
      "FN002",
    );
  });

  it("R2 ordering and keyset pagination: 120 rows over 3 dates, 3 pages, no duplicates, no gaps, a null cursor at the end", async () => {
    const branchId = await freshBranch("sayfalama");
    await testDb`
      insert into expenses (tenant_id, branch_id, category_key, description, expense_date, amount, currency, created_by)
      select ${T()}, ${branchId}, 'supplies', 'sayfa ' || g, (date '2026-09-01' + (g % 3)), 10, 'TRY', ${world.owner.id}
      from generate_series(1, 120) g`;
    const seen: ExpenseListItem[] = [];
    let cursor: { expenseDate: string; id: string } | null = null;
    const sizes: number[] = [];
    for (let page = 0; page < 5; page++) {
      const out: ExpenseListResult = await expectOk(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          limit: 50,
          cursorDate: cursor?.expenseDate ?? null,
          cursorId: cursor?.id ?? null,
        }),
      );
      sizes.push(out.items.length);
      seen.push(...out.items);
      cursor = out.nextCursor;
      if (!cursor) break;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(cursor).toBeNull();
    expect(new Set(seen.map((i) => i.id)).size).toBe(120);
    const ordered = [...seen].sort((a, b) =>
      a.expenseDate === b.expenseDate
        ? a.id < b.id
          ? 1
          : -1
        : a.expenseDate < b.expenseDate
          ? 1
          : -1,
    );
    expect(seen.map((i) => i.id)).toEqual(ordered.map((i) => i.id));
    // the default limit is 50
    const first = await expectOk(
      await listExpenses(owner(), { tenantId: T(), branchId }),
    );
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    // out-of-range limits and a half-set cursor are FN004
    for (const limit of [0, 101, -1])
      expect(
        failure(
          await listExpenses(owner(), { tenantId: T(), branchId, limit }),
        ),
      ).toBe("FN004");
    expect(
      failure(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          cursorDate: "2026-09-01",
        }),
      ),
    ).toBe("FN004");
    expect(
      failure(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          cursorId: newKey(),
        }),
      ),
    ).toBe("FN004");
  });

  describe("R3 filters", () => {
    it("R3a the date window is inclusive and a reversed window is FN004", async () => {
      const branchId = await freshBranch("tarih");
      await bulkInsert(
        branchId,
        [
          "2026-09-01",
          "2026-09-02",
          "2026-09-03",
          "2026-09-04",
          "2026-09-05",
        ].map((date) => ({ date, description: `gun ${date}` })),
      );
      const out = await expectOk(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          fromDate: "2026-09-02",
          toDate: "2026-09-04",
        }),
      );
      expect(out.items.map((i) => i.expenseDate).sort()).toEqual([
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
      ]);
      expect(
        failure(
          await listExpenses(owner(), {
            tenantId: T(),
            branchId,
            fromDate: "2026-09-05",
            toDate: "2026-09-01",
          }),
        ),
      ).toBe("FN004");
    });

    it("R3b branch scope: a branch, Genel only, and both together (FN004)", async () => {
      const a = await freshBranch("sube-a");
      const b = await freshBranch("sube-b");
      const marker = uniqueText("kapsam");
      await bulkInsert(a, [{ date: "2026-09-01", description: `${marker} A` }]);
      await bulkInsert(b, [{ date: "2026-09-01", description: `${marker} B` }]);
      await testDb`insert into expenses (tenant_id, branch_id, category_key, description, expense_date, amount, currency)
                   values (${T()}, null, 'supplies', ${`${marker} Genel`}, date '2026-09-01', 100, 'TRY')`;
      const inA = await expectOk(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId: a,
          search: marker,
        }),
      );
      expect(inA.items.map((i) => i.description)).toEqual([`${marker} A`]);
      const general = await expectOk(
        await listExpenses(owner(), {
          tenantId: T(),
          generalOnly: true,
          search: marker,
        }),
      );
      expect(general.items.map((i) => i.description)).toEqual([
        `${marker} Genel`,
      ]);
      expect(general.items[0]).toMatchObject({
        branchId: null,
        branchName: null,
      });
      const all = await expectOk(
        await listExpenses(owner(), { tenantId: T(), search: marker }),
      );
      expect(all.items).toHaveLength(3);
      expect(
        failure(
          await listExpenses(owner(), {
            tenantId: T(),
            branchId: a,
            generalOnly: true,
          }),
        ),
      ).toBe("FN004");
    });

    it("R3c category filters exactly and an unknown key matches nothing", async () => {
      const branchId = await freshBranch("kategori");
      await bulkInsert(branchId, [
        { date: "2026-09-01", description: "kira 1", category: "rent" },
        { date: "2026-09-02", description: "su 1", category: "water" },
      ]);
      const rent = await expectOk(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          categoryKey: "rent",
        }),
      );
      expect(rent.items.map((i) => i.description)).toEqual(["kira 1"]);
      const none = await expectOk(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          categoryKey: "no_such_category",
        }),
      );
      expect(none.items).toEqual([]);
    });

    it("R3d C8 each status filters exactly, the default list hides cancelled rows, include_cancelled and status=cancelled show them, an invalid status is FN004", async () => {
      const branchId = await freshBranch("durum");
      const open = await makeExpense(world, {
        branchId,
        amount: 100,
        description: "acik",
      });
      const partial = await makeExpense(world, {
        branchId,
        amount: 100,
        description: "kismi",
      });
      await makePayment(world, partial.expenseId, 40);
      const paid = await makeExpense(world, {
        branchId,
        amount: 100,
        description: "odendi",
      });
      await makePayment(world, paid.expenseId, 100);
      const cancelled = await makeExpense(world, {
        branchId,
        amount: 100,
        description: "iptal",
      });
      await expectOk(
        await cancelExpense(owner(), cancelled.expenseId, "iptal"),
      );
      for (const [status, expected] of [
        ["open", open],
        ["partially_paid", partial],
        ["paid", paid],
        ["cancelled", cancelled],
      ] as const) {
        const out = await expectOk(
          await listExpenses(owner(), { tenantId: T(), branchId, status }),
        );
        expect(
          out.items.map((i) => i.id),
          status,
        ).toEqual([expected.expenseId]);
      }
      expect(
        failure(
          await listExpenses(owner(), {
            tenantId: T(),
            branchId,
            status: "overdue",
          }),
        ),
      ).toBe("FN004");
      // the default list hides cancelled rows; include_cancelled brings all four back
      const def = await expectOk(
        await listExpenses(owner(), { tenantId: T(), branchId }),
      );
      expect(def.items.map((i) => i.status).sort()).toEqual([
        "open",
        "paid",
        "partially_paid",
      ]);
      const withCancelled = await expectOk(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          includeCancelled: true,
        }),
      );
      expect(withCancelled.items).toHaveLength(4);
    });

    it("R3e overdue_only returns open and partially paid rows past their due date, never paid, cancelled or undated ones", async () => {
      const branchId = await freshBranch("vade");
      const overdueOpen = await makeExpense(world, {
        branchId,
        amount: 100,
        expenseDate: "2026-09-01",
        dueDate: "2026-09-10",
        description: "gecikmis acik",
      });
      const overduePartial = await makeExpense(world, {
        branchId,
        amount: 100,
        expenseDate: "2026-09-01",
        dueDate: "2026-09-11",
        description: "gecikmis kismi",
      });
      await makePayment(world, overduePartial.expenseId, 30);
      const overduePaid = await makeExpense(world, {
        branchId,
        amount: 100,
        expenseDate: "2026-09-01",
        dueDate: "2026-09-10",
        description: "gecikmis odendi",
      });
      await makePayment(world, overduePaid.expenseId, 100);
      const overdueCancelled = await makeExpense(world, {
        branchId,
        amount: 100,
        expenseDate: "2026-09-01",
        dueDate: "2026-09-10",
        description: "gecikmis iptal",
      });
      await expectOk(
        await cancelExpense(owner(), overdueCancelled.expenseId, "iptal"),
      );
      await makeExpense(world, {
        branchId,
        amount: 100,
        description: "vadesiz",
      });
      await makeExpense(world, {
        branchId,
        amount: 100,
        expenseDate: "2026-09-01",
        dueDate: "2026-09-15",
        description: "bugun vadeli",
      });
      const out = await expectOk(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          overdueOnly: true,
          includeCancelled: true,
          referenceDate: "2026-09-15",
        }),
      );
      expect(out.items.map((i) => i.id).sort()).toEqual(
        [overdueOpen.expenseId, overduePartial.expenseId].sort(),
      );
    });

    it("R3f search matches description and vendor case-insensitively, treats % and _ literally, rejects over 100 chars and ignores blank", async () => {
      const branchId = await freshBranch("arama");
      await bulkInsert(branchId, [
        {
          date: "2026-09-01",
          description: "Elektrik faturasi",
          vendor: "Enerji A.S.",
        },
        {
          date: "2026-09-02",
          description: "yuzde 50% indirimli",
          vendor: null,
        },
        { date: "2026-09-03", description: "a_b kodu", vendor: null },
        { date: "2026-09-04", description: "AxB kodu", vendor: null },
        { date: "2026-09-05", description: "kasa", vendor: "Tedarikçi Çiğdem" },
        { date: "2026-09-06", description: "ünlem! testi", vendor: null },
      ]);
      const names = async (search: string | null) =>
        (
          await expectOk(
            await listExpenses(owner(), { tenantId: T(), branchId, search }),
          )
        ).items
          .map((i) => i.description as string)
          .sort();
      expect(await names("ELEKTRIK")).toEqual(["Elektrik faturasi"]);
      expect(await names("enerji")).toEqual(["Elektrik faturasi"]);
      expect(await names("50%")).toEqual(["yuzde 50% indirimli"]);
      expect(await names("a_b")).toEqual(["a_b kodu"]);
      expect(await names("%")).toEqual(["yuzde 50% indirimli"]);
      expect(await names("_")).toEqual(["a_b kodu"]);
      expect(await names("ünlem!")).toEqual(["ünlem! testi"]);
      expect(await names("nothing-matches-this")).toEqual([]);
      expect(await names("   ")).toHaveLength(6);
      expect(await names(null)).toHaveLength(6);
      expect(
        failure(
          await listExpenses(owner(), {
            tenantId: T(),
            branchId,
            search: "x".repeat(101),
          }),
        ),
      ).toBe("FN004");
      expect(
        (
          await listExpenses(owner(), {
            tenantId: T(),
            branchId,
            search: "x".repeat(100),
          })
        ).ok,
      ).toBe(true);
    });
  });

  it("R4 detail content: exact arithmetic, payments with void reasons, Genel gives null branch fields, amountFloor equals the posted total", async () => {
    const branchId = await freshBranch("detay");
    const e = await makeExpense(world, {
      branchId,
      amount: "100.10",
      vendorName: "V",
      note: "N",
      dueDate: "2026-10-30",
      description: "detay gideri",
    });
    const p1 = await makePayment(world, e.expenseId, 33.37, { note: "ilk" });
    await makePayment(world, e.expenseId, 33.37);
    await expectOk(await voidPayment(owner(), p1.paymentId!, "yanlis"));
    const d = await expectOk(
      await getExpense(owner(), e.expenseId, "2026-09-15"),
    );
    expect(d).toMatchObject({
      id: e.expenseId,
      branchId,
      categoryKey: "supplies",
      categoryKind: "variable",
      description: "detay gideri",
      vendorName: "V",
      note: "N",
      amount: 100.1,
      currency: "TRY",
      paid: 33.37,
      outstanding: 66.73,
      amountFloor: 33.37,
      status: "partially_paid",
      structureLocked: true,
      canCancel: false,
      cancelledAt: null,
      cancelReason: null,
    });
    expect(d.branchName).toContain("detay");
    expect(d.payments).toHaveLength(2);
    expect(d.payments.map((p) => p.status).sort()).toEqual([
      "posted",
      "voided",
    ]);
    expect(d.payments.find((p) => p.status === "voided")).toMatchObject({
      voidReason: "yanlis",
      note: "ilk",
    });

    const genel = await makeExpense(world, { branchId: null });
    expect(
      await expectOk(await getExpense(owner(), genel.expenseId)),
    ).toMatchObject({ branchId: null, branchName: null });
  });

  it("R5 privacy: no user id, idempotency data or tenant id in any read model", async () => {
    const branchId = await freshBranch("gizlilik");
    const key = newKey();
    const e = await expectOk(
      await createExpense(
        owner(),
        validCreate(world, { branchId, idempotencyKey: key, amount: 500 }),
      ),
    );
    const p = await makePayment(world, e.expenseId, 100);
    await expectOk(await voidPayment(owner(), p.paymentId!, "yanlis"));
    const c = await makeExpense(world, { branchId });
    await expectOk(await cancelExpense(owner(), c.expenseId, "iptal"));
    const row = await expenseRow(e.expenseId);
    const reads = [
      await getExpense(owner(), e.expenseId),
      await getExpense(owner(), c.expenseId),
      await listExpenses(owner(), {
        tenantId: T(),
        branchId,
        includeCancelled: true,
      }),
      await getOverview(owner(), T(), {
        branchId,
        month: "2026-09-01",
        referenceDate: "2026-09-15",
      }),
      await listCategories(owner(), T()),
    ];
    const text = JSON.stringify(reads);
    const forbiddenValues = [
      ...world.users.map((u) => u.id),
      key,
      row.idempotency_fingerprint!,
      T(),
    ];
    for (const value of forbiddenValues)
      expect(text, value).not.toContain(value);
    const forbiddenKeys = [
      "created_by",
      "voided_by",
      "cancelled_by",
      "idempotency_key",
      "idempotency_fingerprint",
      "tenant_id",
      "createdBy",
      "voidedBy",
      "cancelledBy",
      "idempotencyKey",
      "tenantId",
      "settlement_events",
      "settlementEvents",
    ];
    for (const k of forbiddenKeys) expect(text, k).not.toContain(`"${k}"`);
  });

  describe("R6 the overview vector", () => {
    // The v2 vector shifted back one month (September 2026): a payment can never be future-dated, so the October rows
    // would be unwritable while the real date is early October. Every relation and every expected figure is unchanged.
    async function seedVector(branchId: string) {
      const e1 = await makeExpense(world, {
        branchId,
        categoryKey: "rent",
        expenseDate: "2026-09-01",
        amount: 10000,
        dueDate: "2026-09-05",
        description: "E1 kira",
      });
      await makePayment(world, e1.expenseId, 10000, {
        paidAt: "2026-09-04T12:00:00Z",
      });
      const e2 = await makeExpense(world, {
        branchId,
        categoryKey: "electricity",
        expenseDate: "2026-09-03",
        amount: 2500,
        dueDate: "2026-09-20",
        description: "E2 elektrik",
      });
      await makePayment(world, e2.expenseId, 1000, {
        paidAt: "2026-09-10T12:00:00Z",
      });
      await makeExpense(world, {
        branchId,
        categoryKey: "supplies",
        expenseDate: "2026-08-28",
        amount: 800,
        dueDate: "2026-09-01",
        description: "E3 sarf",
      });
      const e4 = await makeExpense(world, {
        branchId,
        categoryKey: "internet",
        expenseDate: "2026-09-07",
        amount: 600,
        description: "E4 internet",
      });
      const v4 = await makePayment(world, e4.expenseId, 500, {
        paidAt: "2026-09-08T12:00:00Z",
      });
      await expectOk(await voidPayment(owner(), v4.paymentId!, "yanlis"));
      const e5 = await makeExpense(world, {
        branchId,
        categoryKey: "cleaning",
        expenseDate: "2026-09-09",
        amount: 300,
        description: "E5 temizlik",
      });
      await expectOk(await cancelExpense(owner(), e5.expenseId, "iptal"));
      await testDb`update tenants set currency = 'EUR' where id = ${T()}`;
      try {
        await makeExpense(world, {
          branchId,
          categoryKey: "other",
          expenseDate: "2026-09-12",
          amount: 100,
          dueDate: "2026-09-14",
          description: "E6 euro",
        });
      } finally {
        await testDb`update tenants set currency = 'TRY' where id = ${T()}`;
      }
      const e7 = await makeExpense(world, {
        branchId,
        categoryKey: "supplies",
        expenseDate: "2026-08-25",
        amount: 400,
        description: "E7 sinir odemesi",
      });
      await makePayment(world, e7.expenseId, 400, {
        paidAt: "2026-08-31T21:30:00Z",
      });
    }

    const eur = {
      currency: "EUR",
      incurred: 100,
      paid: 0,
      outstanding: { total: 100, count: 1 },
      overdue: { total: 100, count: 1 },
      upcoming: { total: 0, count: 0, withinDays: 14 },
    };

    it("R6 exact TRY and EUR figures under Europe/Nicosia", async () => {
      const branchId = await freshBranch("vektor");
      await testDb`update tenants set timezone = 'Europe/Nicosia' where id = ${T()}`;
      try {
        await seedVector(branchId);
        const out = await expectOk(
          await getOverview(owner(), T(), {
            month: "2026-09-01",
            branchId,
            referenceDate: "2026-09-15",
          }),
        );
        expect(out.month).toBe("2026-09-01");
        expect(out.referenceDate).toBe("2026-09-15");
        expect(out.primaryCurrency).toBe("TRY");
        expect(out.byCurrency).toEqual([
          {
            currency: "TRY",
            incurred: 13100,
            paid: 11400,
            outstanding: { total: 2900, count: 3 },
            overdue: { total: 800, count: 1 },
            upcoming: { total: 1500, count: 1, withinDays: 14 },
          },
          eur,
        ]);
      } finally {
        await testDb`update tenants set timezone = 'Europe/Istanbul' where id = ${T()}`;
      }
    });

    it("R7 under America/Los_Angeles the boundary payment moves to the previous month (paid 11000) and nothing else changes", async () => {
      const branchId = await freshBranch("vektor-la");
      await testDb`update tenants set timezone = 'America/Los_Angeles' where id = ${T()}`;
      try {
        await seedVector(branchId);
        const out = await expectOk(
          await getOverview(owner(), T(), {
            month: "2026-09-01",
            branchId,
            referenceDate: "2026-09-15",
          }),
        );
        expect(out.byCurrency[0]).toMatchObject({
          currency: "TRY",
          incurred: 13100,
          paid: 11000,
          outstanding: { total: 2900, count: 3 },
        });
        const previous = await expectOk(
          await getOverview(owner(), T(), {
            month: "2026-08-01",
            branchId,
            referenceDate: "2026-09-15",
          }),
        );
        expect(previous.byCurrency[0]).toMatchObject({ paid: 400 });
      } finally {
        await testDb`update tenants set timezone = 'Europe/Istanbul' where id = ${T()}`;
      }
    });
  });

  it("R8 reference-date boundaries: due today is upcoming not overdue, +14 is upcoming, +15 is neither, no due date stays in outstanding only", async () => {
    const branchId = await freshBranch("sinir");
    await bulkInsert(branchId, [
      {
        date: "2026-09-01",
        description: "dun",
        due: "2026-09-14",
        amount: 100,
      },
      {
        date: "2026-09-01",
        description: "bugun",
        due: "2026-09-15",
        amount: 200,
      },
      {
        date: "2026-09-01",
        description: "artı14",
        due: "2026-09-29",
        amount: 400,
      },
      {
        date: "2026-09-01",
        description: "artı15",
        due: "2026-09-30",
        amount: 800,
      },
      { date: "2026-09-01", description: "vadesiz", due: null, amount: 1600 },
    ]);
    const out = await expectOk(
      await getOverview(owner(), T(), {
        month: "2026-09-01",
        branchId,
        referenceDate: "2026-09-15",
      }),
    );
    expect(out.byCurrency[0]).toMatchObject({
      outstanding: { total: 3100, count: 5 },
      overdue: { total: 100, count: 1 },
      upcoming: { total: 600, count: 2 },
    });
  });

  it("R9 currencies are separate entries, the primary currency first even at zero, never summed", async () => {
    const branchId = await freshBranch("para");
    await makeExpense(world, {
      branchId,
      amount: 100,
      expenseDate: "2026-09-02",
    });
    await testDb`update tenants set currency = 'EUR' where id = ${T()}`;
    try {
      await makeExpense(world, {
        branchId,
        amount: 50,
        expenseDate: "2026-09-02",
      });
      const eurPrimary = await expectOk(
        await getOverview(owner(), T(), {
          month: "2026-09-01",
          branchId,
          referenceDate: "2026-09-15",
        }),
      );
      expect(eurPrimary.primaryCurrency).toBe("EUR");
      expect(
        eurPrimary.byCurrency.map((c) => [c.currency, c.incurred]),
      ).toEqual([
        ["EUR", 50],
        ["TRY", 100],
      ]);
      // a primary currency with nothing in scope still appears first, with zeros
      const zeroPrimary = await expectOk(
        await getOverview(owner(), T(), {
          month: "2020-01-01",
          branchId,
          referenceDate: "2026-09-15",
        }),
      );
      expect(zeroPrimary.byCurrency[0]).toMatchObject({
        currency: "EUR",
        incurred: 0,
        paid: 0,
      });
      expect(zeroPrimary.byCurrency.map((c) => c.currency)).toEqual([
        "EUR",
        "TRY",
      ]); // TRY still has an outstanding row
    } finally {
      await testDb`update tenants set currency = 'TRY' where id = ${T()}`;
    }
  });

  it("R10 overview and list agree for each branch, for Genel, and for all", async () => {
    const a = await freshBranch("parite-a");
    const b = await freshBranch("parite-b");
    await bulkInsert(a, [
      { date: "2026-09-02", description: "pa1", amount: 100 },
      { date: "2026-09-03", description: "pa2", amount: 50 },
    ]);
    await bulkInsert(b, [
      { date: "2026-09-04", description: "pb1", amount: 70 },
    ]);
    for (const scope of [{ branchId: a }, { branchId: b }]) {
      const list = await expectOk(
        await listExpenses(owner(), { tenantId: T(), ...scope, limit: 100 }),
      );
      const overview = await expectOk(
        await getOverview(owner(), T(), {
          month: "2026-09-01",
          ...scope,
          referenceDate: "2026-09-15",
        }),
      );
      const sum = list.items.reduce((acc, i) => acc + Number(i.amount), 0);
      expect(overview.byCurrency[0]!.incurred).toBe(sum);
      expect(overview.byCurrency[0]!.outstanding.total).toBe(sum);
      expect(overview.byCurrency[0]!.outstanding.count).toBe(list.items.length);
    }
    const generalList = await expectOk(
      await listExpenses(owner(), {
        tenantId: T(),
        generalOnly: true,
        limit: 100,
        fromDate: "2026-09-01",
        toDate: "2026-09-30",
      }),
    );
    const generalOverview = await expectOk(
      await getOverview(owner(), T(), {
        month: "2026-09-01",
        generalOnly: true,
        referenceDate: "2026-09-15",
      }),
    );
    expect(generalOverview.byCurrency[0]!.incurred).toBe(
      generalList.items.reduce(
        (acc, i) => acc + (i.status === "cancelled" ? 0 : Number(i.amount)),
        0,
      ),
    );
  });

  it("R12 the reference date defaults to the tenant-local date and an explicit value overrides it", async () => {
    const branchId = await freshBranch("referans");
    const today = await tenantToday(T());
    const byDefault = await expectOk(
      await getOverview(owner(), T(), { branchId }),
    );
    expect(byDefault.referenceDate).toBe(today);
    expect(byDefault.month).toBe(`${today.slice(0, 7)}-01`);
    const explicit = await expectOk(
      await getOverview(owner(), T(), {
        branchId,
        referenceDate: "2026-02-20",
      }),
    );
    expect(explicit.referenceDate).toBe("2026-02-20");
    expect(explicit.month).toBe("2026-02-01");
  });

  it("R13 the reference date never reconstructs history: only overdue/upcoming classification changes", async () => {
    const branchId = await freshBranch("tarihce");
    const e = await makeExpense(world, {
      branchId,
      amount: 1000,
      expenseDate: "2026-09-01",
      dueDate: "2026-09-10",
      description: "tarihce",
    });
    await makePayment(world, e.expenseId, 300);
    const read = async (referenceDate: string) => {
      const o = await expectOk(
        await getOverview(owner(), T(), {
          month: "2026-09-01",
          branchId,
          referenceDate,
        }),
      );
      const d = await expectOk(
        await getExpense(owner(), e.expenseId, referenceDate),
      );
      return { o: o.byCurrency[0]!, d };
    };
    const before = await read("2026-09-05"); // not yet due
    const after = await read("2026-09-20"); // overdue
    for (const r of [before, after]) {
      expect(r.o).toMatchObject({
        incurred: 1000,
        paid: expect.any(Number),
        outstanding: { total: 700, count: 1 },
      });
      expect(r.d).toMatchObject({
        status: "partially_paid",
        paid: 300,
        outstanding: 700,
      });
    }
    expect(before.d).toMatchObject({ isOverdue: false, daysOverdue: null });
    expect(after.d).toMatchObject({ isOverdue: true, daysOverdue: 10 });
    expect(before.o.overdue.count).toBe(0);
    expect(after.o.overdue).toMatchObject({ total: 700, count: 1 });
    expect(before.o.upcoming.count).toBe(1); // 2026-09-10 is within 14 days of 2026-09-05
    expect(after.o.upcoming.count).toBe(0);
  });

  it("R14 the overview excludes cancelled expenses and voided payments", async () => {
    const branchId = await freshBranch("dislama");
    const live = await makeExpense(world, {
      branchId,
      amount: 100,
      expenseDate: "2026-09-02",
    });
    const p = await makePayment(world, live.expenseId, 60, {
      paidAt: "2026-09-03T12:00:00Z",
    });
    await expectOk(await voidPayment(owner(), p.paymentId!, "yanlis"));
    const dead = await makeExpense(world, {
      branchId,
      amount: 900,
      expenseDate: "2026-09-02",
    });
    await expectOk(await cancelExpense(owner(), dead.expenseId, "iptal"));
    const out = await expectOk(
      await getOverview(owner(), T(), {
        month: "2026-09-01",
        branchId,
        referenceDate: "2026-09-15",
      }),
    );
    expect(out.byCurrency[0]).toMatchObject({
      incurred: 100,
      paid: 0,
      outstanding: { total: 100, count: 1 },
    });
  });

  it("R15 overdue flags: a partially paid past-due expense is overdue with the right days; paid and cancelled expenses never are", async () => {
    const branchId = await freshBranch("gecikme");
    const partial = await makeExpense(world, {
      branchId,
      amount: 100,
      expenseDate: "2026-09-01",
      dueDate: "2026-09-01",
      description: "kismi gecikmis",
    });
    await makePayment(world, partial.expenseId, 10);
    const paid = await makeExpense(world, {
      branchId,
      amount: 100,
      expenseDate: "2026-09-01",
      dueDate: "2026-09-01",
      description: "odenmis",
    });
    await makePayment(world, paid.expenseId, 100);
    const cancelled = await makeExpense(world, {
      branchId,
      amount: 100,
      expenseDate: "2026-09-01",
      dueDate: "2026-09-01",
      description: "iptal edilmis",
    });
    await expectOk(await cancelExpense(owner(), cancelled.expenseId, "iptal"));
    const ref = "2026-09-15";
    expect(
      await expectOk(await getExpense(owner(), partial.expenseId, ref)),
    ).toMatchObject({ isOverdue: true, daysOverdue: 14 });
    expect(
      await expectOk(await getExpense(owner(), paid.expenseId, ref)),
    ).toMatchObject({ isOverdue: false, daysOverdue: null });
    expect(
      await expectOk(await getExpense(owner(), cancelled.expenseId, ref)),
    ).toMatchObject({ isOverdue: false, daysOverdue: null });
    const list = await expectOk(
      await listExpenses(owner(), {
        tenantId: T(),
        branchId,
        includeCancelled: true,
        referenceDate: ref,
      }),
    );
    const flags = Object.fromEntries(
      list.items.map((i) => [i.description as string, i.isOverdue]),
    );
    expect(flags).toEqual({
      "kismi gecikmis": true,
      odenmis: false,
      "iptal edilmis": false,
    });
  });

  it("R16 month handling: any date in a month selects that month, out-of-range is FN004, the default is the reference date's month", async () => {
    const branchId = await freshBranch("ay");
    const mid = await expectOk(
      await getOverview(owner(), T(), {
        month: "2026-09-17",
        branchId,
        referenceDate: "2026-12-01",
      }),
    );
    expect(mid.month).toBe("2026-09-01");
    const def = await expectOk(
      await getOverview(owner(), T(), {
        branchId,
        referenceDate: "2026-12-31",
      }),
    );
    expect(def.month).toBe("2026-12-01");
    for (const month of ["1999-12-31", "2101-01-01"])
      expect(
        failure(await getOverview(owner(), T(), { month, branchId })),
      ).toBe("FN004");
    for (const referenceDate of ["1999-12-31", "2101-01-01"])
      expect(
        failure(await getOverview(owner(), T(), { branchId, referenceDate })),
      ).toBe("FN004");
  });

  it("R17 a branch together with general-only is FN004 on both the overview and the list", async () => {
    const branchId = await freshBranch("celisen");
    expect(
      failure(await getOverview(owner(), T(), { branchId, generalOnly: true })),
    ).toBe("FN004");
    expect(
      failure(
        await listExpenses(owner(), {
          tenantId: T(),
          branchId,
          generalOnly: true,
        }),
      ),
    ).toBe("FN004");
  });

  it("R18 a cancelled expense shows paid 0, outstanding 0 and locked flags; payments are ordered by paid_at then creation", async () => {
    const branchId = await freshBranch("iptal-detay");
    const c = await makeExpense(world, { branchId, amount: 300 });
    const p = await makePayment(world, c.expenseId, 100);
    await expectOk(await voidPayment(owner(), p.paymentId!, "yanlis"));
    await expectOk(await cancelExpense(owner(), c.expenseId, "yanlis giris"));
    expect(
      await expectOk(await getExpense(owner(), c.expenseId)),
    ).toMatchObject({
      status: "cancelled",
      paid: 0,
      outstanding: 0,
      amountFloor: 0,
      canCancel: false,
      structureLocked: true,
      cancelReason: "yanlis giris",
    });
    const e = await makeExpense(world, { branchId, amount: 1000 });
    const late = await makePayment(world, e.expenseId, 10, {
      paidAt: "2026-09-05T10:00:00Z",
    });
    const early = await makePayment(world, e.expenseId, 20, {
      paidAt: "2026-09-01T10:00:00Z",
    });
    const mid = await makePayment(world, e.expenseId, 30, {
      paidAt: "2026-09-03T10:00:00Z",
    });
    const order = (
      await expectOk(await getExpense(owner(), e.expenseId))
    ).payments.map((x) => x.id);
    expect(order).toEqual([early.paymentId, mid.paymentId, late.paymentId]);
  });
});

describe("A audit (reads)", () => {
  it("A9 the read RPCs write nothing: every expense row, payment row and audit row is byte-identical afterwards", async () => {
    const branchId = await freshBranch("okuma");
    const e = await makeExpense(world, { branchId, amount: 100 });
    await makePayment(world, e.expenseId, 40);
    const allAudit = async () => {
      const [row] = await testDb<
        { n: string }[]
      >`select count(*)::text as n from audit_logs where tenant_id = ${T()}`;
      return Number(row!.n);
    };
    const digest = await tenantDigest(T());
    const audits = await allAudit();
    await expectOk(await listCategories(owner(), T()));
    await expectOk(await getOverview(owner(), T(), { branchId }));
    await expectOk(await listExpenses(owner(), { tenantId: T(), branchId }));
    await expectOk(await getExpense(owner(), e.expenseId));
    expect(await tenantDigest(T())).toBe(digest);
    expect(await allAudit()).toBe(audits);
  });
});
