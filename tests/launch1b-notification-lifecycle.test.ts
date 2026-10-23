import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthenticatedUser,
  auditRows,
  createTestMembershipFromTemplate,
  createTestUser,
  testDb,
  type TestUser,
} from "./helpers";
import { createConfirmationFixture, teardownFixtures, type ConfirmationFixture } from "./customer-confirmation-fixtures";
import {
  allSwitchesOn,
  claim,
  jobs,
  makeAppointment,
  makeDue,
  markSent,
  materialize,
  moveAppointmentTo,
  setAnchorAge,
  setStatus,
  setSwitches,
} from "./launch1b-fixtures";

/**
 * Faz LAUNCH.1B — the customer-notification lifecycle in the database: confirmation,
 * change, cancellation, the 24 h reminder, the owner's switches and their authorization.
 * Every appointment is placed at an exact offset from the database's now(); nothing is
 * sent here (the DATABASE never sends — it records that a send is due and decides, at
 * claim time, whether it still should be).
 */

let fxA: ConfirmationFixture; // all four switches ON
let fxB: ConfirmationFixture; // a second salon, ALL OFF
let fxC: ConfirmationFixture; // a third salon: only the reminder ON
let manager: TestUser;
let stylist: TestUser;

beforeAll(async () => {
  fxA = await createConfirmationFixture("l1b-a", { salonName: "Gökhan İlhan Hair Studio" });
  fxB = await createConfirmationFixture("l1b-b");
  fxC = await createConfirmationFixture("l1b-c");
  manager = await createTestUser("l1b-manager");
  stylist = await createTestUser("l1b-stylist");
  await createTestMembershipFromTemplate(fxA.tenant.id, manager.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(fxA.tenant.id, stylist.id, "STYLIST");
  await allSwitchesOn(fxA);
  await setSwitches(fxC, { appointment_reminder_24h: true });
}, 120_000);

afterAll(async () => {
  await teardownFixtures([fxA, fxB, fxC].filter(Boolean), [manager, stylist].filter(Boolean));
}, 120_000);

const DAY = 24 * 60;

describe("CONFIRMATION", () => {
  it("enabled: the first move to confirmed records exactly one pending job; the claim carries what the email needs and nothing internal", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed", email: "ayse.onay@example.test" });
    const list = await jobs(apt.appointmentId, "appointment_confirmation");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "pending", dedupe_revision: "0", skip_reason: null });

    const claimed = (await claim([fxA.slug])).filter((job) => job.jobId === list[0]!.id);
    expect(claimed).toHaveLength(1);
    const job = claimed[0]!;
    expect(job).toMatchObject({
      notificationType: "appointment_confirmation",
      recipientEmail: "ayse.onay@example.test",
      greetingName: "Ayşe",
      salonName: "Gökhan İlhan Hair Studio",
      tenantSlug: fxA.slug,
      serviceNames: ["Saç Kesimi"],
      staffNames: ["Personel Bir"],
    });
    // PRIVACY: exactly these keys; no notes, ids, prices, customer record data.
    expect(Object.keys(job).sort()).toEqual(
      [
        "appointmentStartAt", "attemptCount", "contactPhone", "greetingName", "jobId", "lockToken", "locationUrl",
        "notificationType", "recipientEmail", "salonName", "serviceNames", "staffNames", "tenantSlug", "tenantTimezone",
      ].sort(),
    );
    const serialized = JSON.stringify(job);
    for (const secret of ["MÜŞTERİ-NOTU-GİZLİ-123", "RANDEVU-NOTU-GİZLİ-456", apt.appointmentId, apt.customerId, fxA.tenant.id, fxA.owner.id]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("disabled for the salon: no job at all; other salons' state is irrelevant", async () => {
    const apt = await makeAppointment(fxB, { startInMinutes: 3 * DAY, status: "confirmed" });
    expect(await jobs(apt.appointmentId)).toHaveLength(0);
    // fxA being fully ON does not leak into fxB
    expect((await claim([fxB.slug])).filter((job) => job.tenantSlug === fxB.slug)).toHaveLength(0);
  });

  it("no e-mail on file: a skipped job with a reason (no error, the appointment is untouched)", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed", email: null });
    const list = await jobs(apt.appointmentId, "appointment_confirmation");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "skipped", skip_reason: "no_recipient" });
    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${apt.appointmentId}`;
    expect(row!.status).toBe("confirmed");
  });

  it("a malformed address is never snapshotted (no recipient)", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed", email: "not-an-address" });
    expect((await jobs(apt.appointmentId, "appointment_confirmation"))[0]).toMatchObject({ status: "skipped", skip_reason: "no_recipient" });
  });

  it("a duplicate event does not double: confirming again, or flipping the status back and forth, still leaves one job", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    await setStatus(apt.appointmentId, "scheduled");
    await setStatus(apt.appointmentId, "confirmed");
    await setStatus(apt.appointmentId, "scheduled");
    await setStatus(apt.appointmentId, "confirmed");
    expect(await jobs(apt.appointmentId, "appointment_confirmation")).toHaveLength(1);
  });

  it("the switch is re-checked when the job is claimed: turned OFF after queueing, the job is not handed out, and stays queued for the record", async () => {
    await setSwitches(fxC, { appointment_confirmation: true });
    const apt = await makeAppointment(fxC, { startInMinutes: 3 * DAY, status: "scheduled" }); // created AFTER the switch: snapshot captured
    await testDb`update appointments set status = 'confirmed' where id = ${apt.appointmentId}`;
    const [queued] = await jobs(apt.appointmentId, "appointment_confirmation");
    expect(queued!.status).toBe("pending");

    await setSwitches(fxC, { appointment_confirmation: false });
    expect((await claim([fxC.slug])).filter((job) => job.jobId === queued!.id)).toHaveLength(0);
    expect((await jobs(apt.appointmentId, "appointment_confirmation"))[0]!.status).toBe("pending");
  });

  it("a queued job that sat longer than 48 hours is stale: skipped at claim time instead of mailed late", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    const [conf] = await jobs(apt.appointmentId, "appointment_confirmation");
    await testDb`update private.customer_notification_jobs set created_at = now() - interval '49 hours' where id = ${conf!.id}`;
    await claim([fxA.slug]);
    expect((await jobs(apt.appointmentId, "appointment_confirmation"))[0]).toMatchObject({ status: "skipped", skip_reason: "stale" });

    const fresh = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    const [ok] = await jobs(fresh.appointmentId, "appointment_confirmation");
    await testDb`update private.customer_notification_jobs set created_at = now() - interval '47 hours' where id = ${ok!.id}`;
    const claimed = (await claim([fxA.slug])).filter((job) => job.jobId === ok!.id);
    expect(claimed).toHaveLength(1);
  });

  it("a cancelled appointment's pending confirmation is skipped at claim time, never sent", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    await setStatus(apt.appointmentId, "cancelled");
    const [conf] = await jobs(apt.appointmentId, "appointment_confirmation");
    await claim([fxA.slug]);
    const after = (await jobs(apt.appointmentId, "appointment_confirmation"))[0]!;
    expect(after.id).toBe(conf!.id);
    expect(after).toMatchObject({ status: "skipped", skip_reason: "appointment_not_confirmed" });
  });

  it("stale payload: a pending confirmation reads the LATEST appointment state when claimed", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    await moveAppointmentTo(apt.appointmentId, 5 * DAY);
    const [conf] = await jobs(apt.appointmentId, "appointment_confirmation");
    const claimed = (await claim([fxA.slug])).find((job) => job.jobId === conf!.id)!;
    const [row] = await testDb<{ start: Date }[]>`select scheduled_start_at as start from appointments where id = ${apt.appointmentId}`;
    expect(new Date(claimed.appointmentStartAt).getTime()).toBe(row!.start.getTime());
    // and no update job: the customer was never told about the first time
    expect(await jobs(apt.appointmentId, "appointment_update")).toHaveLength(0);
  });
});

describe("UPDATE", () => {
  async function confirmedAndSent(options: { startInMinutes?: number } = {}) {
    const apt = await makeAppointment(fxA, { startInMinutes: options.startInMinutes ?? 3 * DAY, status: "confirmed" });
    const [conf] = await jobs(apt.appointmentId, "appointment_confirmation");
    await markSent(conf!.id);
    return apt;
  }

  it("a reschedule after the customer was told records one update job (revision 1) and the claim carries the new time", async () => {
    const apt = await confirmedAndSent();
    await moveAppointmentTo(apt.appointmentId, 4 * DAY);
    const list = await jobs(apt.appointmentId, "appointment_update");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "pending", dedupe_revision: "1" });

    await makeDue(list[0]!.id);
    const claimed = (await claim([fxA.slug])).find((job) => job.jobId === list[0]!.id)!;
    expect(claimed.notificationType).toBe("appointment_update");
    const [row] = await testDb<{ start: Date }[]>`select scheduled_start_at as start from appointments where id = ${apt.appointmentId}`;
    expect(new Date(claimed.appointmentStartAt).getTime()).toBe(row!.start.getTime());
  });

  it("several changes in a row coalesce into the one pending update (and it always shows the latest state)", async () => {
    const apt = await confirmedAndSent();
    await moveAppointmentTo(apt.appointmentId, 4 * DAY);
    await moveAppointmentTo(apt.appointmentId, 5 * DAY);
    await moveAppointmentTo(apt.appointmentId, 6 * DAY);
    const list = await jobs(apt.appointmentId, "appointment_update");
    expect(list).toHaveLength(1);
    await makeDue(list[0]!.id);
    const claimed = (await claim([fxA.slug])).find((job) => job.jobId === list[0]!.id)!;
    const [row] = await testDb<{ start: Date }[]>`select scheduled_start_at as start from appointments where id = ${apt.appointmentId}`;
    expect(new Date(claimed.appointmentStartAt).getTime()).toBe(row!.start.getTime());
  });

  it("a change AFTER an update was sent starts the next revision", async () => {
    const apt = await confirmedAndSent();
    await moveAppointmentTo(apt.appointmentId, 4 * DAY);
    const [first] = await jobs(apt.appointmentId, "appointment_update");
    await markSent(first!.id);
    await moveAppointmentTo(apt.appointmentId, 5 * DAY);
    const list = await jobs(apt.appointmentId, "appointment_update");
    expect(list.map((job) => [job.dedupe_revision, job.status])).toEqual([["1", "sent"], ["2", "pending"]]);
  });

  it("a service change and a staff change are customer-visible changes too", async () => {
    const apt = await confirmedAndSent();
    await testDb`update appointment_items set service_id = ${fxA.service2.id} where id = ${apt.itemId}`;
    expect(await jobs(apt.appointmentId, "appointment_update")).toHaveLength(1);

    const apt2 = await confirmedAndSent();
    const [other] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${fxA.tenant.id}, 'Personel İki') returning id
    `;
    await testDb`update appointment_items set staff_member_id = ${other!.id} where id = ${apt2.itemId}`;
    expect(await jobs(apt2.appointmentId, "appointment_update")).toHaveLength(1);
  });

  it("a change that is not customer-visible (price, performer) records nothing", async () => {
    const apt = await confirmedAndSent();
    await testDb`update appointment_items set price = 900 where id = ${apt.itemId}`;
    await testDb`update appointment_items set actual_staff_member_id = ${fxA.staff.id} where id = ${apt.itemId}`;
    await testDb`update appointments set notes = 'başka bir not' where id = ${apt.appointmentId}`;
    expect(await jobs(apt.appointmentId, "appointment_update")).toHaveLength(0);
  });

  it("disabled for the salon: nothing; cancelled appointment: nothing", async () => {
    await setSwitches(fxA, { appointment_update: false });
    const apt = await confirmedAndSent();
    await moveAppointmentTo(apt.appointmentId, 4 * DAY);
    expect(await jobs(apt.appointmentId, "appointment_update")).toHaveLength(0);
    await setSwitches(fxA, { appointment_update: true });

    const apt2 = await confirmedAndSent();
    await setStatus(apt2.appointmentId, "cancelled");
    await moveAppointmentTo(apt2.appointmentId, 4 * DAY);
    expect(await jobs(apt2.appointmentId, "appointment_update")).toHaveLength(0);
  });

  it("no recipient: nothing (an update never invents an address)", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed", email: null });
    await moveAppointmentTo(apt.appointmentId, 4 * DAY);
    expect(await jobs(apt.appointmentId, "appointment_update")).toHaveLength(0);
  });

  it("an update whose appointment was cancelled meanwhile is skipped at claim time", async () => {
    const apt = await confirmedAndSent();
    await moveAppointmentTo(apt.appointmentId, 4 * DAY);
    const [upd] = await jobs(apt.appointmentId, "appointment_update");
    await setStatus(apt.appointmentId, "cancelled");
    await makeDue(upd!.id);
    await claim([fxA.slug]);
    expect((await jobs(apt.appointmentId, "appointment_update"))[0]).toMatchObject({ status: "skipped", skip_reason: "appointment_not_confirmed" });
  });
});

describe("CANCELLATION", () => {
  it("cancelling records exactly one job; the claim says it is a cancellation; a duplicate cancel does not double it", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed", email: "iptal.musteri@example.test" });
    await setStatus(apt.appointmentId, "cancelled");
    await setStatus(apt.appointmentId, "cancelled"); // no status change: the trigger does not fire
    const list = await jobs(apt.appointmentId, "appointment_cancellation");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "pending", dedupe_revision: "0" });

    const claimed = (await claim([fxA.slug])).find((job) => job.jobId === list[0]!.id)!;
    expect(claimed).toMatchObject({ notificationType: "appointment_cancellation", recipientEmail: "iptal.musteri@example.test" });
  });

  it("an appointment that was never confirmed can still be cancelled with a notice", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "scheduled" });
    await setStatus(apt.appointmentId, "cancelled");
    expect((await jobs(apt.appointmentId, "appointment_cancellation"))[0]).toMatchObject({ status: "pending" });
  });

  it("disabled: no job. No recipient: a skipped job. Already started: skipped at claim time", async () => {
    await setSwitches(fxA, { appointment_cancellation: false });
    const off = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    await setStatus(off.appointmentId, "cancelled");
    expect(await jobs(off.appointmentId, "appointment_cancellation")).toHaveLength(0);
    await setSwitches(fxA, { appointment_cancellation: true });

    const noMail = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed", email: null });
    await setStatus(noMail.appointmentId, "cancelled");
    expect((await jobs(noMail.appointmentId, "appointment_cancellation"))[0]).toMatchObject({ status: "skipped", skip_reason: "no_recipient" });

    const late = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    await setStatus(late.appointmentId, "cancelled");
    const [job] = await jobs(late.appointmentId, "appointment_cancellation");
    await testDb`update appointments set scheduled_start_at = now() - interval '1 hour', scheduled_end_at = now() - interval '30 minutes' where id = ${late.appointmentId}`;
    await claim([fxA.slug]);
    expect((await jobs(late.appointmentId, "appointment_cancellation"))[0]).toMatchObject({ id: job!.id, status: "skipped", skip_reason: "appointment_started" });
  });

  it("tenant isolation: a cancellation in salon A never produces a job in salon B", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    await setStatus(apt.appointmentId, "cancelled");
    const rows = await testDb<{ tenant_id: string }[]>`select tenant_id from private.customer_notification_jobs where appointment_id = ${apt.appointmentId}`;
    expect(rows.every((row) => row.tenant_id === fxA.tenant.id)).toBe(true);
  });
});

describe("REMINDER (24 h)", () => {
  it("its moment arrived (23 h 30 min before the start) and the booking is older: exactly one job, created once, claimed once", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    expect(await materialize()).toBeGreaterThanOrEqual(1);
    expect(await materialize()).toBe(0); // idempotent
    const list = await jobs(apt.appointmentId, "appointment_reminder_24h");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "pending" });
    expect(list[0]!.target_start_at).not.toBeNull();

    const first = (await claim([fxA.slug])).filter((job) => job.jobId === list[0]!.id);
    const second = (await claim([fxA.slug])).filter((job) => job.jobId === list[0]!.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.notificationType).toBe("appointment_reminder_24h");
    expect(second).toHaveLength(0);

    await markSent(list[0]!.id);
    await materialize();
    expect(await jobs(apt.appointmentId, "appointment_reminder_24h")).toHaveLength(1); // exactly one successful reminder
  });

  it("not yet due (starts in 25 h): nothing", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: DAY + 60, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    expect(await jobs(apt.appointmentId, "appointment_reminder_24h")).toHaveLength(0);
  });

  it("the delivery window is bounded: a reminder moment that is more than 3 hours old is skipped, not sent late", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: DAY - 4 * 60, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    expect(await jobs(apt.appointmentId, "appointment_reminder_24h")).toHaveLength(0);
    const inside = await makeAppointment(fxA, { startInMinutes: DAY - 170, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    expect(await jobs(inside.appointmentId, "appointment_reminder_24h")).toHaveLength(1);
  });

  it("an appointment booked LESS than 24 h before its start never gets a 'tomorrow' reminder", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: DAY - 60, status: "confirmed" }); // booked just now
    await materialize();
    expect(await jobs(apt.appointmentId, "appointment_reminder_24h")).toHaveLength(0);
  });

  it("cancelled, scheduled (not confirmed), no recipient, or disabled: no reminder", async () => {
    const cancelled = await makeAppointment(fxA, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await setStatus(cancelled.appointmentId, "cancelled");
    const pending = await makeAppointment(fxA, { startInMinutes: DAY - 30, status: "scheduled", bookedMinutesAgo: 3 * DAY });
    const noMail = await makeAppointment(fxA, { startInMinutes: DAY - 30, status: "confirmed", email: null, bookedMinutesAgo: 3 * DAY });
    const other = await makeAppointment(fxB, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY }); // fxB: all OFF
    await materialize();
    for (const apt of [cancelled, pending, noMail, other]) {
      expect(await jobs(apt.appointmentId, "appointment_reminder_24h")).toHaveLength(0);
    }
  });

  it("a pending reminder of an appointment that was then CANCELLED is skipped at claim time", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    await setStatus(apt.appointmentId, "cancelled");
    await claim([fxA.slug]);
    expect((await jobs(apt.appointmentId, "appointment_reminder_24h"))[0]).toMatchObject({ status: "skipped", skip_reason: "appointment_not_confirmed" });
  });

  it("RESCHEDULED: the old pending reminder is skipped as stale; a move to a time less than 24 h away gets no new reminder", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    const [old] = await jobs(apt.appointmentId, "appointment_reminder_24h");
    await moveAppointmentTo(apt.appointmentId, DAY - 20); // moved, still inside what would be the window
    await claim([fxA.slug]);
    expect((await jobs(apt.appointmentId, "appointment_reminder_24h"))[0]).toMatchObject({ id: old!.id, status: "skipped", skip_reason: "rescheduled" });
    await materialize();
    expect(await jobs(apt.appointmentId, "appointment_reminder_24h")).toHaveLength(1); // the move happened after the reminder moment: no new one
  });

  it("RESCHEDULED far ahead, then its new reminder moment arrives: exactly one new reminder for the new time", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    const [old] = await jobs(apt.appointmentId, "appointment_reminder_24h");
    await markSent(old!.id);

    await moveAppointmentTo(apt.appointmentId, 4 * DAY);
    await setAnchorAge(apt.appointmentId, 2 * DAY); // the move was made days ago
    await materialize();
    expect(await jobs(apt.appointmentId, "appointment_reminder_24h")).toHaveLength(1); // nothing yet: new moment not arrived

    await moveAppointmentTo(apt.appointmentId, DAY - 40); // time passes: the new moment is now 40 min old
    await setAnchorAge(apt.appointmentId, 2 * DAY);
    await materialize();
    const list = await jobs(apt.appointmentId, "appointment_reminder_24h");
    expect(list).toHaveLength(2);
    expect(list.filter((job) => job.status === "sent")).toHaveLength(1);
    expect(list.filter((job) => job.status === "pending")).toHaveLength(1);
    expect(new Set(list.map((job) => job.dedupe_revision)).size).toBe(2);
  });

  it("the switch is re-checked at send time: OFF -> not handed out; back ON inside the window -> sent; back ON after the window -> skipped", async () => {
    const apt = await makeAppointment(fxC, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    const [job] = await jobs(apt.appointmentId, "appointment_reminder_24h");
    expect(job!.status).toBe("pending");

    await setSwitches(fxC, { appointment_reminder_24h: false });
    expect((await claim([fxC.slug])).filter((claimed) => claimed.jobId === job!.id)).toHaveLength(0);
    expect((await jobs(apt.appointmentId, "appointment_reminder_24h"))[0]!.status).toBe("pending"); // history preserved

    await setSwitches(fxC, { appointment_reminder_24h: true });
    expect((await claim([fxC.slug])).filter((claimed) => claimed.jobId === job!.id)).toHaveLength(1);

    // a second one that stays queued past its window
    const late = await makeAppointment(fxC, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    const [lateJob] = await jobs(late.appointmentId, "appointment_reminder_24h");
    await setSwitches(fxC, { appointment_reminder_24h: false });
    await testDb`update appointments set scheduled_start_at = now() + interval '19 hours', scheduled_end_at = now() + interval '19 hours 30 minutes' where id = ${late.appointmentId}`;
    await testDb`update private.customer_notification_jobs set target_start_at = now() + interval '19 hours' where id = ${lateJob!.id}`;
    await setSwitches(fxC, { appointment_reminder_24h: true });
    await claim([fxC.slug]);
    const after = (await jobs(late.appointmentId, "appointment_reminder_24h")).find((row) => row.id === lateJob!.id)!;
    expect(after.status).toBe("skipped");
  });

  it("two workers claiming at the same moment never both get the reminder", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    const [job] = await jobs(apt.appointmentId, "appointment_reminder_24h");
    const [a, b] = await Promise.all([claim([fxA.slug]), claim([fxA.slug])]);
    const total = [...a, ...b].filter((claimed) => claimed.jobId === job!.id);
    expect(total).toHaveLength(1);
  });

  it("tenant isolation: salon C's reminder never appears in salon A's claim and vice versa", async () => {
    const aptC = await makeAppointment(fxC, { startInMinutes: DAY - 30, status: "confirmed", bookedMinutesAgo: 3 * DAY });
    await materialize();
    const claimedForA = await claim([fxA.slug]);
    expect(claimedForA.map((job) => job.tenantSlug).every((slug) => slug === fxA.slug)).toBe(true);
    const [jobC] = await jobs(aptC.appointmentId, "appointment_reminder_24h");
    expect(jobC!.tenant_id).toBe(fxC.tenant.id);
  });
});

describe("OWNER SETTINGS — authorization, audit, defaults", () => {
  const read = (userId: string, tenantId: string) =>
    asAuthenticatedUser(userId, async (sql) => {
      const [row] = await sql<{ r: Record<string, boolean> }[]>`select public.get_customer_notification_settings(${tenantId}::uuid) as r`;
      return row!.r;
    });

  it("a salon that never opted in has everything OFF (the default)", async () => {
    const fresh = await createConfirmationFixture("l1b-fresh");
    try {
      expect(await read(fresh.owner.id, fresh.tenant.id)).toEqual({
        appointment_confirmation: false,
        appointment_update: false,
        appointment_cancellation: false,
        appointment_reminder_24h: false,
      });
    } finally {
      await teardownFixtures([fresh]);
    }
  });

  it("the Owner reads and sets; every real change writes one exact audit row; repeating a setting writes none", async () => {
    const fresh = await createConfirmationFixture("l1b-audit");
    try {
      const set = (enabled: boolean) =>
        asAuthenticatedUser(fresh.owner.id, (sql) => sql`select public.set_customer_notification_setting(${fresh.tenant.id}::uuid, 'appointment_update', ${enabled})`);
      await set(true);
      await set(true); // no change
      await set(false);
      const rows = await auditRows(fresh.tenant.id, "settings.customer_notification_changed");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ actor_user_id: fresh.owner.id, before: { type: "appointment_update", enabled: false }, after: { type: "appointment_update", enabled: true } });
      expect(rows[1]).toMatchObject({ before: { type: "appointment_update", enabled: true }, after: { type: "appointment_update", enabled: false } });
    } finally {
      await teardownFixtures([fresh]);
    }
  });

  it("turning ON again after OFF moves the watermark (appointments created while it was off are never mailed)", async () => {
    const fresh = await createConfirmationFixture("l1b-wm");
    try {
      const set = (enabled: boolean) =>
        asAuthenticatedUser(fresh.owner.id, (sql) => sql`select public.set_customer_notification_setting(${fresh.tenant.id}::uuid, 'appointment_confirmation', ${enabled})`);
      await set(true);
      const [first] = await testDb<{ activated_at: Date }[]>`select activated_at from private.customer_notification_activation where tenant_id = ${fresh.tenant.id} and notification_type = 'appointment_confirmation'`;
      await set(true);
      const [still] = await testDb<{ activated_at: Date }[]>`select activated_at from private.customer_notification_activation where tenant_id = ${fresh.tenant.id} and notification_type = 'appointment_confirmation'`;
      expect(still!.activated_at.getTime()).toBe(first!.activated_at.getTime());
      await set(false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await set(true);
      const [moved] = await testDb<{ activated_at: Date }[]>`select activated_at from private.customer_notification_activation where tenant_id = ${fresh.tenant.id} and notification_type = 'appointment_confirmation'`;
      expect(moved!.activated_at.getTime()).toBeGreaterThan(first!.activated_at.getTime());
    } finally {
      await teardownFixtures([fresh]);
    }
  });

  it("appointments created BEFORE a switch was turned on never get that notification (watermark)", async () => {
    const fresh = await createConfirmationFixture("l1b-wm2");
    try {
      await setSwitches(fresh, { appointment_cancellation: true });
      const apt = await makeAppointment(fresh, { startInMinutes: 3 * DAY, status: "confirmed" });
      await testDb`update appointments set created_at = now() - interval '2 days' where id = ${apt.appointmentId}`;
      await testDb`update private.customer_notification_activation set activated_at = now() - interval '1 day' where tenant_id = ${fresh.tenant.id}`;
      await setStatus(apt.appointmentId, "cancelled");
      expect((await jobs(apt.appointmentId, "appointment_cancellation"))[0]).toMatchObject({ status: "skipped", skip_reason: "predates_activation" });
    } finally {
      await teardownFixtures([fresh]);
    }
  });

  it("a Manager (Yönetici), a Stylist and an Owner of ANOTHER salon cannot read, set or see the health of salon A", async () => {
    for (const user of [manager, stylist, fxB.owner]) {
      await expect(read(user.id, fxA.tenant.id), user.email).rejects.toMatchObject({ code: "CN011" });
      await expect(
        asAuthenticatedUser(user.id, (sql) => sql`select public.set_customer_notification_setting(${fxA.tenant.id}::uuid, 'appointment_reminder_24h', false)`),
        user.email,
      ).rejects.toMatchObject({ code: "CN011" });
      await expect(
        asAuthenticatedUser(user.id, (sql) => sql`select public.get_customer_notification_health(${fxA.tenant.id}::uuid)`),
        user.email,
      ).rejects.toMatchObject({ code: "CN011" });
    }
    // unchanged
    expect(await read(fxA.owner.id, fxA.tenant.id)).toEqual({
      appointment_confirmation: true,
      appointment_update: true,
      appointment_cancellation: true,
      appointment_reminder_24h: true,
    });
  });

  it("anon cannot execute any of the three RPCs; service_role neither; a signed-out call is refused", async () => {
    const rows = await testDb<{ fn: string; anon: boolean; authenticated: boolean; service: boolean }[]>`
      select p.proname as fn,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('get_customer_notification_settings', 'set_customer_notification_setting', 'get_customer_notification_health')
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row, row.fn).toMatchObject({ anon: false, authenticated: true, service: false });
  });

  it("an invalid type and a null switch are refused; a suspended salon cannot be switched", async () => {
    await expect(
      asAuthenticatedUser(fxA.owner.id, (sql) => sql`select public.set_customer_notification_setting(${fxA.tenant.id}::uuid, 'appointment_sms', true)`),
    ).rejects.toMatchObject({ code: "CN012" });
    await expect(
      asAuthenticatedUser(fxA.owner.id, (sql) => sql`select public.set_customer_notification_setting(${fxA.tenant.id}::uuid, 'appointment_update', null)`),
    ).rejects.toMatchObject({ code: "CN012" });

    const suspended = await createConfirmationFixture("l1b-suspended");
    try {
      await testDb`update tenants set status = 'suspended' where id = ${suspended.tenant.id}`;
      await expect(
        asAuthenticatedUser(suspended.owner.id, (sql) => sql`select public.set_customer_notification_setting(${suspended.tenant.id}::uuid, 'appointment_update', true)`),
      ).rejects.toMatchObject({ code: "CN004" });
      const rows = await testDb`select 1 from private.customer_notification_activation where tenant_id = ${suspended.tenant.id}`;
      expect(rows).toHaveLength(0);
    } finally {
      await teardownFixtures([suspended]);
    }
  });

  it("the delivery health is a PII-free count summary of the salon's own jobs only", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    const [conf] = await jobs(apt.appointmentId, "appointment_confirmation");
    await markSent(conf!.id);
    const health = await asAuthenticatedUser(fxA.owner.id, async (sql) => {
      const [row] = await sql<{ h: Record<string, number> }[]>`select public.get_customer_notification_health(${fxA.tenant.id}::uuid) as h`;
      return row!.h;
    });
    expect(Object.keys(health).sort()).toEqual(["failed", "sent", "skippedNoRecipient", "uncertain", "waiting", "windowDays"]);
    expect(health.sent).toBeGreaterThanOrEqual(1);
    const otherHealth = await asAuthenticatedUser(fxB.owner.id, async (sql) => {
      const [row] = await sql<{ h: Record<string, number> }[]>`select public.get_customer_notification_health(${fxB.tenant.id}::uuid) as h`;
      return row!.h;
    });
    expect(otherHealth.sent).toBe(0);
  });
});

describe("SCHEMA GUARDS — the rules live in the database", () => {
  it("the dedupe key includes the revision; reminders require a target; all four types are accepted and nothing else", async () => {
    const [key] = await testDb<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'customer_notification_jobs_dedup_key' and conrelid = 'private.customer_notification_jobs'::regclass
    `;
    expect(key!.def).toContain("appointment_id");
    expect(key!.def).toContain("notification_type");
    expect(key!.def).toContain("channel");
    expect(key!.def).toContain("dedupe_revision");

    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "confirmed" });
    await expect(
      testDb`insert into private.customer_notification_jobs (tenant_id, appointment_id, notification_type, channel, status, dedupe_revision)
             values (${fxA.tenant.id}, ${apt.appointmentId}, 'appointment_reminder_24h', 'email', 'pending', 5)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      testDb`insert into private.customer_notification_jobs (tenant_id, appointment_id, notification_type, channel, status)
             values (${fxA.tenant.id}, ${apt.appointmentId}, 'appointment_sms', 'email', 'pending')`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("the new private tables and functions have no API-role privilege", async () => {
    const rows = await testDb<{ t: string; anon: boolean; authed: boolean; service: boolean }[]>`
      select c.relname as t,
             has_table_privilege('anon', c.oid, 'select') as anon,
             has_table_privilege('authenticated', c.oid, 'select') as authed,
             has_table_privilege('service_role', c.oid, 'select') as service
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relname = 'appointment_schedule_anchor'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ anon: false, authed: false, service: false });
    const [rls] = await testDb<{ rls: boolean }[]>`select relrowsecurity as rls from pg_class where oid = 'private.appointment_schedule_anchor'::regclass`;
    expect(rls!.rls).toBe(true);
    const fns = await testDb<{ fn: string; anon: boolean; authed: boolean; service: boolean }[]>`
      select p.proname as fn,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authed,
             has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private'
        and p.proname in ('materialize_customer_reminders', 'enqueue_customer_update_email', 'enqueue_customer_cancellation_email',
                          'capture_internal_appointment_contact', 'customer_notifications_active_since')
    `;
    expect(fns.length).toBeGreaterThanOrEqual(5);
    for (const fn of fns) expect(fn, fn.fn).toMatchObject({ anon: false, authed: false, service: false });
  });

  it("a booking is never blocked by the notification plumbing: a forced failure in the outbox leaves the status change intact", async () => {
    const apt = await makeAppointment(fxA, { startInMinutes: 3 * DAY, status: "scheduled" });
    await testDb`alter table private.customer_notification_jobs add constraint zz_l1b_force_failure check (false) not valid`;
    try {
      await testDb`update appointments set status = 'confirmed' where id = ${apt.appointmentId}`;
      await testDb`update appointments set status = 'cancelled' where id = ${apt.appointmentId}`;
    } finally {
      await testDb`alter table private.customer_notification_jobs drop constraint zz_l1b_force_failure`;
    }
    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${apt.appointmentId}`;
    expect(row!.status).toBe("cancelled");
    expect(await jobs(apt.appointmentId)).toHaveLength(0);
  });
});
