import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createExpenseWorld,
  destroyExpenseWorld,
  makeExpense,
  makePayment,
  instantAgo,
  type ExpenseWorld,
} from "./expense-fixtures";

/**
 * Faz FIN.1B.1 — pure helper vectors (matrix group HLP). The private helpers are called directly through testDb (the
 * owner connection): they carry no API-role grant, which expense-schema-and-security.test.ts proves separately.
 *
 * NOTE for whoever runs this file next: like every FIN DB file it needs migration 20261003090000 applied to whatever
 * TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV database), and it
 * fails loudly when it is not.
 */

let world: ExpenseWorld;

beforeAll(async () => {
  world = await createExpenseWorld("fin1b1-hlp");
});

afterAll(async () => {
  await destroyExpenseWorld(world);
});

async function amountOf(
  raw: string | null,
): Promise<
  { ok: true; value: string } | { ok: false; code: string | undefined }
> {
  try {
    const [row] = await testDb<
      { v: string }[]
    >`select private.normalize_expense_amount(${raw}::numeric)::text as v`;
    return { ok: true, value: row!.v };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code };
  }
}

describe("HLP1 compute_expense_status truth table", () => {
  it.each([
    [1000, null, "open"],
    [1000, 0, "open"],
    [1000, -5, "open"],
    [1000, 0.01, "partially_paid"],
    [1000, 999.99, "partially_paid"],
    [1000, 1000, "paid"],
    [1000, 1000.01, "paid"],
    [0.05, 0.05, "paid"],
  ])("amount %s posted %s gives %s", async (amount, posted, expected) => {
    const [row] = await testDb<
      { s: string }[]
    >`select private.compute_expense_status(${amount}::numeric, ${posted}::numeric) as s`;
    expect(row!.s).toBe(expected);
  });
});

describe("HLP2 normalize_expense_amount", () => {
  it.each([
    ["0.01", "0.01"],
    ["1", "1.00"],
    ["250.5", "250.50"],
    ["250.50", "250.50"],
    ["250.500", "250.50"],
    ["9999999999.99", "9999999999.99"],
  ])("valid %s returns %s as numeric(12,2)", async (raw, expected) => {
    expect(await amountOf(raw)).toEqual({ ok: true, value: expected });
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
  ])("invalid %s raises FN004", async (raw) => {
    expect(await amountOf(raw)).toEqual({ ok: false, code: "FN004" });
  });
});

describe("HLP3 normalize_expense_text", () => {
  const textOf = async (raw: string | null) => {
    const [row] = await testDb<
      { v: string | null }[]
    >`select private.normalize_expense_text(${raw}) as v`;
    return row!.v;
  };

  it("trims space, tab, CR and LF at both ends only", async () => {
    expect(await textOf("  Kira  ")).toBe("Kira");
    expect(await textOf("\t\r\n Kira \n\t")).toBe("Kira");
  });

  it("keeps inner whitespace, case and Unicode", async () => {
    expect(await textOf("  Ekim   Kirası  ÇŞĞİ ")).toBe("Ekim   Kirası  ÇŞĞİ");
    expect(await textOf("a\tb")).toBe("a\tb");
  });

  it("turns blank into null", async () => {
    expect(await textOf("")).toBeNull();
    expect(await textOf("   ")).toBeNull();
    expect(await textOf("\t\r\n")).toBeNull();
    expect(await textOf(null)).toBeNull();
  });
});

// --- fingerprint ----------------------------------------------------------------------------------------------

type FpInput = {
  branchId: string | null;
  categoryKey: string;
  expenseDate: string;
  dueDate: string | null;
  amount: string; // already numeric(12,2) text
  description: string;
  vendor: string | null;
  note: string | null;
  ipAmount: string | null;
  ipMethod: string | null;
  ipPaidAt: string | null; // 'YYYY-MM-DDTHH:MM:SS.ffffffZ'
  ipNote: string | null;
};

/** Independent reference implementation of the canonical form (FIN-1B1 plan §E1): 13 components, each rendered as
 * <code-point length>:<value>, joined with '|', hashed with md5. */
function referenceFingerprint(i: FpInput): string {
  const components = [
    "expense.create.v1",
    i.branchId ?? "GENERAL",
    i.categoryKey,
    i.expenseDate,
    i.dueDate ?? "NO_DUE",
    i.amount,
    i.description,
    i.vendor ?? "",
    i.note ?? "",
    i.ipAmount ?? "",
    i.ipMethod ?? "",
    i.ipPaidAt ? i.ipPaidAt.replace(/Z$/, "") : "",
    i.ipNote ?? "",
  ];
  expect(components).toHaveLength(13);
  return createHash("md5")
    .update(components.map((v) => `${[...v].length}:${v}`).join("|"), "utf8")
    .digest("hex");
}

async function sqlFingerprint(i: FpInput): Promise<string> {
  const [row] = await testDb<{ f: string }[]>`
    select private.expense_create_fingerprint(
      ${i.branchId}::uuid, ${i.categoryKey}, ${i.expenseDate}::date, ${i.dueDate}::date, ${i.amount}::numeric,
      ${i.description}, ${i.vendor}, ${i.note}, ${i.ipAmount}::numeric, ${i.ipMethod}, ${i.ipPaidAt}::text::timestamptz, ${i.ipNote}
    ) as f`;
  return row!.f;
}

const BASE: FpInput = {
  branchId: "00000000-0000-4000-8000-000000000001",
  categoryKey: "cleaning",
  expenseDate: "2026-10-03",
  dueDate: "2026-10-10",
  amount: "1000.00",
  description: "Temizlik malzemesi",
  vendor: "Tedarikçi A.Ş.",
  note: "not",
  ipAmount: "400.00",
  ipMethod: "cash",
  ipPaidAt: "2026-10-03T09:15:30.123456Z",
  ipNote: "peşin",
};

describe("HLP4 fingerprint golden vectors and reference equality", () => {
  const golden: [string, FpInput, string][] = [
    [
      "GV1",
      {
        branchId: null,
        categoryKey: "rent",
        expenseDate: "2026-10-01",
        dueDate: "2026-10-05",
        amount: "10000.00",
        description: "Ekim kirası",
        vendor: "Mülk Sahibi",
        note: null,
        ipAmount: null,
        ipMethod: null,
        ipPaidAt: null,
        ipNote: null,
      },
      "6438c36b68a6e6981a9f6a2e9d46ec2c",
    ],
    [
      "GV2",
      {
        branchId: "00000000-0000-4000-8000-000000000001",
        categoryKey: "cleaning",
        expenseDate: "2026-10-03",
        dueDate: null,
        amount: "1000.00",
        description: "Temizlik | malzeme",
        vendor: null,
        note: "not",
        ipAmount: "400.00",
        ipMethod: "cash",
        ipPaidAt: "2026-10-03T09:15:30.123456Z",
        ipNote: null,
      },
      "fcf31798fc44a8a996fdc07b29b5a1ae",
    ],
    [
      "GV3",
      {
        branchId: null,
        categoryKey: "other",
        expenseDate: "2026-10-03",
        dueDate: null,
        amount: "0.05",
        description: "Çay ve şeker",
        vendor: null,
        note: null,
        ipAmount: null,
        ipMethod: null,
        ipPaidAt: null,
        ipNote: null,
      },
      "b83e8adaf5ac62804db92e1d191f170c",
    ],
  ];

  it.each(golden)(
    "%s produces the frozen md5 in SQL and in the reference implementation",
    async (_name, input, expected) => {
      expect(referenceFingerprint(input)).toBe(expected);
      expect(await sqlFingerprint(input)).toBe(expected);
    },
  );

  it("matches the independent reference on generated vectors (pipes, Unicode, null variants, microsecond instants)", async () => {
    // Deterministic PRNG so a failure reproduces.
    let state = 0x9e3779b9;
    const rnd = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const words = [
      "Kira",
      "Elektrik | su",
      "Çay",
      "şeker",
      "İnternet",
      "a|b|c",
      "0:",
      "ÖĞLE",
      "emoji 🙂",
      "  inner   spaces ",
      "x".repeat(40),
    ];
    const cats = [
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
    const methods = ["cash", "card", "bank_transfer", "other"];
    const cents = () => Math.floor(rnd() * 99_999_999_99) + 1;
    const money = (c: number) =>
      `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
    const date = () =>
      `20${20 + Math.floor(rnd() * 8)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;

    for (let n = 0; n < 24; n++) {
      const hasIp = rnd() < 0.5;
      const input: FpInput = {
        branchId:
          rnd() < 0.5
            ? null
            : `${Math.floor(rnd() * 0xffffffff)
                .toString(16)
                .padStart(8, "0")}-0000-4000-8000-000000000002`,
        categoryKey: pick(cats),
        expenseDate: date(),
        dueDate: rnd() < 0.5 ? null : "2099-12-31",
        amount: money(cents()),
        description: pick(words) + (rnd() < 0.5 ? "" : ` ${n}`),
        vendor: rnd() < 0.5 ? null : pick(words),
        note: rnd() < 0.5 ? null : pick(words),
        ipAmount: hasIp ? money(cents()) : null,
        ipMethod: hasIp ? pick(methods) : null,
        ipPaidAt: hasIp
          ? `${date()}T${String(Math.floor(rnd() * 24)).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}.${String(Math.floor(rnd() * 1_000_000)).padStart(6, "0")}Z`
          : null,
        ipNote: hasIp && rnd() < 0.5 ? pick(words) : null,
      };
      expect(
        await sqlFingerprint(input),
        `vector ${n}: ${JSON.stringify(input)}`,
      ).toBe(referenceFingerprint(input));
    }
  });

  it("renders the same instant written with different offsets identically", async () => {
    const a = await testDb<
      { f: string }[]
    >`select private.expense_create_fingerprint(null, 'rent', date '2026-10-01', null, 10::numeric, 'x', null, null, 5::numeric, 'cash', timestamptz '2026-10-03T10:00:00Z', null) as f`;
    const b = await testDb<
      { f: string }[]
    >`select private.expense_create_fingerprint(null, 'rent', date '2026-10-01', null, 10::numeric, 'x', null, null, 5::numeric, 'cash', timestamptz '2026-10-03T13:00:00+03:00', null) as f`;
    expect(a[0]!.f).toBe(b[0]!.f);
  });
});

describe("HLP5 fingerprint sensitivity: every payload component participates", () => {
  const variants: [string, Partial<FpInput>][] = [
    ["branch", { branchId: "00000000-0000-4000-8000-000000000009" }],
    ["category", { categoryKey: "rent" }],
    ["expense date", { expenseDate: "2026-10-04" }],
    ["due date", { dueDate: "2026-10-11" }],
    ["amount", { amount: "1000.01" }],
    ["description", { description: "Temizlik malzemesi!" }],
    ["vendor", { vendor: "Tedarikçi B" }],
    ["note", { note: "not2" }],
    ["initial amount", { ipAmount: "400.01" }],
    ["initial method", { ipMethod: "card" }],
    [
      "initial paid_at (1 microsecond)",
      { ipPaidAt: "2026-10-03T09:15:30.123457Z" },
    ],
    ["initial note", { ipNote: "peşin2" }],
  ];

  it("has exactly 12 payload components under test", () => {
    expect(variants).toHaveLength(12);
  });

  it.each(variants)(
    "changing only the %s changes the hash",
    async (_name, change) => {
      const base = await sqlFingerprint(BASE);
      expect(await sqlFingerprint({ ...BASE, ...change })).not.toBe(base);
    },
  );

  it("null and non-null forms differ for every optional component", async () => {
    const base = await sqlFingerprint(BASE);
    for (const key of [
      "branchId",
      "dueDate",
      "vendor",
      "note",
      "ipAmount",
      "ipMethod",
      "ipPaidAt",
      "ipNote",
    ] as const) {
      expect(await sqlFingerprint({ ...BASE, [key]: null }), key).not.toBe(
        base,
      );
    }
  });
});

describe("HLP6 tenant_local_date", () => {
  it.each(["Europe/Istanbul", "Europe/Nicosia", "America/Los_Angeles"])(
    "equals (now() at time zone tenants.timezone)::date for %s",
    async (tz) => {
      await testDb`update tenants set timezone = ${tz} where id = ${world.tenant.id}`;
      const [row] = await testDb<{ got: string; expected: string }[]>`
      select to_char(private.tenant_local_date(${world.tenant.id}), 'YYYY-MM-DD') as got,
             to_char((now() at time zone (select timezone from tenants where id = ${world.tenant.id}))::date, 'YYYY-MM-DD') as expected`;
      expect(row!.got).toBe(row!.expected);
      await testDb`update tenants set timezone = 'Europe/Istanbul' where id = ${world.tenant.id}`;
    },
  );
});

describe("HLP7 normalize_expense_payment_input", () => {
  async function norm(
    amount: string | null,
    method: string | null,
    paidAt: string | null,
    note: string | null,
  ) {
    try {
      const [row] = await testDb<{ v: Record<string, unknown> }[]>`
        select private.normalize_expense_payment_input(${amount}::numeric, ${method}, ${paidAt}::text::timestamptz, ${note}) as v`;
      return { ok: true as const, value: row!.v };
    } catch (error) {
      return { ok: false as const, code: (error as { code?: string }).code };
    }
  }

  it("normalizes a valid payment (trimmed note, UTC microsecond instant)", async () => {
    const out = await norm(
      "250.5",
      "cash",
      "2026-10-02T09:15:30.123456Z",
      "  peşin  ",
    );
    expect(out).toEqual({
      ok: true,
      value: {
        amount: 250.5,
        method: "cash",
        paid_at: "2026-10-02T09:15:30.123456Z",
        note: "peşin",
      },
    });
  });

  it("turns a blank note into null", async () => {
    const out = await norm("1", "card", "2026-10-02T09:00:00Z", "   ");
    expect(out.ok && out.value.note).toBeNull();
  });

  it.each([[null], ["cheque"], [""]])(
    "method %s raises FN006",
    async (method) => {
      expect(await norm("1", method, "2026-10-02T09:00:00Z", null)).toEqual({
        ok: false,
        code: "FN006",
      });
    },
  );

  it("raises FN004 for a bad amount, a null or too-early paid_at, or a note over 500 chars", async () => {
    expect(await norm("0", "cash", "2026-10-02T09:00:00Z", null)).toEqual({
      ok: false,
      code: "FN004",
    });
    expect(await norm("1", "cash", null, null)).toEqual({
      ok: false,
      code: "FN004",
    });
    expect(await norm("1", "cash", "1999-12-31T23:59:59Z", null)).toEqual({
      ok: false,
      code: "FN004",
    });
    expect(
      await norm("1", "cash", "2026-10-02T09:00:00Z", "x".repeat(501)),
    ).toEqual({ ok: false, code: "FN004" });
    expect(
      (await norm("1", "cash", "2026-10-02T09:00:00Z", "x".repeat(500))).ok,
    ).toBe(true);
  });

  it("allows now + 59 minutes and rejects now + 61 minutes", async () => {
    const ahead = (m: number) =>
      new Date(Date.now() + m * 60_000).toISOString();
    expect((await norm("1", "cash", ahead(59), null)).ok).toBe(true);
    expect(await norm("1", "cash", ahead(61), null)).toEqual({
      ok: false,
      code: "FN004",
    });
  });
});

describe("HLP8 expense_posted_total", () => {
  it("is 0 with no payments, sums posted rows exactly and ignores voided ones", async () => {
    const e = await makeExpense(world, { amount: 100.1 });
    const total = async () => {
      const [row] = await testDb<
        { t: string }[]
      >`select private.expense_posted_total(${e.expenseId})::text as t`;
      return row!.t;
    };
    expect(await total()).toBe("0.00");
    const p1 = await makePayment(world, e.expenseId, 33.37, {
      paidAt: instantAgo(10),
    });
    await makePayment(world, e.expenseId, 33.37, { paidAt: instantAgo(9) });
    await makePayment(world, e.expenseId, 33.36, { paidAt: instantAgo(8) });
    expect(await total()).toBe("100.10");
    await testDb`update expense_payments set status = 'voided', voided_at = now(), void_reason = 'test' where id = ${p1.paymentId!}`;
    expect(await total()).toBe("66.73");
  });
});
