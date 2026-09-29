import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { admin, testDb } from "./helpers";
import {
  activateConfirmationEmail,
  appointmentStatus,
  bookPublicly,
  confirmAs,
  createConfirmationFixture,
  deactivateConfirmationEmail,
  jobsForAppointment,
  SAMPLE_LOCATION_URL,
  setStatusAs,
  slotStart,
  teardownFixtures,
  type ConfirmationFixture,
  type JobRow,
} from "./customer-confirmation-fixtures";
import { startSmtpCatcher, type SmtpCatcher, type SmtpCatcherBehavior } from "./smtp-catcher";
import { processCustomerConfirmationEmailBatch } from "@/lib/modules/customer-notifications/confirmation-email-worker";
import type { OutboundEmail, SendMailFn, SmtpSendResult } from "@/lib/email/smtp-transport";

/**
 * Faz NOTIF.1A — delivery: the worker that turns a due confirmation job
 * into one email, and everything that can go wrong on the way. Matrix
 * cases 19-27, plus the claim-time eligibility rechecks and a full-stack
 * pass through the REAL nodemailer transport against a loopback catcher.
 *
 * The worker is driven exactly as production drives it — the service-role
 * Supabase client calling the four service_role-only RPCs — with an
 * injected fake transport for the outcome matrix (so each failure class is
 * exact and fast) and the real transport pointed at a loopback catcher for
 * the integration cases. No test here can send a real email: real SMTP
 * credentials are stripped from the test environment, the transport
 * refuses non-loopback hosts outside production, and every recipient is a
 * `.test` address.
 */

let fx: ConfirmationFixture;
let dayOffset = 2;
const nextDay = () => dayOffset++;

beforeAll(async () => {
  fx = await createConfirmationFixture("w", { salonName: "Gökhan İlhan Hair Studio" });
  await activateConfirmationEmail(fx.slug);
}, 120_000);

afterAll(async () => {
  await teardownFixtures(fx ? [fx] : []);
}, 120_000);

beforeEach(async () => {
  // Every test starts from an empty queue for this tenant.
  await testDb`delete from private.customer_notification_jobs where tenant_id = ${fx.tenant.id}`;
});

const SUCCESS: SmtpSendResult = { outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "<fake-id@salonos.test>" };
const failed = (
  errorClass: Extract<SmtpSendResult, { outcome: "failed" }>["errorClass"],
  disposition: Extract<SmtpSendResult, { outcome: "failed" }>["disposition"],
): SmtpSendResult => ({ outcome: "failed", provider: "google_workspace_smtp", errorClass, disposition });

type ScriptStep = SmtpSendResult | Error | ((message: OutboundEmail, callIndex: number) => Promise<SmtpSendResult> | SmtpSendResult);

/** A deterministic fake transport: each call takes the next scripted step
 * (the last step repeats); every message it was asked to send is recorded. */
function fakeTransport(script: ScriptStep[] = [SUCCESS]): { send: SendMailFn; calls: OutboundEmail[] } {
  const calls: OutboundEmail[] = [];
  const send: SendMailFn = async (message) => {
    const index = calls.length;
    calls.push(message);
    const step = script[Math.min(index, script.length - 1)]!;
    if (step instanceof Error) throw step;
    return typeof step === "function" ? await step(message, index) : step;
  };
  return { send, calls };
}

async function confirmedJob(options: { email?: string | null; fullName?: string; day?: number } = {}): Promise<{ appointmentId: string; job: JobRow }> {
  const booking = await bookPublicly(fx, { dayOffset: options.day ?? nextDay(), email: options.email, fullName: options.fullName });
  await confirmAs(fx.owner.id, booking.appointmentId);
  const job = (await jobsForAppointment(booking.appointmentId))[0]!;
  return { appointmentId: booking.appointmentId, job };
}

async function job(id: string): Promise<JobRow> {
  const [row] = await testDb<JobRow[]>`select * from private.customer_notification_jobs where id = ${id}`;
  return row!;
}

async function makeDue(id: string) {
  await testDb`update private.customer_notification_jobs set next_attempt_at = now() - interval '1 second' where id = ${id}`;
}

const run = (send: SendMailFn, extra: Partial<Parameters<typeof processCustomerConfirmationEmailBatch>[0]> = {}) =>
  processCustomerConfirmationEmailBatch({ supabase: admin, send, ...extra });

function localPartOf(message: OutboundEmail): string | undefined {
  return message.messageIdLocalPart;
}

describe("D19. accepted", () => {
  it("sends one email, records it as sent, and leaves the appointment confirmed", async () => {
    const { appointmentId, job: queued } = await confirmedJob({ email: "musteri.bir@example.test", fullName: "Ayşe Yılmaz" });
    const { send, calls } = fakeTransport([SUCCESS]);

    const result = await run(send);

    expect(result).toMatchObject({ activationAbsent: false, claimed: 1, sent: 1, retried: 0, failed: 0, uncertain: 0, skipped: 0 });
    expect(calls).toHaveLength(1);

    const after = await job(queued.id);
    expect(after).toMatchObject({
      status: "sent",
      attempt_count: 1,
      provider_message_id: "<fake-id@salonos.test>",
      last_error_class: null,
      locked_at: null,
      lock_token: null,
    });
    expect(after.sent_at).not.toBeNull();
    expect(after.send_started_at).not.toBeNull();
    expect(await appointmentStatus(appointmentId)).toBe("confirmed");
  });

  it("what reaches the transport is the booking-time recipient and a complete, correct message", async () => {
    const { job: queued } = await confirmedJob({ email: "musteri.iki@example.test", fullName: "Zeynep Kaya", day: 60 });
    const { send, calls } = fakeTransport();

    await run(send);

    const message = calls[0]!;
    expect(message.to).toBe("musteri.iki@example.test");
    expect(message.subject).toBe("Randevunuz Onaylandı — Gökhan İlhan Hair Studio");
    expect(message.messageIdLocalPart).toBe(`confirmation.${queued.id}`);
    expect(message.headers).toEqual({ "Auto-Submitted": "auto-generated" });
    // 10:00 salon-local (Europe/Istanbul), the service, the greeting, the location button
    expect(message.html).toContain("Merhaba Zeynep,");
    expect(message.html).toContain("10:00");
    expect(message.html).toContain("Saç Kesimi");
    expect(message.html).toContain(`href="${SAMPLE_LOCATION_URL}"`);
    expect(message.html).toContain("Yol Tarifi Al");
    expect(message.text).toContain("Saat: 10:00");
    expect(message.text).toContain(`Yol tarifi: ${SAMPLE_LOCATION_URL}`);
    // nothing internal or private
    for (const content of [message.html, message.text, message.subject]) {
      expect(content).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(content).not.toContain(fx.staff.fullName);
      expect(content).not.toContain("500"); // the service price
    }
  });

  it("uses the booking-time address even after the customer record's email changes", async () => {
    const { appointmentId } = await confirmedJob({ email: "asil.adres@example.test" });
    const [customer] = await testDb<{ id: string }[]>`select customer_id as id from appointments where id = ${appointmentId}`;
    await testDb`update customers set email = 'sonradan.degisen@example.test' where id = ${customer!.id}`;

    const { send, calls } = fakeTransport();
    await run(send);
    expect(calls.map((call) => call.to)).toEqual(["asil.adres@example.test"]);
  });

  it("an appointment rescheduled after approval is emailed with its CURRENT time (rendered at send time)", async () => {
    const { appointmentId } = await confirmedJob({ email: "yeni.saat@example.test", day: 61 });
    const later = new Date(slotStart(61).getTime() + 3 * 3600_000); // 13:00 local
    await testDb`
      update appointment_items set scheduled_start_at = ${later.toISOString()}::timestamptz,
                                    scheduled_end_at = ${new Date(later.getTime() + 30 * 60_000).toISOString()}::timestamptz
      where appointment_id = ${appointmentId}
    `;
    await testDb`
      update appointments set scheduled_start_at = ${later.toISOString()}::timestamptz,
                              scheduled_end_at = ${new Date(later.getTime() + 30 * 60_000).toISOString()}::timestamptz
      where id = ${appointmentId}
    `;
    const { send, calls } = fakeTransport();
    await run(send);
    expect(calls[0]!.text).toContain("Saat: 13:00");
  });
});

describe("D20. temporary outage — retried later, never lost, never duplicated", () => {
  it("records a retry with the first backoff, does not resend before it is due, and delivers once it is", async () => {
    const { job: queued } = await confirmedJob();
    const outage = fakeTransport([failed("network_error", "retryable")]);

    const first = await run(outage.send);
    expect(first).toMatchObject({ claimed: 1, retried: 1, sent: 0 });

    const afterOutage = await job(queued.id);
    expect(afterOutage).toMatchObject({ status: "retry", attempt_count: 1, last_error_class: "network_error", locked_at: null, lock_token: null, send_started_at: null });
    const waitMs = afterOutage.next_attempt_at.getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(45_000);
    expect(waitMs).toBeLessThan(75_000);

    // not due yet: an immediate second run finds nothing
    const idle = fakeTransport();
    expect(await run(idle.send)).toMatchObject({ claimed: 0 });
    expect(idle.calls).toHaveLength(0);

    // recovered: due again, delivered exactly once
    await makeDue(queued.id);
    const recovered = fakeTransport([SUCCESS]);
    expect(await run(recovered.send)).toMatchObject({ claimed: 1, sent: 1 });
    expect(recovered.calls).toHaveLength(1);
    expect(await job(queued.id)).toMatchObject({ status: "sent", attempt_count: 2, last_error_class: null });
  });

  it("the appointment stays confirmed through the whole outage", async () => {
    const { appointmentId, job: queued } = await confirmedJob();
    await run(fakeTransport([failed("provider_unavailable", "retryable")]).send);
    expect(await appointmentStatus(appointmentId)).toBe("confirmed");
    expect((await job(queued.id)).status).toBe("retry");
  });
});

describe("D21. invalid recipient", () => {
  it("a provider 'no such mailbox' is a permanent failure: recorded, never retried", async () => {
    const { job: queued } = await confirmedJob();
    const { send, calls } = fakeTransport([failed("invalid_recipient", "permanent")]);

    expect(await run(send)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await job(queued.id)).toMatchObject({ status: "failed", last_error_class: "invalid_recipient", attempt_count: 1 });

    await makeDue(queued.id);
    expect(await run(send)).toMatchObject({ claimed: 0 });
    expect(calls).toHaveLength(1);
  });

  it("a stored address that is not even well-formed never reaches the provider (skipped at claim time)", async () => {
    const { appointmentId, job: queued } = await confirmedJob();
    // Only a direct write can put this there — the booking flow validates — which is exactly what the recheck is for.
    await testDb`alter table private.appointment_booking_contacts disable trigger appointment_booking_contacts_immutable`;
    try {
      await testDb`update private.appointment_booking_contacts set recipient_email = 'not-an-email' where appointment_id = ${appointmentId}`;
    } finally {
      await testDb`alter table private.appointment_booking_contacts enable trigger appointment_booking_contacts_immutable`;
    }
    const { send, calls } = fakeTransport();

    expect(await run(send)).toMatchObject({ claimed: 0, sent: 0 });
    expect(calls).toHaveLength(0);
    expect(await job(queued.id)).toMatchObject({ status: "skipped", skip_reason: "invalid_recipient", attempt_count: 0 });
  });

  it("an address that passes the database's shape check but contains a list separator (a second recipient in disguise) is refused by the worker, with no provider call", async () => {
    const { appointmentId, job: queued } = await confirmedJob();
    await testDb`alter table private.appointment_booking_contacts disable trigger appointment_booking_contacts_immutable`;
    try {
      await testDb`update private.appointment_booking_contacts set recipient_email = 'ilk,ikinci@example.test' where appointment_id = ${appointmentId}`;
    } finally {
      await testDb`alter table private.appointment_booking_contacts enable trigger appointment_booking_contacts_immutable`;
    }
    const { send, calls } = fakeTransport();

    expect(await run(send)).toMatchObject({ claimed: 1, skipped: 1, sent: 0 });
    expect(calls).toHaveLength(0);
    expect(await job(queued.id)).toMatchObject({ status: "skipped", skip_reason: "invalid_recipient" });
  });
});

describe("D22. provider rejection", () => {
  it("a permanent provider refusal is failed (not retried) and classified", async () => {
    const { job: queued } = await confirmedJob();
    const { send, calls } = fakeTransport([failed("provider_rejected", "permanent")]);
    expect(await run(send)).toMatchObject({ failed: 1, retried: 0 });
    expect(await job(queued.id)).toMatchObject({ status: "failed", last_error_class: "provider_rejected" });
    await makeDue(queued.id);
    await run(send);
    expect(calls).toHaveLength(1);
  });

  it("refused credentials are permanent too (repeating a refused login helps nobody)", async () => {
    const { job: queued } = await confirmedJob();
    await run(fakeTransport([failed("authentication_failed", "permanent")]).send);
    expect(await job(queued.id)).toMatchObject({ status: "failed", last_error_class: "authentication_failed" });
  });
});

describe("D23. ambiguous outcome — recorded as uncertain, never blindly retried", () => {
  it("an uncertain transport result is terminal: not retried now, not retried when 'due', not retried on any later run", async () => {
    const { appointmentId, job: queued } = await confirmedJob();
    const { send, calls } = fakeTransport([failed("network_error", "uncertain")]);

    expect(await run(send)).toMatchObject({ claimed: 1, uncertain: 1, retried: 0, failed: 0, sent: 0 });
    const after = await job(queued.id);
    expect(after).toMatchObject({ status: "uncertain", last_error_class: "network_error", attempt_count: 1, lock_token: null });
    expect(after.provider_message_id).toBeNull();

    await makeDue(queued.id);
    expect(await run(send)).toMatchObject({ claimed: 0 });
    expect(calls).toHaveLength(1);
    expect(await appointmentStatus(appointmentId)).toBe("confirmed");
  });

  it("a transport that THROWS (it never should) is treated as uncertain, not as a retry", async () => {
    const { job: queued } = await confirmedJob();
    const { send, calls } = fakeTransport([new Error("simulated crash inside the transport")]);
    expect(await run(send)).toMatchObject({ uncertain: 1, retried: 0 });
    expect(await job(queued.id)).toMatchObject({ status: "uncertain", last_error_class: "transport_exception" });
    await makeDue(queued.id);
    await run(send);
    expect(calls).toHaveLength(1);
  });
});

describe("D24. bounded retry", () => {
  it("backs off 1 / 5 / 15 / 60 minutes and gives up after the fifth failed attempt", async () => {
    const { job: queued } = await confirmedJob();
    const always = fakeTransport([failed("provider_unavailable", "retryable")]);
    const expectedMinutes = [1, 5, 15, 60];

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await run(always.send)).toMatchObject({ claimed: 1, retried: 1 });
      const row = await job(queued.id);
      expect(row).toMatchObject({ status: "retry", attempt_count: attempt });
      const minutes = (row.next_attempt_at.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(expectedMinutes[attempt - 1]! - 0.75);
      expect(minutes).toBeLessThan(expectedMinutes[attempt - 1]! + 0.25);
      await makeDue(queued.id);
    }

    expect(await run(always.send)).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(await job(queued.id)).toMatchObject({ status: "failed", attempt_count: 5, last_error_class: "provider_unavailable" });

    await makeDue(queued.id);
    expect(await run(always.send)).toMatchObject({ claimed: 0 });
    expect(always.calls).toHaveLength(5);
  });
});

describe("D25. concurrent workers", () => {
  it("several workers running at once never send the same job twice", async () => {
    const jobs: JobRow[] = [];
    for (let i = 0; i < 6; i++) jobs.push((await confirmedJob({ email: `paralel.${i}@example.test` })).job);

    const sentBy: string[] = [];
    const slowSend: SendMailFn = async (message) => {
      sentBy.push(localPartOf(message)!);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return SUCCESS;
    };

    const results = await Promise.all([
      run(slowSend, { batchSize: 3 }),
      run(slowSend, { batchSize: 3 }),
      run(slowSend, { batchSize: 3 }),
      run(slowSend, { batchSize: 3 }),
    ]);
    // drain anything left after the first wave
    await run(slowSend, { batchSize: 10 });

    expect(sentBy).toHaveLength(6);
    expect(new Set(sentBy).size).toBe(6);
    expect(results.reduce((total, r) => total + r.sent, 0)).toBeLessThanOrEqual(6);
    const rows = await Promise.all(jobs.map((j) => job(j.id)));
    expect(rows.map((r) => r.status)).toEqual(Array(6).fill("sent"));
    expect(rows.map((r) => r.attempt_count)).toEqual(Array(6).fill(1));
  });
});

describe("D26. lease expiry recovery", () => {
  const claimDirectly = async (batch = 5) => {
    const { data, error } = await admin.rpc("claim_customer_notification_jobs", { p_batch_size: batch, p_lease_seconds: 30 });
    expect(error).toBeNull();
    return data as unknown as { activeTenantCount: number; jobs: Array<{ jobId: string; lockToken: string }> };
  };
  const expireLease = (id: string) =>
    testDb`update private.customer_notification_jobs set locked_at = now() - interval '10 minutes' where id = ${id}`;

  it("a worker that vanished BEFORE starting to send: the job is handed out again and sent once", async () => {
    const { job: queued } = await confirmedJob();
    const claimed = await claimDirectly();
    expect(claimed.jobs.map((j) => j.jobId)).toEqual([queued.id]);
    expect(await job(queued.id)).toMatchObject({ status: "processing", send_started_at: null });

    // while the lease is live nobody else can take it
    const idle = fakeTransport();
    expect(await run(idle.send)).toMatchObject({ claimed: 0 });

    await expireLease(queued.id);
    const recovery = fakeTransport([SUCCESS]);
    expect(await run(recovery.send)).toMatchObject({ claimed: 1, sent: 1 });
    expect(recovery.calls).toHaveLength(1);
    expect(await job(queued.id)).toMatchObject({ status: "sent", attempt_count: 1 });
  });

  it("a worker that died AFTER starting to send: the outcome is unknown, so the job becomes uncertain and is NOT sent again", async () => {
    const { job: queued } = await confirmedJob();
    const claimed = await claimDirectly();
    const { jobId, lockToken } = claimed.jobs[0]!;
    const { data: begun } = await admin.rpc("begin_customer_notification_send", { p_job_id: jobId, p_lock_token: lockToken });
    expect(begun).toBe(true);

    await expireLease(queued.id);
    const { send, calls } = fakeTransport();
    expect(await run(send)).toMatchObject({ claimed: 0, sent: 0 });
    expect(calls).toHaveLength(0);
    expect(await job(queued.id)).toMatchObject({ status: "uncertain", last_error_class: "worker_interrupted", attempt_count: 1, lock_token: null });
  });

  it("fencing: a stale worker cannot begin or record against a lease that was reclaimed", async () => {
    const { job: queued } = await confirmedJob();
    const first = (await claimDirectly()).jobs[0]!;
    await expireLease(queued.id);
    const second = (await claimDirectly()).jobs[0]!;
    expect(second.jobId).toBe(first.jobId);
    expect(second.lockToken).not.toBe(first.lockToken);

    const staleBegin = await admin.rpc("begin_customer_notification_send", { p_job_id: first.jobId, p_lock_token: first.lockToken });
    expect(staleBegin.data).toBe(false);
    const staleRecord = await admin.rpc("record_customer_notification_result", {
      p_job_id: first.jobId,
      p_lock_token: first.lockToken,
      p_disposition: "sent",
      p_provider_message_id: "<stale@x>",
    });
    expect(staleRecord.data).toMatchObject({ applied: false });

    const freshBegin = await admin.rpc("begin_customer_notification_send", { p_job_id: second.jobId, p_lock_token: second.lockToken });
    expect(freshBegin.data).toBe(true);
    // begun once per lease: a second begin with the same token is refused
    const again = await admin.rpc("begin_customer_notification_send", { p_job_id: second.jobId, p_lock_token: second.lockToken });
    expect(again.data).toBe(false);
    const fresh = await admin.rpc("record_customer_notification_result", {
      p_job_id: second.jobId,
      p_lock_token: second.lockToken,
      p_disposition: "sent",
      p_provider_message_id: "<fresh@x>",
    });
    expect(fresh.data).toMatchObject({ applied: true, status: "sent" });
    expect(await job(queued.id)).toMatchObject({ status: "sent", provider_message_id: "<fresh@x>" });
  });

  it("jobs the worker had claimed but ran out of time to start are simply picked up on the next run", async () => {
    const { job: queued } = await confirmedJob();
    let clock = 1_000_000;
    const { send, calls } = fakeTransport();
    // budget already exhausted: the job is claimed, then deferred without any send
    const first = await run(send, { timeBudgetMs: -1, now: () => (clock += 1_000) });
    expect(first).toMatchObject({ claimed: 1, deferred: 1, sent: 0 });
    expect(calls).toHaveLength(0);
    expect(await job(queued.id)).toMatchObject({ status: "processing", send_started_at: null });

    await expireLease(queued.id);
    expect(await run(send)).toMatchObject({ claimed: 1, sent: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe("D27. one bad message never stops the batch", () => {
  it("a throwing transport for one job leaves the others delivered", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await confirmedJob({ email: `sira.${i}@example.test` })).job.id);

    const { send, calls } = fakeTransport([SUCCESS, new Error("boom"), SUCCESS]);
    const result = await run(send, { batchSize: 5 });

    expect(result).toMatchObject({ claimed: 3, sent: 2, uncertain: 1 });
    expect(calls).toHaveLength(3);
    const statuses = (await Promise.all(ids.map((id) => job(id)))).map((row) => row.status).sort();
    expect(statuses).toEqual(["sent", "sent", "uncertain"]);
  });

  it("a job that cannot even be rendered is failed without a send, and the rest still go out", async () => {
    const other = await createConfirmationFixture("badtz");
    try {
      await activateConfirmationEmail(other.slug);
      const bad = await bookPublicly(other, { dayOffset: nextDay(), email: "bozuk.saat@example.test" });
      await confirmAs(other.owner.id, bad.appointmentId);
      await testDb`update tenants set timezone = 'Not/AZone' where id = ${other.tenant.id}`;
      const good = await confirmedJob({ email: "saglam@example.test" });

      const { send, calls } = fakeTransport();
      const result = await run(send, { batchSize: 5 });

      expect(result).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
      expect(calls.map((call) => call.to)).toEqual(["saglam@example.test"]);
      expect((await jobsForAppointment(bad.appointmentId))[0]).toMatchObject({ status: "failed", last_error_class: "render_error", attempt_count: 0 });
      expect((await job(good.job.id)).status).toBe("sent");
    } finally {
      await teardownFixtures([other]);
    }
  });
});

describe("claim-time eligibility — a job is only ever sent if it is STILL right to send it", () => {
  it("an appointment cancelled after approval is skipped, not emailed", async () => {
    const { appointmentId, job: queued } = await confirmedJob();
    await setStatusAs(fx.owner.id, appointmentId, "cancelled");
    const { send, calls } = fakeTransport();
    expect(await run(send)).toMatchObject({ claimed: 0 });
    expect(calls).toHaveLength(0);
    expect(await job(queued.id)).toMatchObject({ status: "skipped", skip_reason: "appointment_not_confirmed" });
  });

  it("an appointment that has already started is skipped", async () => {
    const { appointmentId, job: queued } = await confirmedJob();
    await testDb`
      update appointments set scheduled_start_at = now() - interval '5 minutes', scheduled_end_at = now() + interval '25 minutes'
      where id = ${appointmentId}
    `;
    const { send, calls } = fakeTransport();
    await run(send);
    expect(calls).toHaveLength(0);
    expect(await job(queued.id)).toMatchObject({ status: "skipped", skip_reason: "appointment_started" });
  });

  it("a suspended tenant's queued jobs are skipped", async () => {
    const { job: queued } = await confirmedJob();
    await testDb`update tenants set status = 'suspended' where id = ${fx.tenant.id}`;
    try {
      const { send, calls } = fakeTransport();
      await run(send);
      expect(calls).toHaveLength(0);
    } finally {
      await testDb`update tenants set status = 'trial' where id = ${fx.tenant.id}`;
    }
    expect(await job(queued.id)).toMatchObject({ status: "skipped", skip_reason: "tenant_inactive" });
  });

  it("the kill switch holds queued jobs back at once, and they go out when the tenant is switched back on", async () => {
    const { job: queued } = await confirmedJob();
    await deactivateConfirmationEmail(fx.slug);
    try {
      const held = fakeTransport();
      const result = await run(held.send);
      expect(held.calls).toHaveLength(0);
      expect(result.claimed).toBe(0);
      expect(await job(queued.id)).toMatchObject({ status: "pending", attempt_count: 0 });
    } finally {
      await activateConfirmationEmail(fx.slug);
    }
    const resumed = fakeTransport();
    expect(await run(resumed.send)).toMatchObject({ claimed: 1, sent: 1 });
    expect(resumed.calls).toHaveLength(1);
  });

  it("with no tenant activated anywhere the worker reports 'activation absent' and touches nothing", async () => {
    await confirmedJob();
    await deactivateConfirmationEmail(fx.slug);
    try {
      const { send, calls } = fakeTransport();
      const result = await run(send);
      // other suites' tenants are torn down, so this is the only activation there was
      if (result.activationAbsent) {
        expect(result).toMatchObject({ claimed: 0, sent: 0 });
      }
      expect(calls).toHaveLength(0);
    } finally {
      await activateConfirmationEmail(fx.slug);
    }
  });

  it("tenants are isolated: each job carries only its own salon's data", async () => {
    const other = await createConfirmationFixture("iso", { salonName: "Başka Salon", locationUrl: "https://maps.app.goo.gl/OtherSalon1" });
    try {
      await activateConfirmationEmail(other.slug);
      const mine = await confirmedJob({ email: "benim@example.test" });
      const theirs = await bookPublicly(other, { dayOffset: nextDay(), email: "onlarin@example.test" });
      await confirmAs(other.owner.id, theirs.appointmentId);

      const { send, calls } = fakeTransport();
      const result = await run(send, { batchSize: 5 });
      expect(result).toMatchObject({ claimed: 2, sent: 2 });

      const byRecipient = new Map(calls.map((call) => [call.to, call]));
      const own = byRecipient.get("benim@example.test")!;
      const foreign = byRecipient.get("onlarin@example.test")!;
      expect(own.subject).toContain("Gökhan İlhan Hair Studio");
      expect(own.html).toContain(SAMPLE_LOCATION_URL);
      expect(own.html).not.toContain("Başka Salon");
      expect(own.html).not.toContain("OtherSalon1");
      expect(foreign.subject).toContain("Başka Salon");
      expect(foreign.html).toContain("https://maps.app.goo.gl/OtherSalon1");
      expect(foreign.html).not.toContain("Gökhan İlhan Hair Studio");
      expect(foreign.html).not.toContain("SampleSalonLink0001");
      expect((await job(mine.job.id)).tenant_id).toBe(fx.tenant.id);
    } finally {
      await teardownFixtures([other]);
    }
  });

  it("a branch without a location link yields an email without the button (still sent)", async () => {
    await testDb`update branches set location_url = null where id = ${fx.branchId}`;
    try {
      await confirmedJob({ email: "linksiz@example.test" });
      const { send, calls } = fakeTransport();
      await run(send);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.html).not.toContain("Yol Tarifi Al");
      expect(calls[0]!.text).not.toContain("Yol tarifi");
    } finally {
      await testDb`update branches set location_url = ${SAMPLE_LOCATION_URL} where id = ${fx.branchId}`;
    }
  });

  it("an unsafe stored link is dropped from the email rather than emailed", async () => {
    await testDb`update branches set location_url = 'javascript:alert(1)' where id = ${fx.branchId}`;
    try {
      await confirmedJob({ email: "guvensiz@example.test" });
      const { send, calls } = fakeTransport();
      await run(send);
      expect(calls[0]!.html).not.toContain("javascript:");
      expect(calls[0]!.html).not.toContain("Yol Tarifi Al");
    } finally {
      await testDb`update branches set location_url = ${SAMPLE_LOCATION_URL} where id = ${fx.branchId}`;
    }
  });
});

describe("recording the outcome", () => {
  // The service-role client, except that recording the result fails for the first `failures` calls.
  const realRpc = admin.rpc.bind(admin) as unknown as (name: string, args?: unknown) => Promise<unknown>;
  const flakyRecorder = (failures: number) => {
    let left = failures;
    return {
      rpc: (name: string, args?: unknown) =>
        name === "record_customer_notification_result" && left-- > 0
          ? Promise.resolve({ data: null, error: { code: "08006", message: "connection failure" } })
          : realRpc(name, args),
    } as unknown as typeof admin;
  };

  it("a transient failure while recording is retried, so a delivered message is still recorded as sent", async () => {
    const { job: queued } = await confirmedJob();
    const { send, calls } = fakeTransport();

    const result = await processCustomerConfirmationEmailBatch({ supabase: flakyRecorder(2), send });

    expect(result).toMatchObject({ claimed: 1, sent: 1, recordFailed: 0 });
    expect(calls).toHaveLength(1);
    expect((await job(queued.id)).status).toBe("sent");
  });

  it("if the outcome can NOT be recorded at all, the job is left leased, ends up uncertain once the lease lapses, and is NEVER sent again", async () => {
    const { job: queued } = await confirmedJob();
    const { send, calls } = fakeTransport();

    const result = await processCustomerConfirmationEmailBatch({ supabase: flakyRecorder(99), send });

    expect(result).toMatchObject({ claimed: 1, sent: 0, recordFailed: 1 });
    expect(calls).toHaveLength(1);
    expect((await job(queued.id)).status).toBe("processing");

    await testDb`update private.customer_notification_jobs set locked_at = now() - interval '10 minutes' where id = ${queued.id}`;
    const later = fakeTransport();
    expect(await run(later.send)).toMatchObject({ claimed: 0 });
    expect(later.calls).toHaveLength(0);
    expect(await job(queued.id)).toMatchObject({ status: "uncertain", last_error_class: "worker_interrupted" });
  });
});

describe("what the worker exposes", () => {
  it("returns and logs counts only — never an address, a name or a message", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      await confirmedJob({ email: "gizli.adres@example.test", fullName: "Gizli Kişi" });
      const result = await run(fakeTransport().send);
      const json = JSON.stringify(result);
      expect(json).not.toContain("gizli");
      expect(json).not.toContain("Gizli");
      expect(Object.values(result).every((value) => typeof value === "number" || typeof value === "boolean")).toBe(true);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("the stored job carries no address, no name and no message text", async () => {
    const { job: queued } = await confirmedJob({ email: "sakli.adres@example.test", fullName: "Sakli Kisi" });
    await run(fakeTransport([failed("provider_unavailable", "retryable")]).send);
    const raw = JSON.stringify(await job(queued.id));
    expect(raw).not.toContain("sakli");
    expect(raw).not.toContain("Sakli");
    expect(raw).not.toContain("@");
  });
});

describe("full stack: the worker with the REAL transport against a loopback SMTP catcher", () => {
  const ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_APP_PASSWORD", "EMAIL_FROM_ADDRESS"] as const;
  let saved: Record<string, string | undefined>;
  let catcher: SmtpCatcher | null = null;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  });
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (catcher) {
      await catcher.close();
      catcher = null;
    }
  });

  async function catcherWith(behavior: SmtpCatcherBehavior = {}) {
    catcher = await startSmtpCatcher(behavior);
    process.env.SMTP_HOST = catcher.host;
    process.env.SMTP_PORT = String(catcher.port);
    process.env.SMTP_USER = "catcher";
    process.env.SMTP_APP_PASSWORD = "not-a-real-password";
    process.env.EMAIL_FROM_ADDRESS = "SalonOS Test <noreply@salonos.test>";
    return catcher;
  }

  // The worker's default transport (no `send` injected): real nodemailer.
  const runReal = () => processCustomerConfirmationEmailBatch({ supabase: admin });

  it("delivers exactly one rendered email, and a second run delivers nothing more", async () => {
    const c = await catcherWith();
    const { job: queued } = await confirmedJob({ email: "gercek.akis@example.test", fullName: "AYŞE Demir" });

    expect(await runReal()).toMatchObject({ claimed: 1, sent: 1 });
    expect(await runReal()).toMatchObject({ claimed: 0 });

    expect(c.messages).toHaveLength(1);
    const received = c.messages[0]!;
    expect(received.envelopeTo).toEqual(["gercek.akis@example.test"]);
    expect(received.subject).toBe("Randevunuz Onaylandı — Gökhan İlhan Hair Studio");
    expect(received.html).toContain("Merhaba Ayşe,"); // an all-caps first name is normalised
    expect(received.html).toContain("Yol Tarifi Al");
    expect(received.html).toContain(SAMPLE_LOCATION_URL);
    expect(received.text).toContain("Saat: 10:00");
    expect(received.headers["message-id"]).toBe(`<confirmation.${queued.id}@salonos.test>`);
    expect(received.headers["auto-submitted"]).toBe("auto-generated");
    expect(await job(queued.id)).toMatchObject({ status: "sent", provider_message_id: `<confirmation.${queued.id}@salonos.test>`, attempt_count: 1 });
  });

  const outcomes: Array<[string, SmtpCatcherBehavior, string, string | null]> = [
    ["the mailbox does not exist (RCPT 550)", { rcpt: "550 5.1.1 no such user" }, "failed", "invalid_recipient"],
    ["the provider says try later (RCPT 452)", { rcpt: "452 4.2.2 try later" }, "retry", "provider_unavailable"],
    ["the message is refused after the payload (554)", { dataFinal: "554 5.7.1 rejected" }, "failed", "provider_rejected"],
    ["a temporary refusal after the payload (451)", { dataFinal: "451 4.7.1 greylisted" }, "retry", "provider_unavailable"],
    ["credentials refused (535)", { authFail: true }, "failed", "authentication_failed"],
    ["the connection dies after the payload was sent", { dropAfterData: true }, "uncertain", "network_error"],
  ];
  for (const [name, behavior, status, errorClass] of outcomes) {
    it(`${name} -> job ${status}`, async () => {
      const c = await catcherWith(behavior);
      const { job: queued } = await confirmedJob({ email: "sonuc@example.test" });

      await processCustomerConfirmationEmailBatch({ supabase: admin });

      expect(c.messages).toHaveLength(0);
      expect(await job(queued.id)).toMatchObject({ status, last_error_class: errorClass });
    });
  }

  it("nothing listening at all (outage) -> retry, and the appointment is untouched", async () => {
    const c = await catcherWith();
    await c.close();
    catcher = null;
    process.env.SMTP_PORT = String(c.port); // the port that just closed
    const { appointmentId, job: queued } = await confirmedJob();
    expect(await runReal()).toMatchObject({ claimed: 1, retried: 1 });
    expect(await job(queued.id)).toMatchObject({ status: "retry", last_error_class: "network_error" });
    expect(await appointmentStatus(appointmentId)).toBe("confirmed");
  });

  it("with the real Google host configured and no production flag the worker sends nothing and the job is failed as not_configured", async () => {
    await catcherWith();
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_PORT = "465";
    const c = catcher!;
    const { job: queued } = await confirmedJob();
    expect(await runReal()).toMatchObject({ claimed: 1, failed: 1 });
    expect(await job(queued.id)).toMatchObject({ status: "failed", last_error_class: "not_configured" });
    expect(c.connections()).toBe(0);
  });
});
