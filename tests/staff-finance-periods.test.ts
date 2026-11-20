import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createStaffFinanceWorld,
  destroyStaffFinanceWorld,
  createPeriod,
  updatePeriod,
  addLine,
  updateLine,
  voidLine,
  finalizePeriod,
  reopenPeriod,
  cancelPeriod,
  recordPayment,
  voidPayment,
  getPeriod,
  getOverview,
  makePeriod,
  makeLine,
  makePayment,
  validPeriod,
  newStaff,
  expectOk,
  periodRow,
  lineRows,
  paymentRows,
  staffAudit,
  counts,
  tenantDigest,
  periodDigest,
  tenantMonth,
  newKey,
  instantAgo,
  uniqueText,
  DEFAULT_MONTH,
  type StaffFinanceWorld,
  type RpcOutcome,
  type WriteResult,
} from "./staff-finance-fixtures";

/**
 * Faz FIN.1C.1 — the period aggregate (matrix groups V, I, L, C, VR and the period half of A and CUR).
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to
 * whatever TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV
 * database) and fails loudly when they are not.
 */

let world: StaffFinanceWorld;

beforeAll(async () => {
  world = await createStaffFinanceWorld("fin1c1-per");
});

afterAll(async () => {
  await destroyStaffFinanceWorld(world);
});

const T = () => world.tenant.id;
const O = () => world.owner.id;

function failure(out: RpcOutcome<unknown>): string | undefined {
  expect(out.ok, `expected a failure, got ${JSON.stringify(out)}`).toBe(false);
  return out.ok ? undefined : out.code;
}

/** A finalized period: salary 30,000 with 2,500 deducted (net 27,500). */
async function finalizedPeriod() {
  const p = await makePeriod(world);
  await makeLine(p.periodId, "salary", 30000, {}, world.owner);
  await makeLine(p.periodId, "employee_social_insurance", 2500, {}, world.owner);
  const row = await periodRow(p.periodId);
  const f = await expectOk(
    await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: row.version }),
  );
  return { periodId: p.periodId, version: f.version };
}

// =================================================================================================================
// V — create_staff_finance_period validation
// =================================================================================================================
describe("V create_staff_finance_period validation", () => {
  it("V1 a null key (explicit or omitted) and a null tenant are FN004 with zero rows", async () => {
    const before = await counts(T());
    const staff = await newStaff(world);
    expect(
      failure(
        await createPeriod(O(), validPeriod(world, staff.id, { idempotencyKey: null })),
      ),
    ).toBe("FN004");
    expect(
      failure(
        await createPeriod(O(), validPeriod(world, staff.id, { idempotencyKey: undefined })),
      ),
    ).toBe("FN004");
    expect(
      failure(await createPeriod(O(), validPeriod(world, staff.id, { tenantId: null }))),
    ).toBe("FN004");
    expect(await counts(T())).toEqual(before);
  });

  it.each([
    ["2026-09-15"],
    ["2026-09-30"],
    ["1999-12-01"],
    ["2101-01-01"],
    ["2100-12-02"],
    [null],
  ])("V2 month %s is FN004 with zero rows", async (month) => {
    const before = await counts(T());
    const staff = await newStaff(world);
    expect(
      failure(
        await createPeriod(O(), validPeriod(world, staff.id, { periodMonth: month })),
      ),
    ).toBe("FN004");
    expect(await counts(T())).toEqual(before);
  });

  it("V3 a month beyond the tenant-local current month plus one is FN004; the boundary month is accepted", async () => {
    const staff = await newStaff(world);
    const beyond = await tenantMonth(T(), 2);
    const boundary = await tenantMonth(T(), 1);
    const before = await counts(T());
    expect(
      failure(
        await createPeriod(O(), validPeriod(world, staff.id, { periodMonth: beyond })),
      ),
    ).toBe("FN004");
    expect(await counts(T())).toEqual(before);
    const ok = await expectOk(
      await createPeriod(O(), validPeriod(world, staff.id, { periodMonth: boundary })),
    );
    expect((await periodRow(ok.periodId)).period_month).toBe(boundary);
  });

  it("V4 a due date before the month start or after 2100-12-31 is FN004; the month start itself is accepted", async () => {
    const staff = await newStaff(world);
    for (const dueDate of ["2026-08-31", "2101-01-01"]) {
      expect(
        failure(
          await createPeriod(O(), validPeriod(world, staff.id, { periodMonth: "2026-09-01", dueDate })),
        ),
      ).toBe("FN004");
    }
    const ok = await expectOk(
      await createPeriod(
        O(),
        validPeriod(world, staff.id, { periodMonth: "2026-09-01", dueDate: "2026-09-01" }),
      ),
    );
    expect((await periodRow(ok.periodId)).due_date).toBe("2026-09-01");
  });

  it("V5 a missing, foreign or soft-deleted staff member is FN029; a null one is FN004; an inactive one is accepted", async () => {
    for (const id of [
      "00000000-0000-4000-8000-000000000f01",
      world.otherStaff.id,
      world.staffDeleted.id,
    ]) {
      expect(
        failure(await createPeriod(O(), validPeriod(world, id))),
      ).toBe("FN029");
    }
    expect(
      failure(
        await createPeriod(O(), validPeriod(world, "00000000-0000-4000-8000-000000000f01", { staffMemberId: null })),
      ),
    ).toBe("FN004");
    const ok = await expectOk(
      await createPeriod(O(), validPeriod(world, world.staffInactive.id)),
    );
    expect(ok.lifecycle).toBe("open");
  });

  it("V6 a second period for the same staff member and month with a different key is FN028", async () => {
    const staff = await newStaff(world);
    await expectOk(await createPeriod(O(), validPeriod(world, staff.id)));
    const before = await counts(T());
    expect(
      failure(await createPeriod(O(), validPeriod(world, staff.id))),
    ).toBe("FN028");
    expect(await counts(T())).toEqual(before);
  });

  it("V7 a foreign, non-member or nonexistent tenant is FN002 with the same message", async () => {
    const staff = await newStaff(world);
    const calls = [
      await createPeriod(O(), validPeriod(world, staff.id, { tenantId: world.otherTenant.id })),
      await createPeriod(world.stranger.id, validPeriod(world, staff.id)),
      await createPeriod(O(), validPeriod(world, staff.id, { tenantId: "00000000-0000-4000-8000-000000000a02" })),
    ];
    const messages = calls.map((c) => {
      expect(failure(c)).toBe("FN002");
      return c.ok ? "" : c.message;
    });
    expect(new Set(messages).size).toBe(1);
  });

  it("V8 / CUR1 the currency is the tenant's and the display name the trimmed full_name", async () => {
    const [row] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${T()}, ${"  Zeynep Kaya  "}) returning id`;
    const p = await makePeriod(world, { staffMemberId: row!.id });
    const stored = await periodRow(p.periodId);
    expect(stored.staff_display_name).toBe("Zeynep Kaya");
    const [t] = await testDb<{ currency: string }[]>`select currency from tenants where id = ${T()}`;
    expect(stored.currency).toBe(t!.currency);
    expect(stored.created_by).toBe(O());
  });

  it("CUR4 a tenant currency change affects new periods only; the overview then shows both currencies", async () => {
    const [orig] = await testDb<{ currency: string }[]>`select currency from tenants where id = ${T()}`;
    const a = await makePeriod(world);
    await makeLine(a.periodId, "salary", 1000, {}, world.owner);
    try {
      await testDb`update tenants set currency = 'USD' where id = ${T()}`;
      const b = await makePeriod(world);
      await makeLine(b.periodId, "salary", 2000, {}, world.owner);
      expect((await periodRow(a.periodId)).currency).toBe(orig!.currency);
      expect((await periodRow(b.periodId)).currency).toBe("USD");
      const ov = await expectOk(await getOverview(O(), { tenantId: T(), month: DEFAULT_MONTH }));
      expect(ov.primaryCurrency).toBe("USD");
      const byCur = Object.fromEntries(ov.byCurrency.map((c) => [c.currency, c]));
      expect(byCur["USD"]!.grossEntitlement).toBeGreaterThanOrEqual(2000);
      expect(byCur[orig!.currency]!.grossEntitlement).toBeGreaterThanOrEqual(1000);
    } finally {
      await testDb`update tenants set currency = ${orig!.currency} where id = ${T()}`;
    }
  });

  it("V24 a null (or omitted) expected version is FN004 for update period, finalize and reopen", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 100, {}, world.owner);
    const before = await periodDigest(p.periodId);
    expect(
      failure(await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-10-05", expectedVersion: null })),
    ).toBe("FN004");
    expect(
      failure(await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-10-05" })),
    ).toBe("FN004");
    expect(failure(await finalizePeriod(O(), { periodId: p.periodId }))).toBe("FN004");
    expect(
      failure(await reopenPeriod(O(), { periodId: p.periodId, reason: "x", expectedVersion: null })),
    ).toBe("FN004");
    expect(await periodDigest(p.periodId)).toBe(before);
  });

  it("V25 an update with an invalid due date is FN004", async () => {
    const p = await makePeriod(world);
    for (const dueDate of ["2026-08-31", "2101-01-01"]) {
      expect(
        failure(await updatePeriod(O(), { periodId: p.periodId, dueDate, expectedVersion: 1 })),
      ).toBe("FN004");
    }
  });

  it("V23 cancel and reopen: a blank or over-500 reason is FN004, checked AFTER the already-in-target-state no-op", async () => {
    const open = await makePeriod(world);
    // reopen on an open period: noop whatever the (non-null) reason is
    const noop = await expectOk(
      await reopenPeriod(O(), { periodId: open.periodId, reason: "   ", expectedVersion: 1 }),
    );
    expect(noop.noop).toBe(true);
    // cancel on an open period: the reason is validated
    for (const reason of ["   ", "", "\t\n", "x".repeat(501)]) {
      expect(failure(await cancelPeriod(O(), open.periodId, reason))).toBe("FN004");
    }
    expect(failure(await cancelPeriod(O(), open.periodId, null))).toBe("FN004");
    // finalized: reopen validates the reason
    const fin = await finalizedPeriod();
    for (const reason of ["   ", "x".repeat(501)]) {
      expect(
        failure(await reopenPeriod(O(), { periodId: fin.periodId, reason, expectedVersion: fin.version })),
      ).toBe("FN004");
    }
    // already cancelled: the reason is not re-validated
    await expectOk(await cancelPeriod(O(), open.periodId, "iptal"));
    const again = await expectOk(await cancelPeriod(O(), open.periodId, "   "));
    expect(again.noop).toBe(true);
  });
});

// =================================================================================================================
// I — create idempotency
// =================================================================================================================
describe("I create idempotency", () => {
  it("I1 a replay (same key, same payload) is a noop with the same ids and zero writes and zero audit", async () => {
    const staff = await newStaff(world);
    const input = validPeriod(world, staff.id, { dueDate: "2026-10-05" });
    const first = await expectOk(await createPeriod(O(), input));
    expect(first.noop).toBe(false);
    expect(first.version).toBe(1);
    const digest = await tenantDigest(T());
    const again = await expectOk(await createPeriod(O(), input));
    expect(again).toEqual({ ...first, noop: true });
    expect(await tenantDigest(T())).toBe(digest);
  });

  it("I2a-d the same key with a different staff member, month, due date, or a due date set versus absent is FN007", async () => {
    const staff = await newStaff(world);
    const other = await newStaff(world);
    const key = newKey();
    const base = validPeriod(world, staff.id, { idempotencyKey: key, dueDate: "2026-10-05" });
    await expectOk(await createPeriod(O(), base));
    const digest = await tenantDigest(T());
    const variants = [
      { ...base, staffMemberId: other.id }, // I2a
      { ...base, periodMonth: "2026-08-01", dueDate: "2026-10-05" }, // I2b
      { ...base, dueDate: "2026-10-06" }, // I2c
      { ...base, dueDate: null }, // I2d (set versus absent)
    ];
    for (const v of variants) {
      expect(failure(await createPeriod(O(), v))).toBe("FN007");
    }
    expect(await tenantDigest(T())).toBe(digest);
    const absent = validPeriod(world, other.id, { idempotencyKey: newKey(), dueDate: null });
    await expectOk(await createPeriod(O(), absent));
    expect(failure(await createPeriod(O(), { ...absent, dueDate: "2026-10-05" }))).toBe("FN007");
  });

  it("I3 a replay after the period was edited, finalized, paid or cancelled is a noop (stored fingerprint)", async () => {
    const staff = await newStaff(world);
    const input = validPeriod(world, staff.id, { dueDate: "2026-10-05" });
    const created = await expectOk(await createPeriod(O(), input));
    const replayIs = async () => {
      const r = await expectOk(await createPeriod(O(), input));
      expect(r.noop).toBe(true);
      expect(r.periodId).toBe(created.periodId);
      return r;
    };
    await expectOk(
      await updatePeriod(O(), { periodId: created.periodId, dueDate: "2026-10-20", expectedVersion: 1 }),
    );
    await replayIs();
    await makeLine(created.periodId, "salary", 1000, {}, world.owner);
    await makePayment(created.periodId, 400, {}, world.owner);
    await replayIs();
    const v = (await periodRow(created.periodId)).version;
    await expectOk(await finalizePeriod(O(), { periodId: created.periodId, expectedVersion: v }));
    expect((await replayIs()).lifecycle).toBe("finalized");
    // cancel needs no posted payment: void the payment, reopen is not required (finalized can be cancelled)
    const pay = (await paymentRows(created.periodId))[0]!;
    await expectOk(await voidPayment(O(), pay.id, "iptal"));
    await expectOk(await cancelPeriod(O(), created.periodId, "iptal"));
    expect((await replayIs()).lifecycle).toBe("cancelled");
  });

  it("I4 a replay after the staff member was soft-deleted is still a noop (no mutable-state re-validation)", async () => {
    const staff = await newStaff(world);
    const input = validPeriod(world, staff.id);
    const created = await expectOk(await createPeriod(O(), input));
    await testDb`update staff_members set deleted_at = now() where id = ${staff.id}`;
    const again = await expectOk(await createPeriod(O(), input));
    expect(again.noop).toBe(true);
    expect(again.periodId).toBe(created.periodId);
  });

  it("I5 / I6 a different key for the same staff member and month: FN028 while active, accepted after a cancel", async () => {
    const staff = await newStaff(world);
    const first = await expectOk(await createPeriod(O(), validPeriod(world, staff.id)));
    expect(failure(await createPeriod(O(), validPeriod(world, staff.id)))).toBe("FN028");
    await expectOk(await cancelPeriod(O(), first.periodId, "yanlış dönem"));
    const second = await expectOk(await createPeriod(O(), validPeriod(world, staff.id)));
    expect(second.periodId).not.toBe(first.periodId);
    expect(second.noop).toBe(false);
  });

  it("I13 the same key in two different tenants succeeds in both (the key is tenant-scoped)", async () => {
    const key = newKey();
    const a = await expectOk(
      await createPeriod(O(), validPeriod(world, world.staffA.id, { idempotencyKey: key, periodMonth: "2026-03-01" })),
    );
    const b = await expectOk(
      await createPeriod(world.otherOwner.id, {
        tenantId: world.otherTenant.id,
        staffMemberId: world.otherStaff.id,
        periodMonth: "2026-03-01",
        idempotencyKey: key,
      }),
    );
    expect(a.periodId).not.toBe(b.periodId);
    expect(a.noop).toBe(false);
    expect(b.noop).toBe(false);
  });

  it("I15 raw SQL cannot update the stored idempotency key or fingerprint (FN032)", async () => {
    const p = await makePeriod(world);
    for (const [column, value] of [
      ["idempotency_key", "11111111-1111-4111-8111-111111111111"],
      ["idempotency_fingerprint", "0".repeat(32)],
    ] as const) {
      await expect(
        testDb.unsafe(`update staff_finance_periods set ${column} = '${value}' where id = '${p.periodId}'`),
      ).rejects.toMatchObject({ code: "FN032" });
    }
  });
});

// =================================================================================================================
// L / C — lifecycle: the cancelled matrix, due date, finalize, reopen, cancel
// =================================================================================================================
describe("L C lifecycle", () => {
  it("L11 a cancelled period refuses W6, W7, W8, W9, W10, W11 and W13 with FN025 and zero writes; W12 and W14 are noops", async () => {
    const p = await makePeriod(world);
    const line = await makeLine(p.periodId, "salary", 1000, {}, world.owner);
    const pay = await makePayment(p.periodId, 300, {}, world.owner);
    await expectOk(await voidPayment(O(), pay.paymentId!, "yanlış"));
    const cancelled = await expectOk(await cancelPeriod(O(), p.periodId, "iptal"));
    const v = cancelled.version;
    const digest = await periodDigest(p.periodId);
    const auditBefore = (await staffAudit(T())).length;
    const refused: [string, RpcOutcome<unknown>][] = [
      ["W6", await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-10-20", expectedVersion: v })],
      ["W7", await addLine(O(), { periodId: p.periodId, kind: "salary", amount: 5, idempotencyKey: newKey() })],
      ["W8", await updateLine(O(), { lineId: line.lineId!, amount: 2000, expectedVersion: v })],
      ["W9", await voidLine(O(), { lineId: line.lineId!, reason: "x", expectedVersion: v })],
      ["W10", await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v })],
      ["W11", await reopenPeriod(O(), { periodId: p.periodId, reason: "x", expectedVersion: v })],
      [
        "W13",
        await recordPayment(O(), {
          periodId: p.periodId, purpose: "salary", amount: 5, method: "cash", paidAt: instantAgo(1), idempotencyKey: newKey(),
        }),
      ],
    ];
    for (const [label, out] of refused) {
      expect(failure(out), label).toBe("FN025");
    }
    expect(await periodDigest(p.periodId)).toBe(digest);
    expect((await staffAudit(T())).length).toBe(auditBefore);
    const w12 = await expectOk(await cancelPeriod(O(), p.periodId, "yine"));
    expect(w12.noop).toBe(true);
    const w14 = await expectOk(await voidPayment(O(), pay.paymentId!, "yine"));
    expect(w14.noop).toBe(true);
    expect(await periodDigest(p.periodId)).toBe(digest);
  });

  it("L12 / VR15 a due date can be set, cleared and left unchanged while open and finalized (+1, +1, +0) and not once cancelled", async () => {
    const p = await makePeriod(world);
    let v = 1;
    const set = await expectOk(await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-10-05", expectedVersion: v }));
    expect([set.version, set.noop]).toEqual([2, false]);
    v = set.version;
    const same = await expectOk(await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-10-05", expectedVersion: v }));
    expect([same.version, same.noop]).toEqual([2, true]);
    const cleared = await expectOk(await updatePeriod(O(), { periodId: p.periodId, dueDate: null, expectedVersion: v }));
    expect([cleared.version, cleared.noop]).toEqual([3, false]);
    expect((await periodRow(p.periodId)).due_date).toBeNull();
    v = cleared.version;
    await makeLine(p.periodId, "salary", 500, {}, world.owner);
    v = (await periodRow(p.periodId)).version;
    const fin = await expectOk(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v }));
    const onFinalized = await expectOk(
      await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-11-01", expectedVersion: fin.version }),
    );
    expect(onFinalized.version).toBe(fin.version + 1);
    const cancelled = await expectOk(await cancelPeriod(O(), p.periodId, "iptal"));
    expect(
      failure(await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-12-01", expectedVersion: cancelled.version })),
    ).toBe("FN025");
    // A stale version fails before the no-op decision, even when the value is unchanged.
    const q = await makePeriod(world);
    expect(
      failure(await updatePeriod(O(), { periodId: q.periodId, dueDate: null, expectedVersion: 7 })),
    ).toBe("FN013");
  });

  it("C1 finalize stores finalized_at and the snapshot, bumps the version once and audits the snapshot and the paid total", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 30000, {}, world.owner);
    await makeLine(p.periodId, "employee_social_insurance", 2500, {}, world.owner);
    await makePayment(p.periodId, 10000, { purpose: "advance" }, world.owner);
    const before = await periodRow(p.periodId);
    const out = await expectOk(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: before.version }));
    expect([out.lifecycle, out.noop, out.version]).toEqual(["finalized", false, before.version + 1]);
    const row = await periodRow(p.periodId);
    expect(row.finalized_at).not.toBeNull();
    expect(row.finalized_by).toBe(O());
    expect([row.finalized_earning_total, row.finalized_deduction_total, row.finalized_net_payable]).toEqual([
      "30000.00", "2500.00", "27500.00",
    ]);
    const [ev] = await staffAudit(T(), "finance.staff_period_finalized", p.periodId);
    expect(ev!.entity_type).toBe("staff_finance_period");
    expect(ev!.after).toMatchObject({
      lifecycle: "finalized", earning_total: 30000, employee_deduction_total: 2500, net_payable: 27500, paid_total: 10000,
    });
  });

  it("C2 finalize with an earning total of 0 is FN031", async () => {
    const p = await makePeriod(world);
    expect(failure(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: 1 }))).toBe("FN031");
    // employer cost alone is not an entitlement
    await makeLine(p.periodId, "private_insurance", 100, {}, world.owner);
    const v = (await periodRow(p.periodId)).version;
    expect(failure(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v }))).toBe("FN031");
  });

  it("C3 / C4 finalize with payments (advances included) above the net is FN033 and writes nothing; after the correction it succeeds", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 30000, {}, world.owner);
    await makePayment(p.periodId, 20000, { purpose: "advance" }, world.owner);
    const excess = await makePayment(p.periodId, 15000, { purpose: "salary" }, world.owner);
    const v = (await periodRow(p.periodId)).version;
    const digest = await periodDigest(p.periodId);
    const auditBefore = (await staffAudit(T())).length;
    expect(failure(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v }))).toBe("FN033");
    expect(await periodDigest(p.periodId)).toBe(digest);
    expect((await staffAudit(T())).length).toBe(auditBefore);
    // correct it by voiding the excess payment
    await expectOk(await voidPayment(O(), excess.paymentId!, "fazla ödeme"));
    const v2 = (await periodRow(p.periodId)).version;
    expect((await expectOk(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v2 }))).lifecycle).toBe("finalized");
    // and the other correction: add earning lines instead
    const q = await makePeriod(world);
    await makeLine(q.periodId, "salary", 10000, {}, world.owner);
    await makePayment(q.periodId, 12000, {}, world.owner);
    const qv = (await periodRow(q.periodId)).version;
    expect(failure(await finalizePeriod(O(), { periodId: q.periodId, expectedVersion: qv }))).toBe("FN033");
    await makeLine(q.periodId, "bonus", 2000, {}, world.owner);
    const qv2 = (await periodRow(q.periodId)).version;
    expect((await expectOk(await finalizePeriod(O(), { periodId: q.periodId, expectedVersion: qv2 }))).lifecycle).toBe("finalized");
  });

  it("C5 / C6 / C7 finalize again is a noop (even with an older version), a cancelled period is FN025 and a stale version FN013", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 1000, {}, world.owner);
    const v = (await periodRow(p.periodId)).version;
    expect(failure(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v - 1 }))).toBe("FN013");
    const fin = await expectOk(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v }));
    const again = await expectOk(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v }));
    expect([again.noop, again.version]).toEqual([true, fin.version]);
    const q = await makePeriod(world);
    await cancelPeriod(O(), q.periodId, "iptal");
    expect(failure(await finalizePeriod(O(), { periodId: q.periodId, expectedVersion: 2 }))).toBe("FN025");
  });

  it("C8 the snapshot equals the live statement at finalization and is unchanged by later adjustments; sinceFinalization shows the difference", async () => {
    const { periodId, version } = await finalizedPeriod();
    const snapshot = await periodRow(periodId);
    expect(snapshot.finalized_net_payable).toBe("27500.00");
    await makeLine(periodId, "adjustment_credit", 500, { description: "komisyon düzeltmesi" }, world.owner);
    await makeLine(periodId, "adjustment_debit", 200, { description: "kesinti düzeltmesi" }, world.owner);
    const after = await periodRow(periodId);
    expect([after.finalized_earning_total, after.finalized_deduction_total, after.finalized_net_payable]).toEqual([
      "30000.00", "2500.00", "27500.00",
    ]);
    expect([after.earning_total, after.employee_deduction_total, after.net_payable]).toEqual(["30500.00", "2700.00", "27800.00"]);
    const detail = await expectOk(await getPeriod(O(), periodId));
    expect(detail.finalizedStatement).toMatchObject({ grossEntitlement: 30000, employeeDeductions: 2500, netPayable: 27500 });
    expect(detail.sinceFinalization).toEqual({ grossEntitlement: 500, employeeDeductions: 200, netPayable: 300 });
    expect(version).toBeGreaterThan(1);
  });

  it("C9 reopen a finalized period with no payment after finalization: open, snapshot and finalized_at cleared, reason and cleared values audited", async () => {
    const { periodId, version } = await finalizedPeriod();
    const out = await expectOk(await reopenPeriod(O(), { periodId, reason: "hatalı tutar", expectedVersion: version }));
    expect([out.lifecycle, out.noop, out.version]).toEqual(["open", false, version + 1]);
    const row = await periodRow(periodId);
    expect([row.finalized_at, row.finalized_by, row.finalized_earning_total, row.finalized_deduction_total, row.finalized_net_payable]).toEqual([
      null, null, null, null, null,
    ]);
    const [ev] = await staffAudit(T(), "finance.staff_period_reopened", periodId);
    expect(ev!.after).toMatchObject({ lifecycle: "open", reason: "hatalı tutar" });
    expect(ev!.before).toMatchObject({ lifecycle: "finalized", earning_total: 30000, employee_deduction_total: 2500, net_payable: 27500 });
  });

  it("C10 / C11 / C12 a posted payment recorded after finalization (even an advance) blocks a reopen until it is voided; payments recorded before do not", async () => {
    // C12: payments recorded before finalization do not block
    const before = await makePeriod(world);
    await makeLine(before.periodId, "salary", 10000, {}, world.owner);
    await makePayment(before.periodId, 4000, { purpose: "advance" }, world.owner);
    const bv = (await periodRow(before.periodId)).version;
    const bf = await expectOk(await finalizePeriod(O(), { periodId: before.periodId, expectedVersion: bv }));
    const reopened = await expectOk(await reopenPeriod(O(), { periodId: before.periodId, reason: "düzelt", expectedVersion: bf.version }));
    expect(reopened.lifecycle).toBe("open");
    // C10: advance after finalization
    const { periodId, version } = await finalizedPeriod();
    const adv = await makePayment(periodId, 1000, { purpose: "advance" }, world.owner);
    const v = (await periodRow(periodId)).version;
    expect(failure(await reopenPeriod(O(), { periodId, reason: "x", expectedVersion: v }))).toBe("FN027");
    expect(v).toBe(adv.version);
    expect(version).toBeLessThan(v);
    // C11: after voiding the post-finalization payment the reopen works
    await expectOk(await voidPayment(O(), adv.paymentId!, "yanlış"));
    const v2 = (await periodRow(periodId)).version;
    expect((await expectOk(await reopenPeriod(O(), { periodId, reason: "x", expectedVersion: v2 }))).lifecycle).toBe("open");
  });

  it("C13 reopen an open period is a noop, a cancelled one is FN025, and without a reason FN004", async () => {
    const p = await makePeriod(world);
    expect((await expectOk(await reopenPeriod(O(), { periodId: p.periodId, reason: "x", expectedVersion: 1 }))).noop).toBe(true);
    expect(failure(await reopenPeriod(O(), { periodId: p.periodId, reason: null, expectedVersion: 1 }))).toBe("FN004");
    await cancelPeriod(O(), p.periodId, "iptal");
    expect(failure(await reopenPeriod(O(), { periodId: p.periodId, reason: "x", expectedVersion: 2 }))).toBe("FN025");
  });

  it("C14 cancel an open or finalized period with no payments: cancelled, reason stored, version +1, snapshot cleared, audited", async () => {
    const open = await makePeriod(world);
    await makeLine(open.periodId, "salary", 100, {}, world.owner);
    const ov = (await periodRow(open.periodId)).version;
    const c1 = await expectOk(await cancelPeriod(O(), open.periodId, "yanlış dönem"));
    expect([c1.lifecycle, c1.version, c1.noop]).toEqual(["cancelled", ov + 1, false]);
    const r1 = await periodRow(open.periodId);
    expect([r1.cancel_reason, r1.cancelled_by]).toEqual(["yanlış dönem", O()]);
    expect(r1.cancelled_at).not.toBeNull();
    const fin = await finalizedPeriod();
    const c2 = await expectOk(await cancelPeriod(O(), fin.periodId, "iptal"));
    expect(c2.version).toBe(fin.version + 1);
    const r2 = await periodRow(fin.periodId);
    expect([r2.finalized_at, r2.finalized_net_payable, r2.lifecycle]).toEqual([null, null, "cancelled"]);
    const [ev] = await staffAudit(T(), "finance.staff_period_cancelled", fin.periodId);
    expect(ev!.after).toMatchObject({ lifecycle: "cancelled", reason: "iptal" });
  });

  it("C15 / C19 cancel with any posted payment is FN027; after every payment is voided it succeeds", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 5000, {}, world.owner);
    const a = await makePayment(p.periodId, 1000, { purpose: "advance" }, world.owner);
    const b = await makePayment(p.periodId, 500, { purpose: "bonus" }, world.owner);
    const digest = await periodDigest(p.periodId);
    expect(failure(await cancelPeriod(O(), p.periodId, "iptal"))).toBe("FN027");
    expect(await periodDigest(p.periodId)).toBe(digest);
    await voidPayment(O(), a.paymentId!, "yanlış");
    expect(failure(await cancelPeriod(O(), p.periodId, "iptal"))).toBe("FN027");
    await voidPayment(O(), b.paymentId!, "yanlış");
    expect((await expectOk(await cancelPeriod(O(), p.periodId, "iptal"))).lifecycle).toBe("cancelled");
    expect(await paymentRows(p.periodId)).toHaveLength(2); // nothing deleted
  });

  it("C16 cancel again is a noop (reason not re-validated); C18 a new period for the same staff member and month then succeeds", async () => {
    const staff = await newStaff(world);
    const p = await makePeriod(world, { staffMemberId: staff.id });
    await cancelPeriod(O(), p.periodId, "iptal");
    const v = (await periodRow(p.periodId)).version;
    const again = await expectOk(await cancelPeriod(O(), p.periodId, null));
    expect([again.noop, again.version]).toEqual([true, v]);
    const fresh = await makePeriod(world, { staffMemberId: staff.id });
    expect(fresh.periodId).not.toBe(p.periodId);
  });

  it("C17 a cancelled period is excluded from the overview and the all-time figures", async () => {
    const staff = await newStaff(world);
    const month = "2026-06-01";
    const p = await makePeriod(world, { staffMemberId: staff.id, periodMonth: month });
    await makeLine(p.periodId, "salary", 7777, {}, world.owner);
    const live = await expectOk(await getOverview(O(), { tenantId: T(), month }));
    expect(live.periods.map((r) => r.periodId)).toContain(p.periodId);
    await cancelPeriod(O(), p.periodId, "iptal");
    const gone = await expectOk(await getOverview(O(), { tenantId: T(), month }));
    expect(gone.periods.map((r) => r.periodId)).not.toContain(p.periodId);
    expect(gone.byCurrency[0]!.grossEntitlement).toBe(live.byCurrency[0]!.grossEntitlement - 7777);
    expect(gone.byCurrency[0]!.employeeOutstandingAllTime.total).toBe(live.byCurrency[0]!.employeeOutstandingAllTime.total - 7777);
    expect(gone.staffWithoutPeriod.map((s) => s.staffMemberId)).toContain(staff.id);
  });
});

// =================================================================================================================
// VR — the version ledger
// =================================================================================================================
describe("VR version ledger", () => {
  it("VR1 / VR7 create is version 1; finalize, reopen and cancel are +1 each and +0 when repeated", async () => {
    const p = await makePeriod(world);
    expect(p.version).toBe(1);
    await makeLine(p.periodId, "salary", 100, {}, world.owner);
    let v = (await periodRow(p.periodId)).version;
    const f = await expectOk(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v }));
    expect(f.version).toBe(v + 1);
    expect((await expectOk(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: f.version }))).version).toBe(f.version);
    const r = await expectOk(await reopenPeriod(O(), { periodId: p.periodId, reason: "x", expectedVersion: f.version }));
    expect(r.version).toBe(f.version + 1);
    expect((await expectOk(await reopenPeriod(O(), { periodId: p.periodId, reason: "x", expectedVersion: r.version }))).version).toBe(r.version);
    const c = await expectOk(await cancelPeriod(O(), p.periodId, "iptal"));
    expect(c.version).toBe(r.version + 1);
    expect((await expectOk(await cancelPeriod(O(), p.periodId, "iptal"))).version).toBe(c.version);
    v = c.version;
    expect((await periodRow(p.periodId)).version).toBe(v);
  });

  it("VR8 refused actions (FN023, FN024, FN025, FN026, FN027, FN033) change no version", async () => {
    // FN033
    const a = await makePeriod(world);
    await makeLine(a.periodId, "salary", 1000, {}, world.owner);
    await makePayment(a.periodId, 1500, {}, world.owner);
    const av = (await periodRow(a.periodId)).version;
    expect(failure(await finalizePeriod(O(), { periodId: a.periodId, expectedVersion: av }))).toBe("FN033");
    // FN026
    expect(failure(await addLine(O(), { periodId: a.periodId, kind: "other_deduction", amount: 5000, idempotencyKey: newKey() }))).toBe("FN026");
    // FN027
    expect(failure(await cancelPeriod(O(), a.periodId, "iptal"))).toBe("FN027");
    expect((await periodRow(a.periodId)).version).toBe(av);
    // FN024 + FN023 + FN027 on a finalized period
    const { periodId, version } = await finalizedPeriod();
    expect(failure(await addLine(O(), { periodId, kind: "bonus", amount: 1, idempotencyKey: newKey() }))).toBe("FN024");
    expect(failure(await recordPayment(O(), {
      periodId, purpose: "salary", amount: 27500.01, method: "cash", paidAt: instantAgo(1), idempotencyKey: newKey(),
    }))).toBe("FN023");
    await makePayment(periodId, 100, {}, world.owner);
    const fv = (await periodRow(periodId)).version;
    expect(failure(await reopenPeriod(O(), { periodId, reason: "x", expectedVersion: fv }))).toBe("FN027");
    expect((await periodRow(periodId)).version).toBe(fv);
    expect(version).toBeLessThan(fv);
    // FN025
    const c = await makePeriod(world);
    await cancelPeriod(O(), c.periodId, "iptal");
    const cv = (await periodRow(c.periodId)).version;
    expect(failure(await addLine(O(), { periodId: c.periodId, kind: "salary", amount: 1, idempotencyKey: newKey() }))).toBe("FN025");
    expect((await periodRow(c.periodId)).version).toBe(cv);
  });

  it("VR13 a stale expected version is FN013 on update line, void line, finalize, reopen and update period", async () => {
    const p = await makePeriod(world);
    const line = await makeLine(p.periodId, "salary", 1000, {}, world.owner);
    const v = (await periodRow(p.periodId)).version;
    const stale = v - 1;
    expect(failure(await updateLine(O(), { lineId: line.lineId!, amount: 2000, expectedVersion: stale }))).toBe("FN013");
    expect(failure(await voidLine(O(), { lineId: line.lineId!, reason: "x", expectedVersion: stale }))).toBe("FN013");
    expect(failure(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: stale }))).toBe("FN013");
    expect(failure(await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-10-05", expectedVersion: stale }))).toBe("FN013");
    const { periodId, version } = await finalizedPeriod();
    expect(failure(await reopenPeriod(O(), { periodId, reason: "x", expectedVersion: version - 1 }))).toBe("FN013");
    expect((await periodRow(p.periodId)).version).toBe(v);
  });

  it("VR14 add line, record payment, void payment and cancel need no expected version", async () => {
    const p = await makePeriod(world);
    const l = await expectOk(await addLine(O(), { periodId: p.periodId, kind: "salary", amount: 100, idempotencyKey: newKey() }));
    const pay = await expectOk(await recordPayment(O(), {
      periodId: p.periodId, purpose: "salary", amount: 10, method: "cash", paidAt: instantAgo(1), idempotencyKey: newKey(),
    }));
    expect(l.version).toBeGreaterThan(1);
    expect((await expectOk(await voidPayment(O(), pay.paymentId!, "yanlış"))).noop).toBe(false);
    expect((await expectOk(await cancelPeriod(O(), p.periodId, "iptal"))).lifecycle).toBe("cancelled");
  });

  it("VR10 / R25 / A11 the 31-step normative trace of architecture section 9", async () => {
    const staff = await newStaff(world, "İz");
    const o = O();
    const T0 = (await counts(T())).audit;
    const audit = async () => (await staffAudit(T())).slice(T0);
    const digestOf = (id: string) => periodDigest(id);

    // 1 create
    const created = await expectOk(await createPeriod(o, validPeriod(world, staff.id, { dueDate: "2026-10-05" })));
    const pid = created.periodId;
    expect([created.version, created.lifecycle]).toEqual([1, "open"]);
    // 2 advance 10,000 while open, before any earning line
    const adv = await expectOk(await recordPayment(o, {
      periodId: pid, purpose: "advance", amount: 10000, method: "cash", paidAt: instantAgo(40), idempotencyKey: newKey(),
    }));
    expect([adv.version, adv.paymentState]).toEqual([2, "overpaid"]);
    expect(await oracle(pid)).toEqual({ G: 0, D: 0, N: 0, P: 10000, A: 10000, E: 0 });
    // 3 salary 30,000 with a description
    const saleKey = newKey();
    const salaryIn = { periodId: pid, kind: "salary", amount: 30000, description: "FIN.1C maaş", idempotencyKey: saleKey };
    const salary = await expectOk(await addLine(o, salaryIn));
    expect([salary.version, salary.paymentState]).toEqual([3, "partially_paid"]);
    const salaryId = salary.lineId!;
    // 4 replay of step 3
    const replay = await expectOk(await addLine(o, salaryIn));
    expect([replay.noop, replay.version, replay.lineId]).toEqual([true, 3, salaryId]);
    // 5 employee Social Insurance 2,500
    const si = await expectOk(await addLine(o, { periodId: pid, kind: "employee_social_insurance", amount: 2500, idempotencyKey: newKey() }));
    expect(si.version).toBe(4);
    expect(await oracle(pid)).toMatchObject({ G: 30000, D: 2500, N: 27500 });
    // 6 employer Social Insurance 3,500
    const er = await expectOk(await addLine(o, { periodId: pid, kind: "employer_social_insurance", amount: 3500, description: "işveren payı", idempotencyKey: newKey() }));
    expect(er.version).toBe(5);
    const erId = er.lineId!;
    // 7 edit the salary line to 31,000 (description unchanged)
    const e7 = await expectOk(await updateLine(o, { lineId: salaryId, amount: 31000, description: "FIN.1C maaş", expectedVersion: 5 }));
    expect([e7.version, e7.noop]).toEqual([6, false]);
    expect(await oracle(pid)).toMatchObject({ G: 31000, N: 28500 });
    // 8 the same edit again
    const e8 = await expectOk(await updateLine(o, { lineId: salaryId, amount: 31000, description: "FIN.1C maaş", expectedVersion: 6 }));
    expect([e8.version, e8.noop]).toEqual([6, true]);
    // 9 description only
    const e9 = await expectOk(await updateLine(o, { lineId: salaryId, amount: 31000, description: "FIN.1C maaş (düzenlendi)", expectedVersion: 6 }));
    expect([e9.version, e9.noop]).toEqual([7, false]);
    expect(await oracle(pid)).toMatchObject({ G: 31000, N: 28500 });
    // 10 the same description again
    const e10 = await expectOk(await updateLine(o, { lineId: salaryId, amount: 31000, description: "FIN.1C maaş (düzenlendi)", expectedVersion: 7 }));
    expect([e10.version, e10.noop]).toEqual([7, true]);
    // 11 salary payment 25,000 while open: P 35,000 above N
    const p11 = await expectOk(await recordPayment(o, {
      periodId: pid, purpose: "salary", amount: 25000, method: "bank_transfer", paidAt: instantAgo(30), idempotencyKey: newKey(),
    }));
    expect([p11.version, p11.paymentState]).toEqual([8, "overpaid"]);
    expect(await oracle(pid)).toMatchObject({ P: 35000, A: 10000 });
    // 12 finalize with expected version 8: FN033, nothing written
    const d12 = await digestOf(pid);
    expect(failure(await finalizePeriod(o, { periodId: pid, expectedVersion: 8 }))).toBe("FN033");
    expect(await digestOf(pid)).toBe(d12);
    // 13 void the 25,000 payment
    const v13 = await expectOk(await voidPayment(o, p11.paymentId!, "fazla ödeme"));
    expect(v13.version).toBe(9);
    // 14 finalize with expected version 9
    const f14 = await expectOk(await finalizePeriod(o, { periodId: pid, expectedVersion: 9 }));
    expect([f14.version, f14.lifecycle]).toEqual([10, "finalized"]);
    expect(await periodRow(pid)).toMatchObject({ finalized_earning_total: "31000.00", finalized_deduction_total: "2500.00", finalized_net_payable: "28500.00" });
    // 15 finalize again
    expect((await expectOk(await finalizePeriod(o, { periodId: pid, expectedVersion: 10 }))).version).toBe(10);
    // 16 add a bonus line
    const d16 = await digestOf(pid);
    expect(failure(await addLine(o, { periodId: pid, kind: "bonus", amount: 1000, idempotencyKey: newKey() }))).toBe("FN024");
    // 17 edit the salary line's description on the finalized period
    expect(failure(await updateLine(o, { lineId: salaryId, amount: 31000, description: "başka", expectedVersion: 10 }))).toBe("FN024");
    expect(await digestOf(pid)).toBe(d16);
    // 18 payment 18,500 after finalization (exactly the outstanding amount)
    const p18 = await expectOk(await recordPayment(o, {
      periodId: pid, purpose: "salary", amount: 18500, method: "cash", paidAt: instantAgo(20), idempotencyKey: newKey(),
    }));
    expect([p18.version, p18.paymentState]).toEqual([11, "paid"]);
    expect((await paymentRows(pid)).find((r) => r.id === p18.paymentId)!.post_finalization).toBe(true);
    // 19 payment of 0.01 more: FN023
    expect(failure(await recordPayment(o, {
      periodId: pid, purpose: "salary", amount: 0.01, method: "cash", paidAt: instantAgo(10), idempotencyKey: newKey(),
    }))).toBe("FN023");
    // 20 adjustment credit 500 with a reason
    const a20 = await expectOk(await addLine(o, { periodId: pid, kind: "adjustment_credit", amount: 500, description: "komisyon düzeltmesi", idempotencyKey: newKey() }));
    expect(a20.version).toBe(12);
    expect(await oracle(pid)).toMatchObject({ G: 31500, N: 29000 });
    expect(await periodRow(pid)).toMatchObject({ finalized_net_payable: "28500.00" });
    // 21 employer Ihtiyat Sandigi 1,500 on the finalized period
    const e21 = await expectOk(await addLine(o, { periodId: pid, kind: "employer_provident_fund", amount: 1500, idempotencyKey: newKey() }));
    expect(e21.version).toBe(13);
    expect(await oracle(pid)).toMatchObject({ E: 5000 });
    // 22 edit the employer Social Insurance line to 3,600
    const e22 = await expectOk(await updateLine(o, { lineId: erId, amount: 3600, description: "işveren payı", expectedVersion: 13 }));
    expect(e22.version).toBe(14);
    expect(await oracle(pid)).toMatchObject({ E: 5100 });
    // 23 edit the employer Social Insurance line's description on the finalized period
    const e23 = await expectOk(await updateLine(o, { lineId: erId, amount: 3600, description: "işveren payı (güncel)", expectedVersion: 14 }));
    expect(e23.version).toBe(15);
    // 24 reopen with a reason: FN027
    const d24 = await digestOf(pid);
    expect(failure(await reopenPeriod(o, { periodId: pid, reason: "düzelt", expectedVersion: 15 }))).toBe("FN027");
    expect(await digestOf(pid)).toBe(d24);
    // 25 void the 18,500 payment
    const v25 = await expectOk(await voidPayment(o, p18.paymentId!, "yanlış"));
    expect(v25.version).toBe(16);
    // 26 reopen with a reason
    const r26 = await expectOk(await reopenPeriod(o, { periodId: pid, reason: "düzelt", expectedVersion: 16 }));
    expect([r26.version, r26.lifecycle]).toEqual([17, "open"]);
    expect((await periodRow(pid)).finalized_net_payable).toBeNull();
    // 27 cancel: FN027 (the advance is posted)
    expect(failure(await cancelPeriod(o, pid, "iptal"))).toBe("FN027");
    // 28 void the advance
    const v28 = await expectOk(await voidPayment(o, adv.paymentId!, "avans iptal"));
    expect(v28.version).toBe(18);
    expect(await oracle(pid)).toMatchObject({ P: 0, A: 0 });
    // 29 cancel with a reason
    const c29 = await expectOk(await cancelPeriod(o, pid, "iptal"));
    expect([c29.version, c29.lifecycle]).toEqual([19, "cancelled"]);
    // 30 cancel again
    expect((await expectOk(await cancelPeriod(o, pid, "tekrar"))).version).toBe(19);
    // 31 edit a line's amount on the cancelled period
    expect(failure(await updateLine(o, { lineId: salaryId, amount: 100, description: "x", expectedVersion: 19 }))).toBe("FN025");

    // A11: the audit holds exactly 19 events for this period, exact per action
    const events = (await audit()).filter(
      (e) => e.entity_id === pid || (e.after as { period_id?: string } | null)?.period_id === pid,
    );
    const byAction: Record<string, number> = {};
    for (const e of events) byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    expect(events).toHaveLength(19);
    expect(byAction).toEqual({
      "finance.staff_period_created": 1,
      "finance.staff_line_added": 5,
      "finance.staff_line_updated": 4,
      "finance.staff_payment_recorded": 3,
      "finance.staff_payment_voided": 3,
      "finance.staff_period_finalized": 1,
      "finance.staff_period_reopened": 1,
      "finance.staff_period_cancelled": 1,
    });
    // versions and audit reconcile: 18 version bumps (1 to 19), one audited event each, plus the creation event
    expect(events.filter((e) => e.action !== "finance.staff_period_created")).toHaveLength(19 - 1);
    // R25: the end states match the trace
    const detail = await expectOk(await getPeriod(o, pid));
    expect(detail).toMatchObject({
      lifecycle: "cancelled", version: 19, paid: 0, advances: 0, grossEntitlement: 31500, employeeDeductions: 2500,
      netPayable: 29000, employerCost: 5100, personnelCost: 36600, employeeOutstanding: 0, paidInExcess: 0,
    });
    expect(detail.lines.filter((l) => l.status === "active")).toHaveLength(5);
    expect(detail.payments.map((p) => p.status)).toEqual(["voided", "voided", "voided"]);
    expect(detail.lines.find((l) => l.kind === "adjustment_credit")!.postFinalization).toBe(true);
  });

  it("VR9 a random history: versions never decrease and equal one plus the number of real changes (audit reconciles)", async () => {
    const p = await makePeriod(world);
    const pid = p.periodId;
    const lineIds: string[] = [];
    let prev = 1;
    const check = async () => {
      const v = (await periodRow(pid)).version;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    };
    const seed = 12345;
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 40; i++) {
      const r = rnd();
      const row = await periodRow(pid);
      if (row.lifecycle === "cancelled") break;
      if (r < 0.3) {
        const out = await addLine(O(), { periodId: pid, kind: ["salary", "bonus", "private_insurance", "other_deduction"][Math.floor(rnd() * 4)]!, amount: 10 + Math.floor(rnd() * 90), idempotencyKey: newKey() });
        if (out.ok && out.data.lineId) lineIds.push(out.data.lineId);
      } else if (r < 0.5 && lineIds.length > 0) {
        const id = lineIds[Math.floor(rnd() * lineIds.length)]!;
        await updateLine(O(), { lineId: id, amount: 10 + Math.floor(rnd() * 90), description: rnd() < 0.5 ? "açıklama" : null, expectedVersion: row.version });
      } else if (r < 0.65) {
        await recordPayment(O(), { periodId: pid, purpose: "salary", amount: 5 + Math.floor(rnd() * 30), method: "cash", paidAt: instantAgo(5), idempotencyKey: newKey() });
      } else if (r < 0.75) {
        const pay = (await paymentRows(pid)).find((x) => x.status === "posted");
        if (pay) await voidPayment(O(), pay.id, "iptal");
      } else if (r < 0.85) {
        await finalizePeriod(O(), { periodId: pid, expectedVersion: row.version });
      } else if (r < 0.92) {
        await reopenPeriod(O(), { periodId: pid, reason: "düzelt", expectedVersion: row.version });
      } else {
        const id = lineIds[Math.floor(rnd() * Math.max(lineIds.length, 1))];
        if (id) await voidLine(O(), { lineId: id, reason: "iptal", expectedVersion: row.version });
      }
      await check();
    }
    const events = (await staffAudit(T())).filter((e) => e.entity_id === pid || (e.after as { period_id?: string } | null)?.period_id === pid);
    expect(events.length).toBeGreaterThan(5);
    // the version equals 1 + the number of audited real changes of this period (create is event 0)
    const total = events.filter((e) => e.action !== "finance.staff_period_created").length;
    expect((await periodRow(pid)).version).toBe(1 + total);
  });
});

/** Independent oracle of the period figures from the child rows. */
async function oracle(periodId: string) {
  const [pr] = await testDb<{ g: string; d: string; e: string; p: string; a: string }[]>`
    select
      coalesce((select sum(amount) from staff_period_lines where period_id = ${periodId} and status = 'active' and line_group = 'earning'), 0)::text as g,
      coalesce((select sum(amount) from staff_period_lines where period_id = ${periodId} and status = 'active' and line_group = 'employee_deduction'), 0)::text as d,
      coalesce((select sum(amount) from staff_period_lines where period_id = ${periodId} and status = 'active' and line_group = 'employer_cost'), 0)::text as e,
      coalesce((select sum(amount) from staff_payments where period_id = ${periodId} and status = 'posted'), 0)::text as p,
      coalesce((select sum(amount) from staff_payments where period_id = ${periodId} and status = 'posted' and purpose = 'advance'), 0)::text as a`;
  const row = await periodRow(periodId);
  const oracleValues = {
    G: Number(pr!.g), D: Number(pr!.d), N: Number(pr!.g) - Number(pr!.d), P: Number(pr!.p), A: Number(pr!.a), E: Number(pr!.e),
  };
  // the cached columns equal the oracle at every observation
  expect({
    G: Number(row.earning_total), D: Number(row.employee_deduction_total), N: Number(row.net_payable),
    P: Number(row.paid_total), A: Number(row.advance_total), E: Number(row.employer_cost_total),
  }).toEqual(oracleValues);
  return oracleValues;
}

// =================================================================================================================
// A — audit of the period lifecycle
// =================================================================================================================
describe("A period audit", () => {
  it("A1 create writes exactly one finance.staff_period_created with the specified payload and entity", async () => {
    const staff = await newStaff(world);
    const out = await expectOk(await createPeriod(O(), validPeriod(world, staff.id, { dueDate: "2026-10-05" })));
    const events = await staffAudit(T(), undefined, out.periodId);
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e!.action).toBe("finance.staff_period_created");
    expect(e!.entity_type).toBe("staff_finance_period");
    expect(e!.actor_user_id).toBe(O());
    expect(e!.before).toBeNull();
    expect(e!.after).toEqual({
      staff_member_id: staff.id, period_month: DEFAULT_MONTH, currency: "TRY", due_date: "2026-10-05",
    });
  });

  it("A6 finalize, reopen and cancel write one event each: the snapshot and paid total, the reason and cleared snapshot, the reason", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 1000, {}, world.owner);
    await makePayment(p.periodId, 200, { purpose: "advance" }, world.owner);
    let v = (await periodRow(p.periodId)).version;
    const f = await expectOk(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v }));
    const r = await expectOk(await reopenPeriod(O(), { periodId: p.periodId, reason: "neden", expectedVersion: f.version }));
    const pay = (await paymentRows(p.periodId))[0]!;
    await voidPayment(O(), pay.id, "iptal");
    v = (await periodRow(p.periodId)).version;
    await cancelPeriod(O(), p.periodId, "kapat");
    for (const action of [
      "finance.staff_period_finalized", "finance.staff_period_reopened", "finance.staff_period_cancelled",
    ]) {
      expect(await staffAudit(T(), action, p.periodId), action).toHaveLength(1);
    }
    const [fe] = await staffAudit(T(), "finance.staff_period_finalized", p.periodId);
    expect(fe!.after).toMatchObject({ earning_total: 1000, employee_deduction_total: 0, net_payable: 1000, paid_total: 200 });
    const [re] = await staffAudit(T(), "finance.staff_period_reopened", p.periodId);
    expect(re!.after).toMatchObject({ reason: "neden" });
    expect(re!.before).toMatchObject({ earning_total: 1000, net_payable: 1000 });
    const [ce] = await staffAudit(T(), "finance.staff_period_cancelled", p.periodId);
    expect(ce!.after).toMatchObject({ reason: "kapat" });
    expect(r.lifecycle).toBe("open");
    expect(v).toBeGreaterThan(f.version);
  });

  it("A7 a due date update writes one event with before and after; a no-op writes none", async () => {
    const p = await makePeriod(world);
    await expectOk(await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-10-09", expectedVersion: 1 }));
    await expectOk(await updatePeriod(O(), { periodId: p.periodId, dueDate: "2026-10-09", expectedVersion: 2 }));
    const events = await staffAudit(T(), "finance.staff_period_updated", p.periodId);
    expect(events).toHaveLength(1);
    expect(events[0]!.before).toEqual({ due_date: null });
    expect(events[0]!.after).toMatchObject({ due_date: "2026-10-09", version: 2 });
  });

  it("A8 refused period actions write no audit rows", async () => {
    const p = await makePeriod(world);
    await makeLine(p.periodId, "salary", 100, {}, world.owner);
    await makePayment(p.periodId, 300, {}, world.owner);
    const before = (await staffAudit(T())).length;
    const v = (await periodRow(p.periodId)).version;
    expect(failure(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v }))).toBe("FN033");
    expect(failure(await cancelPeriod(O(), p.periodId, "iptal"))).toBe("FN027");
    expect(failure(await finalizePeriod(O(), { periodId: p.periodId, expectedVersion: v - 1 }))).toBe("FN013");
    expect((await staffAudit(T())).length).toBe(before);
  });

  it("A9 a forced failure after the audit insert rolls the whole write back", async () => {
    const p = await makePeriod(world);
    const before = { digest: await periodDigest(p.periodId), audit: (await staffAudit(T())).length };
    await expect(
      testDb.begin(async (sql) => {
        await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: O(), role: "authenticated" })}, true),
                         set_config('request.jwt.claim.sub', ${O()}, true)`;
        await sql`set local role authenticated`;
        await sql.unsafe(
          `select public.add_staff_period_line(p_period_id := '${p.periodId}', p_kind := 'salary', p_amount := 99, p_idempotency_key := '${newKey()}')`,
        );
        throw new Error("forced failure after the audit insert");
      }),
    ).rejects.toThrow("forced failure");
    expect(await periodDigest(p.periodId)).toBe(before.digest);
    expect((await staffAudit(T())).length).toBe(before.audit);
  });
});

// =================================================================================================================
// Misc period facts
// =================================================================================================================
describe("period facts", () => {
  it("the unique text helper and fixtures do not collide", () => {
    expect(uniqueText("a")).not.toBe(uniqueText("a"));
  });

  it("a created period is open, nothing due, zero totals, version 1 and carries no finalization data", async () => {
    const p = await makePeriod(world);
    const row = await periodRow(p.periodId);
    expect(row).toMatchObject({
      lifecycle: "open", payment_state: "nothing_due", version: 1, content_revision: 0,
      earning_total: "0.00", employee_deduction_total: "0.00", employer_cost_total: "0.00", paid_total: "0.00", advance_total: "0.00",
      net_payable: "0.00", finalized_at: null, cancelled_at: null,
    });
    const lines: unknown = await lineRows(p.periodId);
    expect(lines).toEqual([]);
    const result: WriteResult = p;
    expect(result.paymentState).toBe("nothing_due");
  });
});
