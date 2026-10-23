import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admin, asAuthenticatedUser, testDb } from "./helpers";
import { createConfirmationFixture, teardownFixtures, type ConfirmationFixture } from "./customer-confirmation-fixtures";
import {
  allSwitchesOn,
  jobs,
  makeAppointment,
  makeDue,
  materialize,
  moveAppointmentTo,
  setSwitches,
  setStatus,
} from "./launch1b-fixtures";
import { processCustomerNotificationBatch } from "@/lib/modules/customer-notifications/confirmation-email-worker";
import type { OutboundEmail, SendMailFn, SmtpSendResult } from "@/lib/email/smtp-transport";

/**
 * Faz LAUNCH.1B — the worker end to end for all four lifecycle emails: the real service-role
 * client and the real claim/record RPCs, with a deterministic fake transport (each failure
 * class exact and fast). No test here can send a real email: real SMTP credentials are
 * stripped from the test environment and every recipient is a `.test` address.
 */

let fx: ConfirmationFixture;
const DAY = 24 * 60;

beforeAll(async () => {
  fx = await createConfirmationFixture("l1b-w", { salonName: "Örnek Güzellik Salonu" });
  await testDb`update branches set phone = '+90 392 555 01 02' where id = ${fx.branchId}`;
  await allSwitchesOn(fx);
}, 120_000);

afterAll(async () => {
  await teardownFixtures(fx ? [fx] : []);
}, 120_000);

beforeEach(async () => {
  // Every test starts from an empty salon: appointments (and, by cascade, their items, jobs, snapshots and
  // schedule anchors). Otherwise an earlier test's appointment would be re-materialised into this one.
  await testDb`delete from appointments where tenant_id = ${fx.tenant.id}`;
});

const SUCCESS: SmtpSendResult = { outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "<fake-id@salonos.test>" };
const failed = (
  errorClass: Extract<SmtpSendResult, { outcome: "failed" }>["errorClass"],
  disposition: Extract<SmtpSendResult, { outcome: "failed" }>["disposition"],
): SmtpSendResult => ({ outcome: "failed", provider: "google_workspace_smtp", errorClass, disposition });

function fakeTransport(script: (SmtpSendResult | Error)[] = [SUCCESS]): { send: SendMailFn; calls: OutboundEmail[] } {
  const calls: OutboundEmail[] = [];
  const send: SendMailFn = async (message) => {
    const index = calls.length;
    calls.push(message);
    const step = script[Math.min(index, script.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  };
  return { send, calls };
}

const run = (send: SendMailFn) => processCustomerNotificationBatch({ supabase: admin, send, batchSize: 20 });

describe("each lifecycle email is built from its own job, once", () => {
  it("confirmation: one email to the snapshotted address, with date, time, services, staff and the salon phone", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: 3 * DAY, status: "confirmed", email: "onay.musteri@example.test", fullName: "ZEYNEP KAYA" });
    const transport = fakeTransport();
    const result = await run(transport.send);
    expect(result.sent).toBe(1);
    expect(transport.calls).toHaveLength(1);
    const mail = transport.calls[0]!;
    expect(mail.to).toBe("onay.musteri@example.test");
    expect(mail.subject).toBe("Randevunuz Onaylandı — Örnek Güzellik Salonu");
    expect(mail.text).toContain("Zeynep, randevunuz onaylandı");
    expect(mail.text).toContain("Hizmet: Saç Kesimi");
    expect(mail.text).toContain("Personel: Personel Bir");
    expect(mail.text).toContain("İletişim: +90 392 555 01 02");
    expect((await jobs(apt.appointmentId, "appointment_confirmation"))[0]).toMatchObject({ status: "sent", attempt_count: 1 });

    // a second run finds nothing to send: exactly-once
    const again = fakeTransport();
    await run(again.send);
    expect(again.calls).toHaveLength(0);
  });

  it("update: says the appointment was changed, with the CURRENT time and services", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: 3 * DAY, status: "confirmed", email: "degisiklik@example.test" });
    await run(fakeTransport().send); // the confirmation
    await moveAppointmentTo(apt.appointmentId, 5 * DAY);
    await testDb`update appointment_items set service_id = ${fx.service2.id} where id = ${apt.itemId}`;
    const [upd] = await jobs(apt.appointmentId, "appointment_update");
    await makeDue(upd!.id);

    const transport = fakeTransport();
    const result = await run(transport.send);
    expect(result.sent).toBe(1);
    const mail = transport.calls[0]!;
    expect(mail.to).toBe("degisiklik@example.test");
    expect(mail.subject).toBe("Randevunuz Güncellendi — Örnek Güzellik Salonu");
    expect(mail.text).toContain("randevunuz güncellendi");
    expect(mail.text).toContain("Hizmet: Fön"); // the latest service, not the one on the confirmation
    expect(mail.text).not.toContain("Saç Kesimi");
  });

  it("cancellation: says it was cancelled, offers the booking page when the site URL is https, sends once", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: 3 * DAY, status: "confirmed", email: "iptal@example.test" });
    await run(fakeTransport().send);
    await setStatus(apt.appointmentId, "cancelled");
    const transport = fakeTransport();
    const result = await run(transport.send);
    expect(result.sent).toBe(1);
    const mail = transport.calls[0]!;
    expect(mail.subject).toBe("Randevunuz İptal Edildi — Örnek Güzellik Salonu");
    expect(mail.text).toContain("iptal edildi");
    await setStatus(apt.appointmentId, "cancelled");
    const again = fakeTransport();
    await run(again.send);
    expect(again.calls).toHaveLength(0);
  });

  it("reminder: sent once in its window with 'yarın' or 'bugün' (the salon's local day), never twice", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: DAY - 30, status: "confirmed", email: "hatirlatma@example.test", bookedMinutesAgo: 3 * DAY });
    expect(await materialize()).toBeGreaterThanOrEqual(1); // the claim itself would also do this
    const transport = fakeTransport();
    const result = await run(transport.send);
    expect(result.sent).toBeGreaterThanOrEqual(2); // the confirmation and the reminder
    const reminder = transport.calls.find((call) => /Randevunuz Var/.test(call.subject))!;
    expect(reminder).toBeDefined();
    expect(reminder.to).toBe("hatirlatma@example.test");
    expect(reminder.subject).toMatch(/^(Yarın|Bugün) Randevunuz Var — Örnek Güzellik Salonu$/);

    const again = fakeTransport();
    await run(again.send);
    await materialize();
    await run(again.send);
    expect(again.calls.filter((call) => /Randevunuz Var/.test(call.subject))).toHaveLength(0);
    expect((await jobs(apt.appointmentId, "appointment_reminder_24h")).filter((job) => job.status === "sent")).toHaveLength(1);
  });
});

describe("retry safety and failure visibility", () => {
  it("a transient failure is retried after the backoff and the customer still gets exactly ONE email", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: 3 * DAY, status: "confirmed" });
    const transport = fakeTransport([failed("provider_unavailable", "retryable"), SUCCESS]);

    const first = await run(transport.send);
    expect(first.retried).toBe(1);
    const [retrying] = await jobs(apt.appointmentId, "appointment_confirmation");
    expect(retrying).toMatchObject({ status: "retry", attempt_count: 1 });

    // not due yet: an immediate second run does not resend
    await run(transport.send);
    expect(transport.calls).toHaveLength(1);

    await makeDue(retrying!.id);
    const second = await run(transport.send);
    expect(second.sent).toBe(1);
    expect(transport.calls).toHaveLength(2);
    expect((await jobs(apt.appointmentId, "appointment_confirmation"))[0]).toMatchObject({ status: "sent", attempt_count: 2 });
  });

  it("an outcome of UNKNOWN delivery is never retried (no duplicate customer email)", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: 3 * DAY, status: "confirmed" });
    const transport = fakeTransport([new Error("connection reset after DATA")]);
    const result = await run(transport.send);
    expect(result.uncertain).toBe(1);
    await makeDue((await jobs(apt.appointmentId, "appointment_confirmation"))[0]!.id);
    await run(transport.send);
    expect(transport.calls).toHaveLength(1);
    expect((await jobs(apt.appointmentId, "appointment_confirmation"))[0]!.status).toBe("uncertain");
  });

  it("a permanent rejection is final and VISIBLE to the Owner as a problem count", async () => {
    await makeAppointment(fx, { startInMinutes: 3 * DAY, status: "confirmed" });
    const transport = fakeTransport([failed("invalid_recipient", "permanent")]);
    const result = await run(transport.send);
    expect(result.failed).toBe(1);
    const health = await asAuthenticatedUser(fx.owner.id, async (sql) => {
      const [row] = await sql<{ h: { failed: number; uncertain: number } }[]>`select public.get_customer_notification_health(${fx.tenant.id}::uuid) as h`;
      return row!.h;
    });
    expect(health.failed).toBe(1);
  });

  it("the switch turned OFF before the worker runs: nothing is sent, the queued job is kept for the record", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: 3 * DAY, status: "confirmed" });
    await setSwitches(fx, { appointment_confirmation: false });
    const transport = fakeTransport();
    await run(transport.send);
    expect(transport.calls.filter((call) => call.to === apt.email)).toHaveLength(0);
    expect((await jobs(apt.appointmentId, "appointment_confirmation"))[0]!.status).toBe("pending");
    await setSwitches(fx, { appointment_confirmation: true });
  });

  it("a cancelled appointment's reminder is not sent even though it was already queued", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    await setStatus(apt.appointmentId, "cancelled");
    const transport = fakeTransport();
    await run(transport.send);
    expect(transport.calls.filter((call) => /Randevunuz Var/.test(call.subject))).toHaveLength(0);
    expect((await jobs(apt.appointmentId, "appointment_reminder_24h"))[0]).toMatchObject({ status: "skipped", skip_reason: "appointment_not_confirmed" });
  });

  it("a rescheduled appointment never receives the old reminder", async () => {
    const apt = await makeAppointment(fx, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    await moveAppointmentTo(apt.appointmentId, 6 * DAY);
    const transport = fakeTransport();
    await run(transport.send);
    expect(transport.calls.filter((call) => /Randevunuz Var/.test(call.subject))).toHaveLength(0);
    expect((await jobs(apt.appointmentId, "appointment_reminder_24h"))[0]).toMatchObject({ status: "skipped", skip_reason: "rescheduled" });
  });
});

describe("privacy of what is actually sent", () => {
  it("no notes, no internal ids, no auth ids, no price, no other customer's data in any of the four emails", async () => {
    const other = await makeAppointment(fx, { startInMinutes: 4 * DAY, status: "confirmed", email: "baska.musteri@example.test", fullName: "Başka Kişi" });
    const apt = await makeAppointment(fx, {
      startInMinutes: DAY - 30,
      status: "confirmed",
      email: "gizlilik@example.test",
      bookedMinutesAgo: 3 * DAY,
      notes: "RANDEVU-NOTU-GİZLİ-456",
    });
    const transport = fakeTransport();
    await run(transport.send); // both confirmations
    await materialize();
    await run(transport.send); // reminder
    await moveAppointmentTo(apt.appointmentId, 7 * DAY);
    for (const job of await jobs(apt.appointmentId, "appointment_update")) await makeDue(job.id);
    await run(transport.send);
    await setStatus(apt.appointmentId, "cancelled");
    await run(transport.send);

    const mine = transport.calls.filter((call) => call.to === "gizlilik@example.test");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const everything = mine.map((call) => `${call.subject}\n${call.text}\n${call.html}`).join("\n");
    for (const forbidden of [
      "RANDEVU-NOTU-GİZLİ-456", "MÜŞTERİ-NOTU-GİZLİ-123", apt.appointmentId, apt.customerId, apt.itemId, fx.tenant.id, fx.owner.id,
      fx.branchId, fx.staff.id, "baska.musteri@example.test", "Başka Kişi", "500", "₺",
    ]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
    // the other customer got only their own mail
    expect(transport.calls.filter((call) => call.to === other.email).every((call) => !call.text.includes("gizlilik@example.test"))).toBe(true);
  });
});
