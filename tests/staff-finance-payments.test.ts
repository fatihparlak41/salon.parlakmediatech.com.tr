import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createStaffFinanceWorld,
  destroyStaffFinanceWorld,
  addLine,
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
  expectOk,
  periodRow,
  lineRows,
  paymentRows,
  staffAudit,
  counts,
  periodDigest,
  newKey,
  instantAhead,
  type StaffFinanceWorld,
  type RpcOutcome,
  type RecordPaymentInput,
} from "./staff-finance-fixtures";

/**
 * Faz FIN.1C.1 — staff payments and advances (matrix groups V17-V22 / V27, IP, ADV, Y, L13 and the payment half of A).
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to
 * whatever TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV
 * database) and fails loudly when they are not.
 */

let world: StaffFinanceWorld;
const PAST = "2026-10-02T09:15:30.123456Z"; // a fixed past instant, microsecond precision

beforeAll(async () => {
  world = await createStaffFinanceWorld("fin1c1-pay");
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

/** An open period with a salary line (net = amount). */
async function openWithSalary(amount: number | string = 30000) {
  const p = await makePeriod(world);
  await makeLine(p.periodId, "salary", amount, {}, world.owner);
  return p.periodId;
}

async function finalize(periodId: string) {
  const v = (await periodRow(periodId)).version;
  return expectOk(await finalizePeriod(O(), { periodId, expectedVersion: v }));
}

function pay(periodId: string, o: Partial<RecordPaymentInput> = {}): RecordPaymentInput {
  return {
    periodId, purpose: "salary", amount: 100, method: "cash", paidAt: PAST, idempotencyKey: newKey(), ...o,
  };
}

// =================================================================================================================
// V — record_staff_payment validation
// =================================================================================================================
describe("V payment validation", () => {
  it.each([["0"], ["-1"], ["NaN"], ["Infinity"], ["0.001"], ["1.005"], ["10000000000"], [null]])(
    "V17 amount %s is FN004 with zero rows",
    async (amount) => {
      const periodId = await openWithSalary();
      const digest = await periodDigest(periodId);
      expect(failure(await recordPayment(O(), pay(periodId, { amount })))).toBe("FN004");
      expect(await periodDigest(periodId)).toBe(digest);
    },
  );

  it("V18 an invalid or null method is FN006", async () => {
    const periodId = await openWithSalary();
    for (const method of ["crypto", "CASH", "", null]) {
      expect(failure(await recordPayment(O(), pay(periodId, { method }))), String(method)).toBe("FN006");
    }
  });

  it("V19 an invalid or null purpose is FN004", async () => {
    const periodId = await openWithSalary();
    for (const purpose of ["loan", "ADVANCE", "", null]) {
      expect(failure(await recordPayment(O(), pay(periodId, { purpose }))), String(purpose)).toBe("FN004");
    }
  });

  it("V20 paid_at null, before 2000-01-01 or beyond now plus one hour is FN004; a past and a near-future instant are accepted", async () => {
    const periodId = await openWithSalary();
    for (const paidAt of [null, "1999-12-31T23:59:59Z", instantAhead(90)]) {
      expect(failure(await recordPayment(O(), pay(periodId, { paidAt }))), String(paidAt)).toBe("FN004");
    }
    expect((await expectOk(await recordPayment(O(), pay(periodId, { paidAt: instantAhead(30) })))).noop).toBe(false);
    expect((await expectOk(await recordPayment(O(), pay(periodId, { paidAt: "2000-01-01T00:00:00Z" })))).noop).toBe(false);
  });

  it("V21 a note above 500 is FN004; 500 is accepted and stored trimmed", async () => {
    const periodId = await openWithSalary();
    expect(failure(await recordPayment(O(), pay(periodId, { note: "x".repeat(501) })))).toBe("FN004");
    const ok = await expectOk(await recordPayment(O(), pay(periodId, { note: `  ${"y".repeat(500)}  ` })));
    expect((await paymentRows(periodId)).find((r) => r.id === ok.paymentId)!.note).toHaveLength(500);
  });

  it("V22 a null or omitted key is FN004", async () => {
    const periodId = await openWithSalary();
    expect(failure(await recordPayment(O(), pay(periodId, { idempotencyKey: null })))).toBe("FN004");
    expect(failure(await recordPayment(O(), pay(periodId, { idempotencyKey: undefined })))).toBe("FN004");
  });

  it.each([["salary"], ["advance"], ["bonus"], ["other"]])(
    "V27 a %s payment on an open period with an earning total of 0, or above the net, is accepted (no payment-time cap)",
    async (purpose) => {
      const empty = await makePeriod(world);
      const a = await expectOk(await recordPayment(O(), pay(empty.periodId, { purpose, amount: 500 })));
      expect(a.paymentState).toBe("overpaid");
      const periodId = await openWithSalary(1000);
      const b = await expectOk(await recordPayment(O(), pay(periodId, { purpose, amount: 5000 })));
      expect(b.paymentState).toBe("overpaid");
    },
  );

  it("V23 void payment: a blank or over-500 reason is FN004, checked after the already-voided no-op; void without a payment id is FN004", async () => {
    const periodId = await openWithSalary();
    const p = await makePayment(periodId, 100, {}, world.owner);
    for (const reason of ["   ", "", null, "x".repeat(501)]) {
      expect(failure(await voidPayment(O(), p.paymentId!, reason)), String(reason)).toBe("FN004");
    }
    await expectOk(await voidPayment(O(), p.paymentId!, "yanlış"));
    expect((await expectOk(await voidPayment(O(), p.paymentId!, "   "))).noop).toBe(true);
    expect(failure(await voidPayment(O(), null, "x"))).toBe("FN004");
    expect(failure(await voidPayment(O(), "00000000-0000-4000-8000-000000000f09", "x"))).toBe("FN022");
  });
});

// =================================================================================================================
// IP — payment idempotency
// =================================================================================================================
describe("IP payment idempotency", () => {
  it("IP1 a replay is a noop with the same payment id, zero writes and zero audit", async () => {
    const periodId = await openWithSalary();
    const input = pay(periodId, { amount: 250, note: "Not" });
    const first = await expectOk(await recordPayment(O(), input));
    expect(first.noop).toBe(false);
    const digest = await periodDigest(periodId);
    const audit = (await staffAudit(T())).length;
    const again = await expectOk(await recordPayment(O(), input));
    expect(again).toEqual({ ...first, noop: true });
    expect(await periodDigest(periodId)).toBe(digest);
    expect((await staffAudit(T())).length).toBe(audit);
  });

  it("IP2-IP6 the same key with a different amount, purpose, method, paid_at (one microsecond) or note is FN007", async () => {
    const periodId = await openWithSalary();
    const base = pay(periodId, { amount: 250, note: "Not", purpose: "salary", method: "cash", paidAt: PAST });
    await expectOk(await recordPayment(O(), base));
    const digest = await periodDigest(periodId);
    const variants: [string, RecordPaymentInput][] = [
      ["IP2 amount", { ...base, amount: 250.01 }],
      ["IP3 purpose", { ...base, purpose: "advance" }],
      ["IP4 method", { ...base, method: "card" }],
      ["IP5 paid_at", { ...base, paidAt: "2026-10-02T09:15:30.123457Z" }],
      ["IP6 note", { ...base, note: "Başka" }],
      ["IP6 note dropped", { ...base, note: undefined }],
    ];
    for (const [label, v] of variants) {
      expect(failure(await recordPayment(O(), v)), label).toBe("FN007");
    }
    expect(await periodDigest(periodId)).toBe(digest);
  });

  it("IP7 a key used for a payment of another period is FN007", async () => {
    const a = await openWithSalary();
    const b = await openWithSalary();
    const key = newKey();
    await expectOk(await recordPayment(O(), pay(a, { idempotencyKey: key })));
    expect(failure(await recordPayment(O(), pay(b, { idempotencyKey: key })))).toBe("FN007");
    expect(await paymentRows(b)).toHaveLength(0);
  });

  it("IP8 / IP11 a replay after the payment was voided (and after the period was cancelled) is a noop", async () => {
    const periodId = await openWithSalary();
    const input = pay(periodId, { amount: 100 });
    const first = await expectOk(await recordPayment(O(), input));
    await expectOk(await voidPayment(O(), first.paymentId!, "yanlış"));
    const afterVoid = await expectOk(await recordPayment(O(), input));
    expect([afterVoid.noop, afterVoid.paymentId]).toEqual([true, first.paymentId]);
    await expectOk(await cancelPeriod(O(), periodId, "iptal"));
    const afterCancel = await expectOk(await recordPayment(O(), input));
    expect([afterCancel.noop, afterCancel.lifecycle]).toEqual([true, "cancelled"]);
  });

  it("IP9 a replay after the period became fully paid is a noop", async () => {
    const periodId = await openWithSalary(1000);
    const input = pay(periodId, { amount: 400 });
    await expectOk(await recordPayment(O(), input));
    await makePayment(periodId, 600, {}, world.owner);
    expect((await periodRow(periodId)).payment_state).toBe("paid");
    expect((await expectOk(await recordPayment(O(), input))).noop).toBe(true);
  });

  it("IP10 a replay after finalization is a noop and the stored post_finalization flag stays false", async () => {
    const periodId = await openWithSalary(1000);
    const input = pay(periodId, { amount: 400 });
    const first = await expectOk(await recordPayment(O(), input));
    await finalize(periodId);
    const again = await expectOk(await recordPayment(O(), input));
    expect([again.noop, again.paymentId, again.lifecycle]).toEqual([true, first.paymentId, "finalized"]);
    expect((await paymentRows(periodId)).find((r) => r.id === first.paymentId)!.post_finalization).toBe(false);
  });

  it("IP12 a note null, absent or blank is the same payload (noop)", async () => {
    const periodId = await openWithSalary();
    const key = newKey();
    const first = await expectOk(await recordPayment(O(), pay(periodId, { idempotencyKey: key, note: null })));
    for (const note of [undefined, "", "   ", "\t\n"]) {
      const r = await expectOk(await recordPayment(O(), pay(periodId, { idempotencyKey: key, note })));
      expect([r.noop, r.paymentId]).toEqual([true, first.paymentId]);
    }
  });
});

// =================================================================================================================
// ADV — advances
// =================================================================================================================
describe("ADV advances", () => {
  it("ADV1 an advance of 10,000 in an open period before any earning line: allowed, P = A = 10,000, N 0, overpaid, version +1, no line created", async () => {
    const p = await makePeriod(world);
    const out = await expectOk(await recordPayment(O(), pay(p.periodId, { purpose: "advance", amount: 10000 })));
    expect([out.paymentState, out.version]).toEqual(["overpaid", p.version + 1]);
    const row = await periodRow(p.periodId);
    expect([row.paid_total, row.advance_total, row.net_payable, row.earning_total]).toEqual(["10000.00", "10000.00", "0.00", "0.00"]);
    expect(await lineRows(p.periodId)).toHaveLength(0);
  });

  it("ADV2 / Y17 an open period: an advance above the net is allowed; employeeOutstanding is negative and paidInExcess equals the excess", async () => {
    const periodId = await openWithSalary(30000);
    const out = await expectOk(await recordPayment(O(), pay(periodId, { purpose: "advance", amount: 35000 })));
    expect(out.paymentState).toBe("overpaid");
    const detail = await expectOk(await getPeriod(O(), periodId));
    expect([detail.employeeOutstanding, detail.paidInExcess, detail.paid, detail.advances]).toEqual([-5000, 5000, 35000, 35000]);
    const ov = await expectOk(await getOverview(O(), { tenantId: T(), month: "2026-09-01" }));
    const row = ov.periods.find((r) => r.periodId === periodId)!;
    expect([row.employeeOutstanding, row.paidInExcess]).toEqual([-5000, 5000]);
  });

  it("ADV3 an advance changes no earning, deduction or employer total, no line count and no personnel cost", async () => {
    const periodId = await openWithSalary(30000);
    await makeLine(periodId, "employee_social_insurance", 2500, {}, world.owner);
    await makeLine(periodId, "employer_social_insurance", 3500, {}, world.owner);
    const before = await getPeriod(O(), periodId);
    const lines = (await lineRows(periodId)).length;
    await expectOk(await recordPayment(O(), pay(periodId, { purpose: "advance", amount: 10000 })));
    const after = await getPeriod(O(), periodId);
    expect([after.grossEntitlement, after.employeeDeductions, after.employerCost, after.personnelCost, after.netPayable]).toEqual([
      before.grossEntitlement, before.employeeDeductions, before.employerCost, before.personnelCost, before.netPayable,
    ]);
    expect((await lineRows(periodId)).length).toBe(lines);
  });

  it("ADV4 finalize while payments exceed the net is FN033 with zero writes; after the excess is voided, or earning lines are added, it succeeds", async () => {
    const periodId = await openWithSalary(1000);
    const excess = await makePayment(periodId, 1500, { purpose: "advance" }, world.owner);
    const digest = await periodDigest(periodId);
    const v = (await periodRow(periodId)).version;
    expect(failure(await finalizePeriod(O(), { periodId, expectedVersion: v }))).toBe("FN033");
    expect(await periodDigest(periodId)).toBe(digest);
    await makeLine(periodId, "bonus", 600, {}, world.owner);
    expect((await finalize(periodId)).lifecycle).toBe("finalized");
    const q = await openWithSalary(1000);
    const e2 = await makePayment(q, 1200, {}, world.owner);
    await expectOk(await voidPayment(O(), e2.paymentId!, "fazla"));
    expect((await finalize(q)).lifecycle).toBe("finalized");
    expect(excess.paymentId).toBeTruthy();
  });

  it("ADV5 finalize with payments exactly equal to the net succeeds; with the net plus 0.01 it is FN033", async () => {
    const exact = await openWithSalary(1000);
    await makePayment(exact, 1000, { purpose: "advance" }, world.owner);
    expect((await finalize(exact)).lifecycle).toBe("finalized");
    const over = await openWithSalary(1000);
    await makePayment(over, 1000.01, { purpose: "advance" }, world.owner);
    const v = (await periodRow(over)).version;
    expect(failure(await finalizePeriod(O(), { periodId: over, expectedVersion: v }))).toBe("FN033");
  });

  it("ADV6 after finalization an advance above the outstanding amount is FN023; exactly the outstanding amount succeeds", async () => {
    const periodId = await openWithSalary(1000);
    await makePayment(periodId, 400, { purpose: "advance" }, world.owner);
    await finalize(periodId);
    const digest = await periodDigest(periodId);
    expect(failure(await recordPayment(O(), pay(periodId, { purpose: "advance", amount: 600.01 })))).toBe("FN023");
    expect(await periodDigest(periodId)).toBe(digest);
    const ok = await expectOk(await recordPayment(O(), pay(periodId, { purpose: "advance", amount: 600 })));
    expect(ok.paymentState).toBe("paid");
  });

  it("ADV7 voiding the advance grows the outstanding amount back, lowers A and keeps the row", async () => {
    const periodId = await openWithSalary(1000);
    const adv = await makePayment(periodId, 300, { purpose: "advance" }, world.owner);
    expect((await expectOk(await getPeriod(O(), periodId))).employeeOutstanding).toBe(700);
    await expectOk(await voidPayment(O(), adv.paymentId!, "avans iptal"));
    const detail = await expectOk(await getPeriod(O(), periodId));
    expect([detail.employeeOutstanding, detail.advances, detail.paid]).toEqual([1000, 0, 0]);
    expect(await paymentRows(periodId)).toHaveLength(1);
  });

  it("ADV8 the narrow reopen: an advance recorded after finalization blocks it (FN027); one recorded before does not", async () => {
    const before = await openWithSalary(1000);
    await makePayment(before, 200, { purpose: "advance" }, world.owner);
    const f = await finalize(before);
    expect((await expectOk(await reopenPeriod(O(), { periodId: before, reason: "düzelt", expectedVersion: f.version }))).lifecycle).toBe("open");
    const after = await openWithSalary(1000);
    const f2 = await finalize(after);
    const adv = await expectOk(await recordPayment(O(), pay(after, { purpose: "advance", amount: 200 })));
    expect(adv.version).toBe(f2.version + 1);
    expect(failure(await reopenPeriod(O(), { periodId: after, reason: "düzelt", expectedVersion: adv.version }))).toBe("FN027");
  });

  it("ADV9 overpaid appears and disappears as earning lines and payments change in an open period", async () => {
    const p = await makePeriod(world);
    const state = async () => (await periodRow(p.periodId)).payment_state;
    expect(await state()).toBe("nothing_due");
    const pay1 = await makePayment(p.periodId, 500, { purpose: "advance" }, world.owner);
    expect(await state()).toBe("overpaid");
    const sal = await makeLine(p.periodId, "salary", 800, {}, world.owner);
    expect(await state()).toBe("partially_paid");
    const l2 = await makeLine(p.periodId, "other_deduction", 400, {}, world.owner);
    expect(await state()).toBe("overpaid"); // net 400 < paid 500
    await expectOk(await voidLine(O(), { lineId: l2.lineId!, reason: "iptal", expectedVersion: (await periodRow(p.periodId)).version }));
    expect(await state()).toBe("partially_paid");
    await expectOk(await voidPayment(O(), pay1.paymentId!, "iptal"));
    expect(await state()).toBe("unpaid");
    expect(sal.lineId).toBeTruthy();
  });

  it("ADV10 / R3 no double count: the advance is exactly one row, N has no input from it, R = N - P (example vector)", async () => {
    const p = await makePeriod(world);
    for (const [kind, amount] of [
      ["salary", 30000], ["commission", 3000], ["overtime", 2000],
      ["employee_social_insurance", 2500], ["employee_provident_fund", 1500], ["paye", 1000],
      ["employer_social_insurance", 3500], ["employer_provident_fund", 1500],
    ] as const) {
      await makeLine(p.periodId, kind, amount, {}, world.owner);
    }
    const lineCount = (await lineRows(p.periodId)).length;
    await makePayment(p.periodId, 10000, { purpose: "advance" }, world.owner);
    await makePayment(p.periodId, 15000, { purpose: "salary", method: "bank_transfer" }, world.owner);
    expect((await paymentRows(p.periodId)).filter((r) => r.purpose === "advance")).toHaveLength(1);
    expect((await lineRows(p.periodId)).length).toBe(lineCount);
    const d = await expectOk(await getPeriod(O(), p.periodId));
    expect(d).toMatchObject({
      grossEntitlement: 35000, employeeDeductions: 5000, paye: 1000, netPayable: 30000, paid: 25000, advances: 10000,
      employeeOutstanding: 5000, paidInExcess: 0, employerCost: 5000, personnelCost: 40000,
      socialInsurance: { employee: 2500, employer: 3500 }, providentFund: { employee: 1500, employer: 1500 },
    });
  });
});

// =================================================================================================================
// Y — staff payments
// =================================================================================================================
describe("Y staff payments", () => {
  it("Y1 one partial payment: partially_paid, version +1", async () => {
    const periodId = await openWithSalary(1000);
    const v = (await periodRow(periodId)).version;
    const out = await expectOk(await recordPayment(O(), pay(periodId, { amount: 300 })));
    expect([out.paymentState, out.version]).toEqual(["partially_paid", v + 1]);
  });

  it("Y2 the example: N 30,000, payments 15,000 then 10,000 give P 25,000 and R 5,000", async () => {
    const periodId = await openWithSalary(30000);
    await makePayment(periodId, 15000, {}, world.owner);
    await makePayment(periodId, 10000, {}, world.owner);
    const d = await expectOk(await getPeriod(O(), periodId));
    expect([d.paid, d.employeeOutstanding, d.paymentState]).toEqual([25000, 5000, "partially_paid"]);
  });

  it("Y3 mixed methods (cash, card, bank transfer, other) are all accepted on one period", async () => {
    const periodId = await openWithSalary(1000);
    for (const method of ["cash", "card", "bank_transfer", "other"]) {
      await makePayment(periodId, 10, { method }, world.owner);
    }
    expect((await paymentRows(periodId)).map((r) => r.method).sort()).toEqual(["bank_transfer", "card", "cash", "other"]);
  });

  it("Y4 / Y5 / L13 finalized: exactly the outstanding amount is paid, the outstanding amount plus 0.01 is FN023; once paid every further payment is FN023; a void works", async () => {
    const periodId = await openWithSalary(1000);
    await makePayment(periodId, 250, {}, world.owner);
    await finalize(periodId);
    expect(failure(await recordPayment(O(), pay(periodId, { amount: 750.01 })))).toBe("FN023");
    const exact = await expectOk(await recordPayment(O(), pay(periodId, { amount: 750 })));
    expect(exact.paymentState).toBe("paid");
    expect(failure(await recordPayment(O(), pay(periodId, { amount: 0.01 })))).toBe("FN023");
    expect(failure(await recordPayment(O(), pay(periodId, { amount: 1, purpose: "advance" })))).toBe("FN023");
    const voided = await expectOk(await voidPayment(O(), exact.paymentId!, "yanlış"));
    expect(voided.paymentState).toBe("partially_paid");
  });

  it("Y6 a payment on a cancelled period is FN025", async () => {
    const periodId = await openWithSalary(1000);
    await cancelPeriod(O(), periodId, "iptal");
    const digest = await periodDigest(periodId);
    expect(failure(await recordPayment(O(), pay(periodId)))).toBe("FN025");
    expect(await periodDigest(periodId)).toBe(digest);
  });

  it("Y7 voiding a posted payment keeps the row as voided with the reason, lowers P and recomputes the state", async () => {
    const periodId = await openWithSalary(1000);
    const p1 = await makePayment(periodId, 1000, {}, world.owner);
    expect((await periodRow(periodId)).payment_state).toBe("paid");
    const out = await expectOk(await voidPayment(O(), p1.paymentId!, "yanlış kayıt"));
    expect([out.paymentState, out.noop]).toEqual(["unpaid", false]);
    const row = (await paymentRows(periodId))[0]!;
    expect([row.status, row.void_reason]).toEqual(["voided", "yanlış kayıt"]);
    expect(row.voided_at).not.toBeNull();
    expect((await periodRow(periodId)).paid_total).toBe("0.00");
  });

  it("Y8 voiding an already voided payment is a noop (reason not re-validated); Y9 voiding without a reason is FN004", async () => {
    const periodId = await openWithSalary(1000);
    const p1 = await makePayment(periodId, 100, {}, world.owner);
    expect(failure(await voidPayment(O(), p1.paymentId!, null))).toBe("FN004");
    expect(failure(await voidPayment(O(), p1.paymentId!, "  "))).toBe("FN004");
    const v1 = await expectOk(await voidPayment(O(), p1.paymentId!, "ilk"));
    const again = await expectOk(await voidPayment(O(), p1.paymentId!, "  "));
    expect([again.noop, again.version]).toEqual([true, v1.version]);
  });

  it("Y10 / A5 / A13 exactly one audit event per record and one per void, with the specified payloads and post_finalization", async () => {
    const periodId = await openWithSalary(1000);
    const a = await expectOk(await recordPayment(O(), pay(periodId, { purpose: "bonus", method: "card", amount: 100, note: "GİZLİ-NOT" })));
    await finalize(periodId);
    const b = await expectOk(await recordPayment(O(), pay(periodId, { amount: 50 })));
    const [ra] = await staffAudit(T(), "finance.staff_payment_recorded", a.paymentId!);
    expect(ra!.entity_type).toBe("staff_payment");
    expect(ra!.actor_user_id).toBe(O());
    expect(ra!.after).toMatchObject({
      period_id: periodId, purpose: "bonus", method: "card", amount: 100, currency: "TRY", post_finalization: false,
    });
    expect(JSON.stringify(ra!.after)).not.toContain("GİZLİ-NOT");
    expect(ra!.after).toHaveProperty("paid_at");
    const [rb] = await staffAudit(T(), "finance.staff_payment_recorded", b.paymentId!);
    expect(rb!.after).toMatchObject({ post_finalization: true });
    await voidPayment(O(), a.paymentId!, "yanlış");
    await voidPayment(O(), a.paymentId!, "yine");
    const voids = await staffAudit(T(), "finance.staff_payment_voided", a.paymentId!);
    expect(voids).toHaveLength(1);
    expect(voids[0]!.before).toEqual({ status: "posted" });
    expect(voids[0]!.after).toMatchObject({ status: "voided", period_id: periodId, amount: 100, reason: "yanlış" });
    expect(await staffAudit(T(), "finance.staff_payment_recorded", a.paymentId!)).toHaveLength(1);
  });

  it("Y11 voided payments are excluded from every total", async () => {
    const periodId = await openWithSalary(1000);
    const a = await makePayment(periodId, 300, { purpose: "advance" }, world.owner);
    await makePayment(periodId, 100, {}, world.owner);
    await voidPayment(O(), a.paymentId!, "iptal");
    const d = await expectOk(await getPeriod(O(), periodId));
    expect([d.paid, d.advances]).toEqual([100, 0]);
    const ov = await expectOk(await getOverview(O(), { tenantId: T(), month: "2026-09-01" }));
    expect(ov.periods.find((r) => r.periodId === periodId)).toMatchObject({ paid: 100, advances: 0 });
  });

  it("Y12 a voided payment's key: the same payload is a noop, a different payload is FN007", async () => {
    const periodId = await openWithSalary(1000);
    const input = pay(periodId, { amount: 100 });
    const first = await expectOk(await recordPayment(O(), input));
    await voidPayment(O(), first.paymentId!, "iptal");
    expect((await expectOk(await recordPayment(O(), input))).noop).toBe(true);
    expect(failure(await recordPayment(O(), { ...input, amount: 101 }))).toBe("FN007");
  });

  it("Y13 raising the earning total after payments grows the outstanding amount; payments up to it succeed on a finalized period", async () => {
    const periodId = await openWithSalary(1000);
    await makePayment(periodId, 1000, {}, world.owner);
    await finalize(periodId);
    expect(failure(await recordPayment(O(), pay(periodId, { amount: 0.01 })))).toBe("FN023");
    await expectOk(await addLine(O(), { periodId, kind: "adjustment_credit", amount: 500, description: "Düzeltme", idempotencyKey: newKey() }));
    expect((await expectOk(await getPeriod(O(), periodId))).flags.maxPayable).toBe(500);
    expect(failure(await recordPayment(O(), pay(periodId, { amount: 500.01 })))).toBe("FN023");
    expect((await expectOk(await recordPayment(O(), pay(periodId, { amount: 500 })))).paymentState).toBe("paid");
  });

  it("Y14 raw SQL edits of payment columns are FN032", async () => {
    const periodId = await openWithSalary(1000);
    const p1 = await makePayment(periodId, 100, {}, world.owner);
    for (const set of ["amount = 5", "method = 'card'", "purpose = 'bonus'", "note = 'x'", "paid_at = now()", "post_finalization = true"]) {
      await expect(testDb.unsafe(`update staff_payments set ${set} where id = '${p1.paymentId}'`), set).rejects.toMatchObject({ code: "FN032" });
    }
  });

  it("Y18 post_finalization is true when recorded on a finalized period, false when open, and immutable", async () => {
    const periodId = await openWithSalary(1000);
    const open = await makePayment(periodId, 100, {}, world.owner);
    await finalize(periodId);
    const post = await makePayment(periodId, 100, {}, world.owner);
    const rows = await paymentRows(periodId);
    expect(rows.find((r) => r.id === open.paymentId)!.post_finalization).toBe(false);
    expect(rows.find((r) => r.id === post.paymentId)!.post_finalization).toBe(true);
    await expect(
      testDb.unsafe(`update staff_payments set post_finalization = false where id = '${post.paymentId}'`),
    ).rejects.toMatchObject({ code: "FN032" });
  });

  it("a payment recorded for a period of another tenant is FN002 for the foreign owner, a random period is FN020", async () => {
    const periodId = await openWithSalary(1000);
    expect(failure(await recordPayment(world.otherOwner.id, pay(periodId)))).toBe("FN002");
    expect(failure(await recordPayment(O(), pay("00000000-0000-4000-8000-000000000f07")))).toBe("FN020");
    expect((await counts(T())).payments).toBeGreaterThanOrEqual(0);
  });
});
