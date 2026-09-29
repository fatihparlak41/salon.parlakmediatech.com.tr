import { randomUUID } from "node:crypto";
import {
  asAuthenticatedUser,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  safeMorningStart,
  testDb,
  type TestService,
  type TestStaffMember,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz NOTIF.1A — shared fixtures for the customer-confirmation-email
 * tests (outbox, worker, endpoint). Not a test file itself.
 *
 * Every fixture salon is in Europe/Istanbul (fixed UTC+3, no DST) with a
 * 06:00-22:00 schedule on every weekday, so a booking at 10:00 local is
 * always a valid slot regardless of which day the suite happens to run —
 * none of these tests depends on the calendar (the DST-sensitive
 * fixtures that a few older public-booking tests use are deliberately
 * avoided here).
 *
 * Only synthetic addresses are ever used: the reserved `.test` domain
 * (RFC 2606), which can never resolve to a real mailbox.
 */

export type ConfirmationFixture = {
  owner: TestUser;
  tenant: TestTenant;
  slug: string;
  branchId: string;
  staff: TestStaffMember;
  service: TestService;
  service2: TestService;
};

export const SAMPLE_LOCATION_URL = "https://share.google/SampleSalonLink0001";

function uniqueSlug(label: string): string {
  return `test-n1a-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function createConfirmationFixture(
  label: string,
  options: { salonName?: string; locationUrl?: string | null; timezone?: string } = {},
): Promise<ConfirmationFixture> {
  const owner = await createTestUser(`n1a-${label}`);
  const slug = uniqueSlug(label);
  const tenant = await createTestTenant(slug, owner.id);

  const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
  if (!feature) throw new Error("online_booking feature missing from catalog");
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenant.id}, ${feature.id}, true)`;

  await testDb`
    update tenants
    set name = ${options.salonName ?? "Örnek Salon"}, timezone = ${options.timezone ?? "Europe/Istanbul"}
    where id = ${tenant.id}
  `;

  const branchId = await createBranch(tenant.id, "Şube Bir");
  await testDb`update branches set location_url = ${options.locationUrl === undefined ? SAMPLE_LOCATION_URL : options.locationUrl} where id = ${branchId}`;

  const staff = await createStaffMember(tenant.id, "Personel Bir");
  const service = await createService(tenant.id, "Saç Kesimi", 30, 500);
  const service2 = await createService(tenant.id, "Fön", 30, 300);
  await linkStaffBranch(staff.id, branchId);
  await linkServiceBranch(service.id, branchId);
  await linkServiceBranch(service2.id, branchId);
  await linkStaffService(staff.id, service.id);
  await linkStaffService(staff.id, service2.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenant.id, staff.id, weekday, "06:00", "22:00");
  }

  return { owner, tenant, slug, branchId, staff, service, service2 };
}

export async function teardownFixtures(fixtures: ConfirmationFixture[], extraUsers: TestUser[] = []): Promise<void> {
  await cleanupTenants(fixtures.map((fixture) => fixture.tenant.id));
  await cleanupUsers([...fixtures.map((fixture) => fixture.owner.id), ...extraUsers.map((user) => user.id)]);
}

export async function activateConfirmationEmail(slug: string): Promise<{ activatedAt: string }> {
  const [row] = await testDb<{ result: { activatedAt: string } }[]>`
    select private.activate_customer_confirmation_email(${slug}) as result
  `;
  return row!.result;
}

export async function deactivateConfirmationEmail(slug: string): Promise<void> {
  await testDb`select private.deactivate_customer_confirmation_email(${slug})`;
}

/** 10:00 salon-local (Istanbul) on the day `dayOffset` days from now. */
export function slotStart(dayOffset: number): Date {
  return new Date(safeMorningStart(dayOffset).getTime() + 2 * 3600_000);
}

let phoneCounter = Math.floor(Math.random() * 1_000_000);
export function freshPhone(): string {
  phoneCounter += 1;
  return `+90555${String(1_000_000 + (phoneCounter % 9_000_000)).padStart(7, "0")}`;
}

export type BookingOptions = {
  dayOffset: number;
  /** undefined = omit, null = omit, string = supplied */
  email?: string | null;
  fullName?: string;
  phone?: string;
  serviceId?: string;
  idempotencyKey?: string;
};

export type PublicBooking = {
  appointmentId: string;
  confirmation: Record<string, unknown>;
  email: string | null;
  phone: string;
  fullName: string;
  idempotencyKey: string;
};

/** The exact call the booking gateway makes (public.create_guest_booking,
 * the only entry point), as the unrestricted test connection. */
export async function bookPublicly(fixture: ConfirmationFixture, options: BookingOptions): Promise<PublicBooking> {
  const phone = options.phone ?? freshPhone();
  const fullName = options.fullName ?? "Ayşe Yılmaz";
  const email = options.email === undefined ? "ayse.musteri@example.test" : options.email;
  const idempotencyKey = options.idempotencyKey ?? randomUUID();

  const [row] = await testDb<{ result: Record<string, unknown> }[]>`
    select public.create_guest_booking(
      ${fixture.slug},
      ${fixture.branchId}::uuid,
      ${options.serviceId ?? fixture.service.id}::uuid,
      ${slotStart(options.dayOffset).toISOString()}::timestamptz,
      ${fullName},
      ${phone},
      ${fixture.staff.id}::uuid,
      ${email},
      ${idempotencyKey}::uuid,
      ${null}::uuid,
      ${null}
    ) as result
  `;
  return {
    appointmentId: row!.result.appointmentReference as string,
    confirmation: row!.result,
    email,
    phone,
    fullName,
    idempotencyKey,
  };
}

/** The trusted status RPC, as a signed-in salon user. */
export async function setStatusAs(userId: string, appointmentId: string, status: string): Promise<void> {
  await asAuthenticatedUser(userId, (sql) => sql`select public.update_appointment_status(${appointmentId}::uuid, ${status})`);
}

export async function confirmAs(userId: string, appointmentId: string): Promise<void> {
  await setStatusAs(userId, appointmentId, "confirmed");
}

export type JobRow = {
  id: string;
  tenant_id: string;
  appointment_id: string;
  notification_type: string;
  channel: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  locked_at: Date | null;
  lock_token: string | null;
  send_started_at: Date | null;
  sent_at: Date | null;
  provider_message_id: string | null;
  last_error_class: string | null;
  skip_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function jobsForAppointment(appointmentId: string): Promise<JobRow[]> {
  return testDb<JobRow[]>`
    select * from private.customer_notification_jobs where appointment_id = ${appointmentId} order by created_at
  `;
}

export async function jobsForTenant(tenantId: string): Promise<JobRow[]> {
  return testDb<JobRow[]>`
    select * from private.customer_notification_jobs where tenant_id = ${tenantId} order by created_at
  `;
}

export type ContactRow = {
  appointment_id: string;
  tenant_id: string;
  recipient_email: string;
  greeting_name: string | null;
  created_at: Date;
};

export async function contactForAppointment(appointmentId: string): Promise<ContactRow | undefined> {
  const [row] = await testDb<ContactRow[]>`
    select * from private.appointment_booking_contacts where appointment_id = ${appointmentId}
  `;
  return row;
}

export async function appointmentStatus(appointmentId: string): Promise<string> {
  const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
  return row!.status;
}

/** A directly-inserted appointment with an arbitrary `source` (the public
 * booking flow only ever writes 'public_booking'; staff-created ones are
 * 'internal'). Used to prove the trigger is limited to public bookings. */
export async function insertAppointmentWithSource(
  fixture: ConfirmationFixture,
  source: string | null,
  dayOffset: number,
): Promise<string> {
  const [customer] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name, phone, email)
    values (${fixture.tenant.id}, 'Kaynak Testi', ${freshPhone()}, 'kaynak.testi@example.test')
    returning id
  `;
  const start = slotStart(dayOffset);
  const end = new Date(start.getTime() + 30 * 60_000);
  const [appointment] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at)
    values (${fixture.tenant.id}, ${fixture.branchId}, ${customer!.id}, 'scheduled', ${source}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
    returning id
  `;
  return appointment!.id;
}
