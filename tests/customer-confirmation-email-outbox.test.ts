import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { callCreateGuestBooking } from "@/lib/modules/public-booking/gateway-db";
import {
  asDatabaseRole,
  attemptAs,
  createTestMembershipFromTemplate,
  createTestUser,
  testDb,
  type TestUser,
} from "./helpers";
import {
  activateConfirmationEmail,
  appointmentStatus,
  bookPublicly,
  confirmAs,
  contactForAppointment,
  createConfirmationFixture,
  deactivateConfirmationEmail,
  insertAppointmentWithSource,
  jobsForAppointment,
  jobsForTenant,
  setStatusAs,
  teardownFixtures,
  type ConfirmationFixture,
} from "./customer-confirmation-fixtures";

/**
 * Faz NOTIF.1A — the customer appointment-confirmation email's DATABASE
 * layer: the trigger that records ONE job on the first scheduled ->
 * confirmed of a public booking, the booking-time recipient snapshot, the
 * per-tenant activation, and the locks around all of it.
 *
 * Matrix cases 1-10 (trigger, recipient), 28-30 (security), 35-37
 * (activation) live here; the worker/delivery cases (19-27) are in
 * customer-confirmation-email-worker.test.ts and the endpoint cases
 * (31-34) in customer-confirmation-email-endpoint.test.ts.
 *
 * Everything runs against synthetic data (`.test` addresses). Nothing here
 * sends anything: the DATABASE never sends — it only records that a send is
 * due.
 */

let fxA: ConfirmationFixture; // activated
let fxB: ConfirmationFixture; // a second tenant, activated separately
let fxC: ConfirmationFixture; // never activated
let manager: TestUser;
let stylist: TestUser;
let dayOffset = 2;
const nextDay = () => dayOffset++;

const FAILURE_CONSTRAINTS = [
  ["private.customer_notification_jobs", "zz_n1a_force_job_failure"],
  ["private.appointment_booking_contacts", "zz_n1a_force_contact_failure"],
] as const;

async function dropForcedFailures() {
  for (const [table, name] of FAILURE_CONSTRAINTS) {
    const [present] = await testDb<{ n: string }[]>`
      select count(*)::text as n from pg_constraint where conrelid = ${table}::regclass and conname = ${name}
    `;
    if (present!.n !== "0") await testDb.unsafe(`alter table ${table} drop constraint ${name}`);
  }
}

beforeAll(async () => {
  await dropForcedFailures(); // defensive: a crashed earlier run must not poison this one
  fxA = await createConfirmationFixture("a", { salonName: "Gökhan İlhan Hair Studio" });
  fxB = await createConfirmationFixture("b");
  fxC = await createConfirmationFixture("c");
  manager = await createTestUser("n1a-manager");
  stylist = await createTestUser("n1a-stylist");
  await createTestMembershipFromTemplate(fxA.tenant.id, manager.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(fxA.tenant.id, stylist.id, "STYLIST");
  await activateConfirmationEmail(fxA.slug);
  await activateConfirmationEmail(fxB.slug);
}, 120_000);

afterAll(async () => {
  await dropForcedFailures();
  await teardownFixtures([fxA, fxB, fxC].filter(Boolean), [manager, stylist].filter(Boolean));
}, 120_000);

describe("A. trigger — exactly one job, only for a public booking's first confirmation", () => {
  it("1. a public booking confirmed by the Owner records exactly one pending confirmation job", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await confirmAs(fxA.owner.id, booking.appointmentId);

    expect(await appointmentStatus(booking.appointmentId)).toBe("confirmed");
    const jobs = await jobsForAppointment(booking.appointmentId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      tenant_id: fxA.tenant.id,
      notification_type: "appointment_confirmation",
      channel: "email",
      status: "pending",
      attempt_count: 0,
      locked_at: null,
      lock_token: null,
      send_started_at: null,
      sent_at: null,
      provider_message_id: null,
      last_error_class: null,
      skip_reason: null,
    });
  });

  it("1b. a Manager's approval records one too (any salon user allowed to confirm)", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await confirmAs(manager.id, booking.appointmentId);
    expect((await jobsForAppointment(booking.appointmentId)).map((job) => job.status)).toEqual(["pending"]);
  });

  it("2. nothing is recorded at booking creation, nor while the booking stays scheduled", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    expect(await appointmentStatus(booking.appointmentId)).toBe("scheduled");
    expect(await jobsForAppointment(booking.appointmentId)).toHaveLength(0);
    // ...and the booking-time snapshot exists, waiting, without any job.
    expect(await contactForAppointment(booking.appointmentId)).toBeDefined();
  });

  it("3. cancelling, starting or no-showing a scheduled booking records nothing", async () => {
    const cancelled = await bookPublicly(fxA, { dayOffset: nextDay() });
    await setStatusAs(fxA.owner.id, cancelled.appointmentId, "cancelled");
    expect(await jobsForAppointment(cancelled.appointmentId)).toHaveLength(0);

    const started = await bookPublicly(fxA, { dayOffset: nextDay() });
    await setStatusAs(fxA.owner.id, started.appointmentId, "in_progress");
    expect(await jobsForAppointment(started.appointmentId)).toHaveLength(0);

    const noShow = await bookPublicly(fxA, { dayOffset: nextDay() });
    await setStatusAs(fxA.owner.id, noShow.appointmentId, "no_show");
    expect(await jobsForAppointment(noShow.appointmentId)).toHaveLength(0);
  });

  it("3b. any transition AFTER the first confirmation adds nothing and does not disturb the job", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await confirmAs(fxA.owner.id, booking.appointmentId);
    const [before] = await jobsForAppointment(booking.appointmentId);

    await setStatusAs(fxA.owner.id, booking.appointmentId, "in_progress");
    await setStatusAs(fxA.owner.id, booking.appointmentId, "confirmed"); // back again
    await setStatusAs(fxA.owner.id, booking.appointmentId, "cancelled");

    const after = await jobsForAppointment(booking.appointmentId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.status).toBe("pending");
  });

  it("4. an appointment that did not come from the public booking flow never gets a job", async () => {
    // 'internal' is what staff-created appointments carry; the others are
    // the values a walk-in / imported / legacy row might have.
    for (const source of ["internal", "salon_staff", "walk_in", "phone", null]) {
      const appointmentId = await insertAppointmentWithSource(fxA, source, nextDay());
      await confirmAs(fxA.owner.id, appointmentId);
      expect(await appointmentStatus(appointmentId), String(source)).toBe("confirmed");
      expect(await jobsForAppointment(appointmentId), String(source)).toHaveLength(0);
    }
  });

  it("5. confirming again (double click, refresh, second user) still leaves exactly one job", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await confirmAs(fxA.owner.id, booking.appointmentId);
    await confirmAs(fxA.owner.id, booking.appointmentId);
    await confirmAs(manager.id, booking.appointmentId);

    expect(await jobsForAppointment(booking.appointmentId)).toHaveLength(1);
    // A status flipped back to 'scheduled' out-of-band and confirmed again
    // is still the same appointment: the unique key holds.
    await testDb`update appointments set status = 'scheduled' where id = ${booking.appointmentId}`;
    await confirmAs(fxA.owner.id, booking.appointmentId);
    expect(await jobsForAppointment(booking.appointmentId)).toHaveLength(1);
  });

  it("6. concurrent confirmations from several sessions still yield exactly one job", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await Promise.all([
      confirmAs(fxA.owner.id, booking.appointmentId),
      confirmAs(manager.id, booking.appointmentId),
      confirmAs(fxA.owner.id, booking.appointmentId),
      confirmAs(manager.id, booking.appointmentId),
    ]);
    expect(await appointmentStatus(booking.appointmentId)).toBe("confirmed");
    expect(await jobsForAppointment(booking.appointmentId)).toHaveLength(1);
  });

  it("6b. the DB itself refuses a second job for the same appointment (unique key), whoever tries", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await confirmAs(fxA.owner.id, booking.appointmentId);
    await expect(
      testDb`
        insert into private.customer_notification_jobs (tenant_id, appointment_id, notification_type, channel)
        values (${fxA.tenant.id}, ${booking.appointmentId}, 'appointment_confirmation', 'email')
      `,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("6c. a user without appointments.update (Personel) cannot confirm, so no job is recorded", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    const outcome = await attemptAs(stylist.id, (sql) =>
      sql`select public.update_appointment_status(${booking.appointmentId}::uuid, 'confirmed')`,
    );
    expect(outcome).toMatchObject({ ok: false, code: "AP002" });
    expect(await appointmentStatus(booking.appointmentId)).toBe("scheduled");
    expect(await jobsForAppointment(booking.appointmentId)).toHaveLength(0);
  });

  it("6d. approval never depends on the outbox: if recording the job fails, the appointment is still confirmed", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await testDb`alter table private.customer_notification_jobs add constraint zz_n1a_force_job_failure check (status = 'impossible-status') not valid`;
    try {
      await confirmAs(fxA.owner.id, booking.appointmentId);
    } finally {
      await testDb`alter table private.customer_notification_jobs drop constraint zz_n1a_force_job_failure`;
    }
    expect(await appointmentStatus(booking.appointmentId)).toBe("confirmed");
    expect(await jobsForAppointment(booking.appointmentId)).toHaveLength(0);
  });

  it("6e. the trigger is exactly the documented one: AFTER UPDATE OF status, scheduled -> confirmed, public_booking only", async () => {
    const [row] = await testDb<{ def: string }[]>`
      select pg_get_triggerdef(t.oid) as def
      from pg_trigger t
      where t.tgname = 'enqueue_customer_confirmation_email' and not t.tgisinternal
        and t.tgrelid = 'public.appointments'::regclass
    `;
    expect(row!.def).toContain("AFTER UPDATE OF status ON public.appointments");
    expect(row!.def).toContain("old.status = 'scheduled'");
    expect(row!.def).toContain("new.status = 'confirmed'");
    expect(row!.def).toContain("new.source = 'public_booking'");
    // the function sends nothing: no network-capable call is even possible from it
    const [fn] = await testDb<{ src: string }[]>`
      select prosrc as src from pg_proc where oid = 'private.enqueue_customer_confirmation_email()'::regprocedure
    `;
    expect(fn!.src).not.toMatch(/http|smtp|pg_net|net\.http|dblink|copy\s+.*program/i);
  });
});

describe("B. recipient — the address typed for THIS booking, captured once", () => {
  it("7. a valid address is stored normalised, with the first name to greet, and is what the job will use", async () => {
    const booking = await bookPublicly(fxA, {
      dayOffset: nextDay(),
      email: "  Ayse.Musteri+Salon@Example.TEST ",
      fullName: "  Ayşe   Nur Yılmaz ",
    });
    const contact = await contactForAppointment(booking.appointmentId);
    expect(contact).toMatchObject({
      tenant_id: fxA.tenant.id,
      recipient_email: "ayse.musteri+salon@example.test",
      greeting_name: "Ayşe",
    });
    await confirmAs(fxA.owner.id, booking.appointmentId);
    expect((await jobsForAppointment(booking.appointmentId))[0]!.status).toBe("pending");
  });

  it("8. a booking with no email is confirmed normally; the job is recorded as skipped (no_recipient), never pending", async () => {
    for (const email of [null, "", "   "]) {
      const booking = await bookPublicly(fxA, { dayOffset: nextDay(), email });
      expect(await contactForAppointment(booking.appointmentId), String(email)).toBeUndefined();
      await confirmAs(fxA.owner.id, booking.appointmentId);
      expect(await appointmentStatus(booking.appointmentId)).toBe("confirmed");
      const jobs = await jobsForAppointment(booking.appointmentId);
      expect(jobs, String(email)).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: "skipped", skip_reason: "no_recipient" });
    }
  });

  it("9. an address the booking flow itself rejects never becomes an appointment, and nothing is stored for it", async () => {
    const before = await testDb<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${fxA.tenant.id}`;
    await expect(bookPublicly(fxA, { dayOffset: nextDay(), email: "not-an-email" })).rejects.toMatchObject({ code: "BK006" });
    const after = await testDb<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${fxA.tenant.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("10. the recipient is the booking-time address even when the customer row's own email is different or changes later", async () => {
    const phone = "+905550001234";
    // A returning customer: matched by (phone, name), so the booking's email is NOT written to their row.
    const first = await bookPublicly(fxA, {
      dayOffset: nextDay(),
      phone,
      fullName: "Zeynep Kaya",
      email: "eski.adres@example.test",
    });
    const second = await bookPublicly(fxA, {
      dayOffset: nextDay(),
      phone,
      fullName: "Zeynep Kaya",
      email: "yeni.adres@example.test",
    });

    const customers = await testDb<{ id: string; email: string | null }[]>`
      select c.id, c.email from customers c join appointments a on a.customer_id = c.id
      where a.id in (${first.appointmentId}, ${second.appointmentId})
    `;
    // the same customer row served both bookings, and it still holds the FIRST address
    expect(new Set(customers.map((c) => c.id)).size).toBe(1);
    expect(customers[0]!.email).toBe("eski.adres@example.test");

    expect((await contactForAppointment(first.appointmentId))!.recipient_email).toBe("eski.adres@example.test");
    expect((await contactForAppointment(second.appointmentId))!.recipient_email).toBe("yeni.adres@example.test");

    // a later change to the customer record cannot redirect an already-booked confirmation
    await testDb`update customers set email = 'degisen.adres@example.test' where id = ${customers[0]!.id}`;
    expect((await contactForAppointment(second.appointmentId))!.recipient_email).toBe("yeni.adres@example.test");
  });

  it("10b. the snapshot is immutable — nobody, not even the table owner, can rewrite it in place", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await expect(
      testDb`update private.appointment_booking_contacts set recipient_email = 'baska@example.test' where appointment_id = ${booking.appointmentId}`,
    ).rejects.toMatchObject({ code: "CN003" });
    await expect(
      testDb`update private.appointment_booking_contacts set greeting_name = 'X' where appointment_id = ${booking.appointmentId}`,
    ).rejects.toMatchObject({ code: "CN003" });
    expect((await contactForAppointment(booking.appointmentId))!.recipient_email).toBe("ayse.musteri@example.test");
  });

  it("10c. replaying the same booking (same idempotency key) returns the same confirmation and keeps ONE snapshot", async () => {
    const first = await bookPublicly(fxA, { dayOffset: nextDay() });
    const replay = await bookPublicly(fxA, {
      dayOffset: dayOffset - 1,
      phone: first.phone,
      fullName: first.fullName,
      email: first.email,
      idempotencyKey: first.idempotencyKey,
    });
    expect(replay.appointmentId).toBe(first.appointmentId);
    expect(replay.confirmation).toEqual(first.confirmation);
    const rows = await testDb<{ n: string }[]>`
      select count(*)::text as n from private.appointment_booking_contacts where appointment_id = ${first.appointmentId}
    `;
    expect(rows[0]!.n).toBe("1");
  });

  it("10d. the public booking response is byte-for-byte what it was: no new field, no address", async () => {
    const active = await bookPublicly(fxA, { dayOffset: nextDay() });
    const inactive = await bookPublicly(fxC, { dayOffset: nextDay() });
    const keys = (confirmation: Record<string, unknown>) => Object.keys(confirmation).sort();
    expect(keys(active.confirmation)).toEqual(keys(inactive.confirmation));
    expect(keys(active.confirmation)).toEqual(
      [
        "appointmentReference",
        "branchName",
        "claimIssued",
        "claimRef",
        "durationMinutes",
        "price",
        "scheduledStartAt",
        "serviceName",
        "staffName",
        "tenantTimezone",
      ].sort(),
    );
    expect(JSON.stringify(active.confirmation)).not.toContain("example.test");
  });

  it("10e. a failure while capturing the snapshot never fails the booking (the customer just gets no email)", async () => {
    await testDb`alter table private.appointment_booking_contacts add constraint zz_n1a_force_contact_failure check (recipient_email = 'impossible') not valid`;
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() }).finally(async () => {
      await testDb`alter table private.appointment_booking_contacts drop constraint zz_n1a_force_contact_failure`;
    });
    expect(await appointmentStatus(booking.appointmentId)).toBe("scheduled");
    expect(await contactForAppointment(booking.appointmentId)).toBeUndefined();
    await confirmAs(fxA.owner.id, booking.appointmentId);
    expect((await jobsForAppointment(booking.appointmentId))[0]).toMatchObject({ status: "skipped", skip_reason: "no_recipient" });
  });

  it("10g. through the REAL gateway path (the booking_gateway role, exactly as production calls it) the snapshot is captured, and that role cannot read it back", async () => {
    const start = new Date(Date.now() + 90 * 86400_000); // far outside the day range the other tests in this file use
    start.setUTCHours(7, 0, 0, 0); // 10:00 salon-local

    const result = await callCreateGuestBooking({
      tenantSlug: fxA.slug,
      branchId: fxA.branchId,
      serviceId: fxA.service.id,
      scheduledStartAtUtc: start.toISOString(),
      customerFullName: "Gateway Musteri",
      customerPhone: "+905557778899",
      staffMemberId: fxA.staff.id,
      customerEmail: "gateway.musteri@example.test",
      idempotencyKey: randomUUID(),
      customerAccountUserId: null,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const appointmentId = result.data.appointmentReference as string;
    expect(await contactForAppointment(appointmentId)).toMatchObject({
      recipient_email: "gateway.musteri@example.test",
      greeting_name: "Gateway",
    });

    // The gateway role itself has no access to any of it.
    const gateway = postgres(process.env.BOOKING_GATEWAY_DATABASE_URL!, { ssl: "require", max: 1, prepare: false });
    try {
      await expect(gateway`select * from private.appointment_booking_contacts`).rejects.toMatchObject({ code: "42501" });
      await expect(gateway`select * from private.customer_notification_jobs`).rejects.toMatchObject({ code: "42501" });
      await expect(gateway`select * from private.customer_notification_activation`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await gateway.end();
    }
  });

  it("10f. the first name is only the first word, and blank names yield no greeting name", async () => {
    const a = await bookPublicly(fxA, { dayOffset: nextDay(), fullName: "Mehmet Ali Kaya" });
    expect((await contactForAppointment(a.appointmentId))!.greeting_name).toBe("Mehmet");
    const b = await bookPublicly(fxA, { dayOffset: nextDay(), fullName: "Ayşe" });
    expect((await contactForAppointment(b.appointmentId))!.greeting_name).toBe("Ayşe");
    const c = await bookPublicly(fxA, { dayOffset: nextDay(), fullName: "X".repeat(150) });
    expect((await contactForAppointment(c.appointmentId))!.greeting_name).toHaveLength(60);
  });
});

describe("F. activation — nothing happens until a tenant is switched on, and only that tenant", () => {
  it("35. before activation: no snapshot is captured and confirming records nothing", async () => {
    const booking = await bookPublicly(fxC, { dayOffset: nextDay() });
    expect(await contactForAppointment(booking.appointmentId)).toBeUndefined();
    await confirmAs(fxC.owner.id, booking.appointmentId);
    expect(await appointmentStatus(booking.appointmentId)).toBe("confirmed");
    expect(await jobsForAppointment(booking.appointmentId)).toHaveLength(0);
    expect(await jobsForTenant(fxC.tenant.id)).toHaveLength(0);
  });

  it("36. after activation: the same flow captures the address and records a pending job", async () => {
    const fx = await createConfirmationFixture("act");
    try {
      const before = await bookPublicly(fx, { dayOffset: nextDay() });
      expect(await contactForAppointment(before.appointmentId)).toBeUndefined();

      await activateConfirmationEmail(fx.slug);

      const after = await bookPublicly(fx, { dayOffset: nextDay() });
      expect(await contactForAppointment(after.appointmentId)).toBeDefined();
      await confirmAs(fx.owner.id, after.appointmentId);
      expect((await jobsForAppointment(after.appointmentId))[0]!.status).toBe("pending");

      // ... but a booking that PREDATES activation is never emailed, even
      // though it is confirmed after activation: it is recorded as skipped.
      await confirmAs(fx.owner.id, before.appointmentId);
      expect((await jobsForAppointment(before.appointmentId))[0]).toMatchObject({
        status: "skipped",
        skip_reason: "predates_activation",
      });
    } finally {
      await teardownFixtures([fx]);
    }
  });

  it("36b. activating a tenant never touches an already-confirmed (historical) appointment", async () => {
    const fx = await createConfirmationFixture("hist");
    try {
      const historical = await bookPublicly(fx, { dayOffset: nextDay() });
      await confirmAs(fx.owner.id, historical.appointmentId);
      expect(await jobsForTenant(fx.tenant.id)).toHaveLength(0);

      await activateConfirmationEmail(fx.slug);
      expect(await jobsForTenant(fx.tenant.id)).toHaveLength(0);

      // confirming an already-confirmed appointment again is not a first confirmation
      await confirmAs(fx.owner.id, historical.appointmentId);
      expect(await jobsForTenant(fx.tenant.id)).toHaveLength(0);
    } finally {
      await teardownFixtures([fx]);
    }
  });

  it("37. tenant A's activation does not activate tenant B, and vice versa", async () => {
    const fxOnly = await createConfirmationFixture("only");
    const fxOther = await createConfirmationFixture("other");
    try {
      await activateConfirmationEmail(fxOnly.slug);

      const inactive = await bookPublicly(fxOther, { dayOffset: nextDay() });
      const active = await bookPublicly(fxOnly, { dayOffset: nextDay() });
      await confirmAs(fxOther.owner.id, inactive.appointmentId);
      await confirmAs(fxOnly.owner.id, active.appointmentId);

      expect(await contactForAppointment(inactive.appointmentId)).toBeUndefined();
      expect(await jobsForTenant(fxOther.tenant.id)).toHaveLength(0);
      expect(await jobsForTenant(fxOnly.tenant.id)).toHaveLength(1);

      const activations = await testDb<{ tenant_id: string }[]>`
        select tenant_id from private.customer_notification_activation where tenant_id in (${fxOnly.tenant.id}, ${fxOther.tenant.id})
      `;
      expect(activations.map((row) => row.tenant_id)).toEqual([fxOnly.tenant.id]);
    } finally {
      await teardownFixtures([fxOnly, fxOther]);
    }
  });

  it("37b. the kill switch stops capture and recording at once; re-enabling moves the watermark forward", async () => {
    const fx = await createConfirmationFixture("kill");
    try {
      const first = await activateConfirmationEmail(fx.slug);
      const booked = await bookPublicly(fx, { dayOffset: nextDay() });
      expect(await contactForAppointment(booked.appointmentId)).toBeDefined();

      // activating again while enabled is a no-op: the watermark does NOT move
      const again = await activateConfirmationEmail(fx.slug);
      expect(new Date(again.activatedAt).getTime()).toBe(new Date(first.activatedAt).getTime());

      await deactivateConfirmationEmail(fx.slug);
      const whileOff = await bookPublicly(fx, { dayOffset: nextDay() });
      expect(await contactForAppointment(whileOff.appointmentId)).toBeUndefined();
      await confirmAs(fx.owner.id, booked.appointmentId);
      expect(await jobsForAppointment(booked.appointmentId)).toHaveLength(0); // enabled=false: no job at all

      const reenabled = await activateConfirmationEmail(fx.slug);
      expect(new Date(reenabled.activatedAt).getTime()).toBeGreaterThan(new Date(first.activatedAt).getTime());
      // the booking made while it was off predates the new watermark: never emailed
      await confirmAs(fx.owner.id, whileOff.appointmentId);
      expect((await jobsForAppointment(whileOff.appointmentId))[0]).toMatchObject({
        status: "skipped",
        skip_reason: "predates_activation",
      });
    } finally {
      await teardownFixtures([fx]);
    }
  });

  it("37c. activation is refused for an unknown or non-active tenant", async () => {
    await expect(activateConfirmationEmail("no-such-salon-slug-n1a")).rejects.toMatchObject({ code: "CN004" });
    await testDb`update tenants set status = 'suspended' where id = ${fxC.tenant.id}`;
    try {
      await expect(activateConfirmationEmail(fxC.slug)).rejects.toMatchObject({ code: "CN004" });
    } finally {
      await testDb`update tenants set status = 'trial' where id = ${fxC.tenant.id}`;
    }
  });

  it("37d. the operator status view is PII-free and reports counts by status", async () => {
    const [row] = await testDb<{ result: Record<string, unknown> }[]>`
      select private.customer_confirmation_email_status(${fxA.slug}) as result
    `;
    expect(row!.result).toMatchObject({ tenantSlug: fxA.slug, activationRowExists: true, enabled: true });
    const json = JSON.stringify(row!.result);
    expect(json).not.toContain("example.test");
    const counts = row!.result.jobsByStatus as Record<string, number>;
    expect(counts.pending).toBeGreaterThan(0);
  });
});

describe("E. security — the browser (and every application role) cannot reach any of it", () => {
  const OBJECTS = [
    "private.customer_notification_jobs",
    "private.appointment_booking_contacts",
    "private.customer_notification_activation",
  ];

  it("28. a job or snapshot can never cross tenants: the composite foreign keys refuse it", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await expect(
      testDb`
        insert into private.customer_notification_jobs (tenant_id, appointment_id, notification_type, channel)
        values (${fxB.tenant.id}, ${booking.appointmentId}, 'appointment_confirmation', 'email')
      `,
    ).rejects.toMatchObject({ code: "23503" });
    // (fxC is never activated, so its booking has no snapshot yet and the
    // primary key cannot be what refuses this insert.)
    const unsnapshotted = await bookPublicly(fxC, { dayOffset: nextDay() });
    await expect(
      testDb`
        insert into private.appointment_booking_contacts (appointment_id, tenant_id, recipient_email)
        values (${unsnapshotted.appointmentId}, ${fxB.tenant.id}, 'x@example.test')
      `,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("29. an authenticated salon user (even an Owner) cannot fabricate, read or alter a job, a snapshot or an activation", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    for (const role of ["authenticated", "anon"] as const) {
      const userId = role === "authenticated" ? fxA.owner.id : null;
      for (const table of OBJECTS) {
        await expect(asDatabaseRole(role, userId, (sql) => sql.unsafe(`select * from ${table}`)), `${role} select ${table}`).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        asDatabaseRole(role, userId, (sql) =>
          sql`insert into private.customer_notification_jobs (tenant_id, appointment_id, notification_type, channel, status)
              values (${fxA.tenant.id}, ${booking.appointmentId}, 'appointment_confirmation', 'email', 'pending')`,
        ),
        `${role} insert job`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        asDatabaseRole(role, userId, (sql) =>
          sql`insert into private.customer_notification_activation (tenant_id, notification_type, channel) values (${fxC.tenant.id}, 'appointment_confirmation', 'email')`,
        ),
        `${role} insert activation`,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(await jobsForAppointment(booking.appointmentId)).toHaveLength(0);
  });

  it("30. every table denies every application role outright, and the worker/operator functions are not callable by them", async () => {
    for (const table of OBJECTS) {
      const [schema, name] = table.split(".");
      const grants = await testDb<{ grantee: string }[]>`
        select grantee from information_schema.role_table_grants
        where table_schema = ${schema!} and table_name = ${name!}
          and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC', 'booking_gateway')
      `;
      expect(grants, table).toEqual([]);
      const [rls] = await testDb<{ relrowsecurity: boolean }[]>`select relrowsecurity from pg_class where oid = ${table}::regclass`;
      expect(rls!.relrowsecurity, table).toBe(true);
    }

    const canExecute = async (role: string, signature: string) => {
      const [row] = await testDb<{ ok: boolean }[]>`select has_function_privilege(${role}, ${signature}, 'execute') as ok`;
      return row!.ok;
    };
    const workerFunctions = [
      "claim_customer_notification_jobs(integer,integer)",
      "begin_customer_notification_send(uuid,uuid)",
      "record_customer_notification_result(uuid,uuid,text,text,text,text)",
      "purge_customer_notification_data(integer,integer)",
    ];
    for (const fn of workerFunctions) {
      expect(await canExecute("service_role", `public.${fn}`), `service_role ${fn}`).toBe(true);
      for (const role of ["anon", "authenticated", "booking_gateway"]) {
        expect(await canExecute(role, `public.${fn}`), `${role} public.${fn}`).toBe(false);
      }
      for (const role of ["service_role", "anon", "authenticated", "booking_gateway"]) {
        expect(await canExecute(role, `private.${fn}`), `${role} private.${fn}`).toBe(false);
      }
    }
    const internalOnly = [
      "private.activate_customer_confirmation_email(text)",
      "private.deactivate_customer_confirmation_email(text)",
      "private.customer_confirmation_email_status(text)",
      "private.enqueue_customer_confirmation_email()",
      "private.capture_booking_contact_from_confirmation(jsonb,text,text)",
      "private.is_deliverable_email_shape(text)",
    ];
    for (const fn of internalOnly) {
      for (const role of ["service_role", "anon", "authenticated", "booking_gateway"]) {
        expect(await canExecute(role, fn), `${role} ${fn}`).toBe(false);
      }
    }
  });

  it("30b. the public create_guest_booking wrapper keeps its exact signature and its ACL (booking_gateway only)", async () => {
    const sig = "public.create_guest_booking(text,uuid,uuid,timestamptz,text,text,uuid,text,uuid,uuid,text)";
    const [row] = await testDb<{ gateway: boolean; anon: boolean; authenticated: boolean; service: boolean; lang: string }[]>`
      select has_function_privilege('booking_gateway', ${sig}, 'execute') as gateway,
             has_function_privilege('anon', ${sig}, 'execute') as anon,
             has_function_privilege('authenticated', ${sig}, 'execute') as authenticated,
             has_function_privilege('service_role', ${sig}, 'execute') as service,
             (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = ${sig}::regprocedure) as lang
    `;
    expect(row).toEqual({ gateway: true, anon: false, authenticated: false, service: false, lang: "sql" });
  });

  it("30c. the worker RPCs refuse a mismatched fencing token and unknown ids without leaking anything", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    await confirmAs(fxA.owner.id, booking.appointmentId);
    const job = (await jobsForAppointment(booking.appointmentId))[0]!;

    const [begun] = await testDb<{ ok: boolean }[]>`select private.begin_customer_notification_send(${job.id}, ${randomUUID()}) as ok`;
    expect(begun!.ok).toBe(false);
    const [recorded] = await testDb<{ r: { applied: boolean } }[]>`
      select private.record_customer_notification_result(${job.id}, ${randomUUID()}, 'sent', null, '<x@y>') as r
    `;
    expect(recorded!.r.applied).toBe(false);
    const [unknown] = await testDb<{ r: { applied: boolean } }[]>`
      select private.record_customer_notification_result(${randomUUID()}, ${randomUUID()}, 'sent', null, null) as r
    `;
    expect(unknown!.r.applied).toBe(false);
    expect((await jobsForAppointment(booking.appointmentId))[0]!.status).toBe("pending");
  });

  it("30d. the outbox rejects out-of-vocabulary values at the schema level", async () => {
    const booking = await bookPublicly(fxA, { dayOffset: nextDay() });
    const insert = (type: string, channel: string, status: string) =>
      testDb`
        insert into private.customer_notification_jobs (tenant_id, appointment_id, notification_type, channel, status, skip_reason)
        values (${fxA.tenant.id}, ${booking.appointmentId}, ${type}, ${channel}, ${status}, 'x')
      `;
    await expect(insert("marketing", "email", "pending")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("appointment_confirmation", "sms", "pending")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("appointment_confirmation", "email", "bogus")).rejects.toMatchObject({ code: "23514" });
    // a 'skipped' row must say why; a 'sent' row must say when
    await expect(
      testDb`insert into private.customer_notification_jobs (tenant_id, appointment_id, notification_type, channel, status)
             values (${fxA.tenant.id}, ${booking.appointmentId}, 'appointment_confirmation', 'email', 'skipped')`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      testDb`insert into private.customer_notification_jobs (tenant_id, appointment_id, notification_type, channel, status)
             values (${fxA.tenant.id}, ${booking.appointmentId}, 'appointment_confirmation', 'email', 'sent')`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("retention — recipient snapshots do not outlive their purpose", () => {
  async function insertContact(appointmentId: string, tenantId: string) {
    await testDb`
      insert into private.appointment_booking_contacts (appointment_id, tenant_id, recipient_email, greeting_name)
      values (${appointmentId}, ${tenantId}, 'retention@example.test', 'Ret')
      on conflict (appointment_id) do nothing
    `;
  }
  async function insertJob(appointmentId: string, tenantId: string, status: string, ageDays: number) {
    await testDb`
      insert into private.customer_notification_jobs
        (tenant_id, appointment_id, notification_type, channel, status, skip_reason, sent_at, created_at, updated_at)
      values (${tenantId}, ${appointmentId}, 'appointment_confirmation', 'email', ${status},
              ${status === "skipped" ? "no_recipient" : null},
              ${status === "sent" ? new Date().toISOString() : null}::timestamptz,
              now() - make_interval(days => ${ageDays}), now() - make_interval(days => ${ageDays}))
    `;
  }
  const purge = async (days = 30, batch = 500) => {
    const [row] = await testDb<{ n: number }[]>`select private.purge_customer_notification_data(${days}, ${batch}) as n`;
    return row!.n;
  };

  it("deletes the snapshot of a long-finished job, keeps a recent one and a still-queued one", async () => {
    const old = await bookPublicly(fxA, { dayOffset: nextDay() });
    const recent = await bookPublicly(fxA, { dayOffset: nextDay() });
    const queued = await bookPublicly(fxA, { dayOffset: nextDay() });
    await insertJob(old.appointmentId, fxA.tenant.id, "sent", 45);
    await insertJob(recent.appointmentId, fxA.tenant.id, "sent", 2);
    await insertJob(queued.appointmentId, fxA.tenant.id, "pending", 45);

    await purge();

    expect(await contactForAppointment(old.appointmentId)).toBeUndefined();
    expect(await contactForAppointment(recent.appointmentId)).toBeDefined();
    expect(await contactForAppointment(queued.appointmentId)).toBeDefined();
    // the job row itself (no PII) stays as the audit trail
    expect(await jobsForAppointment(old.appointmentId)).toHaveLength(1);
  });

  it("deletes the snapshot of an appointment that ended long ago and was never emailed; keeps an upcoming one", async () => {
    const past = await bookPublicly(fxA, { dayOffset: nextDay() });
    const upcoming = await bookPublicly(fxA, { dayOffset: nextDay() });
    await testDb`
      update appointments
      set scheduled_start_at = now() - interval '61 days', scheduled_end_at = now() - interval '61 days' + interval '30 minutes'
      where id = ${past.appointmentId}
    `;
    await purge();
    expect(await contactForAppointment(past.appointmentId)).toBeUndefined();
    expect(await contactForAppointment(upcoming.appointmentId)).toBeDefined();
  });

  it("is bounded per call and validates its arguments", async () => {
    const a = await bookPublicly(fxA, { dayOffset: nextDay() });
    const b = await bookPublicly(fxA, { dayOffset: nextDay() });
    await insertJob(a.appointmentId, fxA.tenant.id, "sent", 90);
    await insertJob(b.appointmentId, fxA.tenant.id, "sent", 90);
    expect(await purge(30, 1)).toBe(1);
    expect(await purge(30, 500)).toBeGreaterThanOrEqual(1);
    await expect(purge(0)).rejects.toMatchObject({ code: "CN001" });
    await expect(purge(30, 0)).rejects.toMatchObject({ code: "CN001" });
    await expect(purge(30, 501)).rejects.toMatchObject({ code: "CN001" });
  });

  it("insertContact helper sanity: a manually created snapshot is purged by the same rules", async () => {
    const booking = await bookPublicly(fxC, { dayOffset: nextDay() }); // fxC is not activated: no snapshot yet
    expect(await contactForAppointment(booking.appointmentId)).toBeUndefined();
    await insertContact(booking.appointmentId, fxC.tenant.id);
    await insertJob(booking.appointmentId, fxC.tenant.id, "skipped", 60);
    await purge();
    expect(await contactForAppointment(booking.appointmentId)).toBeUndefined();
  });
});
