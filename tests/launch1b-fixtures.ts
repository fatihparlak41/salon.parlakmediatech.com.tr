import { randomUUID } from "node:crypto";
import { asAuthenticatedUser, testDb } from "./helpers";
import { freshPhone, type ConfirmationFixture } from "./customer-confirmation-fixtures";

/**
 * Faz LAUNCH.1B — shared fixtures for the customer-notification lifecycle tests. Not a
 * test file. Builds on the NOTIF.1A fixtures (one salon, Europe/Istanbul, one staff
 * member, two services) and adds: owner-driven switches (through the real RPC),
 * directly-inserted appointments at an exact offset from "now" (the database clock is the
 * only clock the reminder rule trusts, so tests place appointments relative to it), and
 * the claim / job helpers.
 *
 * Synthetic data only: `.test` addresses, made-up names.
 */

export const NOTIFICATION_TYPES = [
  "appointment_confirmation",
  "appointment_update",
  "appointment_cancellation",
  "appointment_reminder_24h",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Turn switches ON/OFF through the real owner RPC (settings.manage). */
export async function setSwitches(
  fixture: ConfirmationFixture,
  states: Partial<Record<NotificationType, boolean>>,
): Promise<void> {
  for (const [type, enabled] of Object.entries(states) as [NotificationType, boolean][]) {
    await asAuthenticatedUser(fixture.owner.id, (sql) =>
      sql`select public.set_customer_notification_setting(${fixture.tenant.id}::uuid, ${type}, ${enabled})`,
    );
  }
}

export async function allSwitchesOn(fixture: ConfirmationFixture): Promise<void> {
  await setSwitches(fixture, {
    appointment_confirmation: true,
    appointment_update: true,
    appointment_cancellation: true,
    appointment_reminder_24h: true,
  });
}

export type MadeAppointment = {
  appointmentId: string;
  customerId: string;
  itemId: string;
  email: string | null;
};

export type MakeAppointmentOptions = {
  /** Start, in minutes from the database's now(). */
  startInMinutes: number;
  durationMinutes?: number;
  /** Customer e-mail: a string, or null for a customer without one. */
  email?: string | null;
  fullName?: string;
  source?: string | null;
  /** Final status. 'confirmed' is applied with a plain UPDATE (the real trigger fires). */
  status?: "scheduled" | "confirmed";
  notes?: string | null;
  serviceId?: string;
  /** Make the appointment look like it was booked/moved this long ago (anchor set_at). */
  bookedMinutesAgo?: number;
};

/** An appointment created exactly as a staff member would (internal source), with one
 * item, at an exact offset from now(). The recipient snapshot is captured by the real
 * insert trigger, the schedule anchor by the real anchor trigger. */
export async function makeAppointment(fixture: ConfirmationFixture, options: MakeAppointmentOptions): Promise<MadeAppointment> {
  const email = options.email === undefined ? `musteri.${randomUUID().slice(0, 8)}@example.test` : options.email;
  const duration = options.durationMinutes ?? 30;
  const serviceId = options.serviceId ?? fixture.service.id;

  const [customer] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name, phone, email, notes)
    values (${fixture.tenant.id}, ${options.fullName ?? "Ayşe Yılmaz"}, ${freshPhone()}, ${email}, 'MÜŞTERİ-NOTU-GİZLİ-123')
    returning id
  `;
  const [appointment] = await testDb<{ id: string; start: Date }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, source, notes, scheduled_start_at, scheduled_end_at)
    values (
      ${fixture.tenant.id}, ${fixture.branchId}, ${customer!.id}, 'scheduled', ${options.source === undefined ? "internal" : options.source},
      ${options.notes === undefined ? "RANDEVU-NOTU-GİZLİ-456" : options.notes},
      now() + make_interval(mins => ${options.startInMinutes}),
      now() + make_interval(mins => ${options.startInMinutes + duration})
    )
    returning id, scheduled_start_at as start
  `;
  const [item] = await testDb<{ id: string }[]>`
    insert into appointment_items (
      tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence
    )
    values (
      ${fixture.tenant.id}, ${appointment!.id}, ${serviceId}, ${fixture.staff.id},
      now() + make_interval(mins => ${options.startInMinutes}),
      now() + make_interval(mins => ${options.startInMinutes + duration}),
      ${duration}, 500, 1
    )
    returning id
  `;

  if (options.bookedMinutesAgo !== undefined) {
    await setAnchorAge(appointment!.id, options.bookedMinutesAgo);
  }
  if (options.status === "confirmed") {
    await testDb`update appointments set status = 'confirmed' where id = ${appointment!.id}`;
  }
  return { appointmentId: appointment!.id, customerId: customer!.id, itemId: item!.id, email };
}

/** Pretend the appointment's current start was set `minutesAgo` minutes ago. */
export async function setAnchorAge(appointmentId: string, minutesAgo: number): Promise<void> {
  await testDb`
    update private.appointment_schedule_anchor
    set set_at = now() - make_interval(mins => ${minutesAgo})
    where appointment_id = ${appointmentId}
  `;
}

/** Move the appointment start (the real update trigger path), keeping its duration. */
export async function moveAppointmentTo(appointmentId: string, startInMinutes: number, durationMinutes = 30): Promise<void> {
  await testDb`
    update appointments
    set scheduled_start_at = now() + make_interval(mins => ${startInMinutes}),
        scheduled_end_at = now() + make_interval(mins => ${startInMinutes + durationMinutes})
    where id = ${appointmentId}
  `;
  await testDb`
    update appointment_items
    set scheduled_start_at = now() + make_interval(mins => ${startInMinutes}),
        scheduled_end_at = now() + make_interval(mins => ${startInMinutes + durationMinutes})
    where appointment_id = ${appointmentId}
  `;
}

export async function setStatus(appointmentId: string, status: string): Promise<void> {
  await testDb`update appointments set status = ${status} where id = ${appointmentId}`;
}

export type ClaimedJob = {
  jobId: string;
  lockToken: string;
  attemptCount: number;
  notificationType: NotificationType;
  recipientEmail: string;
  greetingName: string | null;
  salonName: string;
  tenantSlug: string;
  tenantTimezone: string;
  appointmentStartAt: string;
  serviceNames: string[];
  staffNames: string[];
  contactPhone: string | null;
  locationUrl: string | null;
};

/** One claim, as the worker makes it, restricted to the jobs of the given salon(s)
 * (other salons' jobs, if any, are claimed by the same call exactly as in production). */
export async function claim(slugs: string[], batch = 50): Promise<ClaimedJob[]> {
  const [row] = await testDb<{ result: { jobs: ClaimedJob[] } }[]>`
    select private.claim_customer_notification_jobs(${batch}, 180) as result
  `;
  return row!.result.jobs.filter((job) => slugs.includes(job.tenantSlug));
}

export type JobSummary = {
  id: string;
  appointment_id: string;
  notification_type: NotificationType;
  status: string;
  skip_reason: string | null;
  dedupe_revision: string;
  target_start_at: Date | null;
  next_attempt_at: Date;
  attempt_count: number;
  tenant_id: string;
};

export async function jobs(appointmentId: string, type?: NotificationType): Promise<JobSummary[]> {
  return testDb<JobSummary[]>`
    select id, appointment_id, notification_type, status, skip_reason, dedupe_revision::text as dedupe_revision,
           target_start_at, next_attempt_at, attempt_count, tenant_id
    from private.customer_notification_jobs
    where appointment_id = ${appointmentId}
      and (${type ?? null}::text is null or notification_type = ${type ?? null}::text)
    order by notification_type, dedupe_revision
  `;
}

/** Record a job as sent (what a successful worker run does), through the real RPC. */
export async function markSent(jobId: string): Promise<void> {
  const [row] = await testDb<{ lock_token: string }[]>`
    update private.customer_notification_jobs
    set status = 'processing', locked_at = now(), lock_token = gen_random_uuid(), send_started_at = now(), attempt_count = attempt_count + 1
    where id = ${jobId}
    returning lock_token
  `;
  await testDb`select private.record_customer_notification_result(${jobId}::uuid, ${row!.lock_token}::uuid, 'sent', null, 'test-message-id', null)`;
}

/** Make a pending/retry job due right now. */
export async function makeDue(jobId: string): Promise<void> {
  await testDb`update private.customer_notification_jobs set next_attempt_at = now() - interval '1 second' where id = ${jobId}`;
}

export async function materialize(): Promise<number> {
  const [row] = await testDb<{ n: number }[]>`select private.materialize_customer_reminders() as n`;
  return row!.n;
}
