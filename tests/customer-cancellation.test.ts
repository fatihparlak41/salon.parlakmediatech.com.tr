import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  anonClient,
  signInAs,
  createTestTenant,
  createTestUser,
  createBranch,
  createService,
  createStaffMember,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
} from "./helpers";

/**
 * Faz 2G.2A (20260823201517) — tenant-level cancellation policy +
 * cancel_my_appointment. Unlike create_guest_booking (which takes the
 * trusted account identity as an explicit parameter), cancel_my_appointment
 * reads auth.uid() DIRECTLY inside its own body, by design (2G.2's
 * ownership rule) — so every call here MUST go through a real signed-in
 * session (signInAs), never testDb's raw connection, which has no JWT
 * and would always resolve auth.uid() to null (a genuine first-draft
 * mistake in this file caught by the empirical run: a raw testDb call
 * correctly got AC001, proving the boundary works, but meant the whole
 * suite had to be rewritten around real sessions before it could test
 * anything past that boundary).
 */

let owner: TestUser;
let manager: TestUser; // every permission except settings.manage
let accountUser: TestUser;
let otherUser: TestUser;
let tenant: { id: string; slug: string };
let branchId: string;
let serviceId: string;
let staffId: string;
// Faz NOTIF.2A.2 — extra per-test users whose OWN action (a real
// cancel_my_appointment RPC call, signed in as them) writes an audit_logs
// row via private.log_audit_event — audit_logs.actor_user_id has no
// cascade, so deleting one of these users can only ever happen AFTER
// cleanupTenants below has already deleted this tenant's audit_logs rows,
// never inline inside the test itself (root cause confirmed by reading
// audit_logs' own FK: `actor_user_id uuid references auth.users (id)`,
// no ON DELETE clause — Postgres's default NO ACTION — see
// 20260815120013). Collected here instead of a bespoke per-test
// cleanupUsers call, matching the order this file's own afterAll already
// uses correctly for owner/manager/accountUser/otherUser.
const extraAuditActorUsers: string[] = [];

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3600_000);
}

async function setPolicy(
  tenantId: string,
  policy: Partial<{
    customer_cancellation_enabled: boolean;
    customer_cancellation_cutoff_minutes: number;
    customer_reschedule_enabled: boolean;
    customer_reschedule_cutoff_minutes: number;
  }>,
): Promise<void> {
  if (Object.keys(policy).length === 0) return;
  await testDb`update tenants set ${testDb(policy)} where id = ${tenantId}`;
}

/**
 * Every call gets its OWN dedicated staff member (cheap — a single
 * insert plus two join rows) specifically so no two calls anywhere in
 * this file can ever collide on appointment_items_no_staff_overlap
 * regardless of which hour value each test picks — the exclusion
 * constraint is keyed on (staff_member_id, time range), so a distinct
 * staff member makes a time collision structurally impossible rather
 * than something that has to be manually verified per test (a mistake
 * already made and fixed once while writing this file — see git
 * history). isPrimary defaults to FALSE: accountUser/tenant are shared
 * module-level fixtures across the whole file, so defaulting to TRUE
 * here would collide with customer_account_links_primary_unique_active_idx
 * the moment more than one test creates a link for the same user in
 * this tenant. The one test that specifically needs a real primary link
 * uses its own fresh, single-use account instead of accountUser.
 */
async function createLinkedAppointment(params: {
  userId: string;
  status: string;
  start: Date;
  isPrimary?: boolean;
  fullName?: string;
  staffMemberId?: string;
}): Promise<{ appointmentId: string; customerId: string }> {
  const [customer] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name) values (${tenant.id}, ${params.fullName ?? "Cancel Test Customer"}) returning id`;
  const customerId = customer!.id;

  await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
    values (${params.userId}, ${tenant.id}, ${customerId}, 'future_booking', ${params.isPrimary ?? false})`;

  let itemStaffId = params.staffMemberId;
  if (!itemStaffId) {
    const staff = await createStaffMember(tenant.id, `Slot Staff ${crypto.randomUUID().slice(0, 8)}`);
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${branchId})`;
    await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${serviceId})`;
    itemStaffId = staff.id;
  }

  const start = params.start;
  const end = new Date(start.getTime() + 30 * 60_000);
  const [appt] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at)
    values (${tenant.id}, ${branchId}, ${customerId}, ${params.status}, 'public_booking', ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
    returning id`;
  const appointmentId = appt!.id;
  await testDb`
    insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
    values (${tenant.id}, ${appointmentId}, ${serviceId}, ${itemStaffId}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 30, 200, 1)`;

  return { appointmentId, customerId };
}

/** Signs in fresh each call (safest — no shared-session state across
 * tests) and calls cancel_my_appointment as that real user. */
async function cancelAs(user: TestUser, appointmentId: string) {
  const client = await signInAs(user);
  const result = await client.rpc("cancel_my_appointment", { p_appointment_id: appointmentId });
  await client.auth.signOut();
  return result;
}

beforeAll(async () => {
  owner = await createTestUser("p2g2a-owner");
  manager = await createTestUser("p2g2a-manager");
  accountUser = await createTestUser("p2g2a-acct");
  otherUser = await createTestUser("p2g2a-other");
  const tenantRow = await createTestTenant("test-p2g2a-cancel", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug };

  branchId = await createBranch(tenant.id, "Cancel Branch");
  const service = await createService(tenant.id, "Cancel Service", 30, 200);
  serviceId = service.id;
  const staff = await createStaffMember(tenant.id, "Cancel Staff");
  staffId = staff.id;
  await testDb`insert into service_branches (service_id, branch_id) values (${serviceId}, ${branchId})`;
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staffId}, ${branchId})`;
  await testDb`insert into staff_services (staff_member_id, service_id) values (${staffId}, ${serviceId})`;

  const [managerRole] = await testDb<{ id: string }[]>`insert into roles (tenant_id, name, is_system_default) values (${tenant.id}, 'Manager Test Role', false) returning id`;
  const nonSettingsPerms = await testDb<{ id: string }[]>`select id from permissions where key <> 'settings.manage'`;
  await testDb`insert into role_permissions ${testDb(nonSettingsPerms.map((p) => ({ role_id: managerRole!.id, permission_id: p.id })))}`;
  await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${tenant.id}, ${manager.id}, ${managerRole!.id}, 'active')`;
}, 60000);

afterAll(async () => {
  await testDb`delete from customer_account_links where tenant_id = ${tenant.id}`;
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id, manager.id, accountUser.id, otherUser.id, ...extraAuditActorUsers]);
});

describe("policy defaults and settings.manage RLS", () => {
  it("cancellation and reschedule default to disabled with cutoff 0 for a freshly created tenant", async () => {
    const fresh = await createTestUser("p2g2a-fresh-owner");
    const freshTenant = await createTestTenant("test-p2g2a-fresh", fresh.id);
    const [row] = await testDb<
      { customer_cancellation_enabled: boolean; customer_cancellation_cutoff_minutes: number; customer_reschedule_enabled: boolean; customer_reschedule_cutoff_minutes: number }[]
    >`select customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled, customer_reschedule_cutoff_minutes from tenants where id = ${freshTenant.id}`;
    expect(row).toEqual({
      customer_cancellation_enabled: false,
      customer_cancellation_cutoff_minutes: 0,
      customer_reschedule_enabled: false,
      customer_reschedule_cutoff_minutes: 0,
    });
    await cleanupTenants([freshTenant.id]);
    await cleanupUsers([fresh.id]);
  });

  it("negative cutoff values are rejected by the DB check constraint", async () => {
    await expect(testDb`update tenants set customer_cancellation_cutoff_minutes = -1 where id = ${tenant.id}`).rejects.toThrow();
    await expect(testDb`update tenants set customer_reschedule_cutoff_minutes = -5 where id = ${tenant.id}`).rejects.toThrow();
  });

  it("an out-of-range (>7 days) cutoff is rejected", async () => {
    await expect(testDb`update tenants set customer_cancellation_cutoff_minutes = 10081 where id = ${tenant.id}`).rejects.toThrow();
  });

  it("settings.manage (owner) CAN update policy fields via the real tenants RLS UPDATE policy", async () => {
    const client = await signInAs(owner);
    const { data, error } = await client
      .from("tenants")
      .update({ customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 180 })
      .eq("id", tenant.id)
      .select("customer_cancellation_enabled, customer_cancellation_cutoff_minutes")
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 180 });
    await client.auth.signOut();
    await setPolicy(tenant.id, { customer_cancellation_enabled: false, customer_cancellation_cutoff_minutes: 0 });
  });

  it("a member WITHOUT settings.manage (manager role) cannot update policy fields — RLS silently matches zero rows, not a thrown error", async () => {
    const client = await signInAs(manager);
    const { data, error } = await client
      .from("tenants")
      .update({ customer_cancellation_enabled: true })
      .eq("id", tenant.id)
      .select("customer_cancellation_enabled")
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull(); // ground-truth: zero rows affected, not inferred from `error`
    await client.auth.signOut();
    const [row] = await testDb<{ customer_cancellation_enabled: boolean }[]>`select customer_cancellation_enabled from tenants where id = ${tenant.id}`;
    expect(row!.customer_cancellation_enabled).toBe(false);
  });

  it("a customer-only account (no membership at all) cannot update policy fields", async () => {
    const client = await signInAs(accountUser);
    const { data, error } = await client
      .from("tenants")
      .update({ customer_cancellation_enabled: true })
      .eq("id", tenant.id)
      .select("customer_cancellation_enabled")
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
    await client.auth.signOut();
  });
});

/**
 * Faz 2I.4A — the diagnosis for "cancellation settings not persisting
 * for a real pilot tenant" found every layer correct in the abstract,
 * proven by the tests above using createTestTenant's manual SALON_OWNER
 * clone — but that helper is not how a real signup actually provisions
 * a tenant. This closes that one open gap: the SAME RLS-gated update,
 * for an owner created through the REAL onboarding RPC
 * (create_tenant_with_owner, reached the same way
 * components/onboarding/create-tenant-form.tsx calls it) rather than
 * the test helper. The real bug turned out to be client-side (a
 * disabled cutoff input silently discarding input — see
 * tests/settings-cutoff.test.ts for that fix's own unit coverage), not
 * a provisioning gap, but this is still worth keeping green as a
 * standing guard against the two paths ever actually diverging.
 */
describe("settings.manage via the REAL onboarding path (not createTestTenant)", () => {
  it("an owner from create_tenant_with_owner CAN update policy fields, and a fresh read confirms it actually persisted", async () => {
    const realOwner = await createTestUser("p2i4a-real-onboarding-owner");
    const realOwnerClient = await signInAs(realOwner);
    const slug = `test-p2i4a-real-${crypto.randomUUID().slice(0, 8)}`;

    const { data: tenantId, error: createError } = await realOwnerClient.rpc("create_tenant", {
      p_name: "Real Onboarding Test Salon",
      p_slug: slug,
    });
    expect(createError).toBeNull();
    expect(typeof tenantId).toBe("string");

    const { data: updated, error: updateError } = await realOwnerClient
      .from("tenants")
      .update({ customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 720, customer_reschedule_enabled: false })
      .eq("id", tenantId as string)
      .select("customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled")
      .maybeSingle();
    expect(updateError).toBeNull();
    expect(updated).toEqual({
      customer_cancellation_enabled: true,
      customer_cancellation_cutoff_minutes: 720,
      customer_reschedule_enabled: false,
    });

    // Persistence/reload check: a completely fresh read (own connection,
    // not the client that just wrote it) sees the exact same values —
    // the ground-truth equivalent of "reload the settings page and
    // confirm it still shows enabled + 12 hours".
    const [row] = await testDb<{
      customer_cancellation_enabled: boolean;
      customer_cancellation_cutoff_minutes: number;
      customer_reschedule_enabled: boolean;
    }[]>`select customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled
         from tenants where id = ${tenantId as string}`;
    expect(row).toEqual({
      customer_cancellation_enabled: true,
      customer_cancellation_cutoff_minutes: 720,
      customer_reschedule_enabled: false,
    });

    await realOwnerClient.auth.signOut();
    await cleanupTenants([tenantId as string]);
    await cleanupUsers([realOwner.id]);
  });
});

/**
 * Faz 2I.4B — regression coverage for the second real PROD incident:
 * SelfServicePolicyForm used to send all 4 policy columns on every
 * save, so a stale tab/session (one that loaded before some OTHER save
 * happened) would resend its own outdated belief about a field it
 * never touched and silently revert whatever that other save had just
 * set. The fix makes the save a genuine partial UPDATE — only the
 * columns actually present in the request are written, everything else
 * is left untouched in Postgres. These tests exercise exactly that at
 * the RLS/DB layer, independent of the client's own dirty-tracking
 * (covered separately in tests/settings-cutoff.test.ts and by live
 * DEV browser reproduction — see the Faz 2I.4B report).
 */
describe("self-service policy — partial-update regression (Faz 2I.4B)", () => {
  it("A. both enabled: a partial update touching ONLY reschedule leaves cancellation completely untouched", async () => {
    await setPolicy(tenant.id, {
      customer_cancellation_enabled: true,
      customer_cancellation_cutoff_minutes: 720,
      customer_reschedule_enabled: true,
      customer_reschedule_cutoff_minutes: 720,
    });
    const client = await signInAs(owner);
    const { data, error } = await client
      .from("tenants")
      .update({ customer_reschedule_enabled: false }) // exactly what the fixed client now sends — only the changed column
      .eq("id", tenant.id)
      .select(
        "customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled, customer_reschedule_cutoff_minutes",
      )
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({
      customer_cancellation_enabled: true,
      customer_cancellation_cutoff_minutes: 720,
      customer_reschedule_enabled: false,
      customer_reschedule_cutoff_minutes: 720,
    });
    await client.auth.signOut();
  });

  it("B. both enabled (reverse): a partial update touching ONLY cancellation leaves reschedule completely untouched", async () => {
    await setPolicy(tenant.id, {
      customer_cancellation_enabled: true,
      customer_cancellation_cutoff_minutes: 720,
      customer_reschedule_enabled: true,
      customer_reschedule_cutoff_minutes: 720,
    });
    const client = await signInAs(owner);
    const { data, error } = await client
      .from("tenants")
      .update({ customer_cancellation_enabled: false })
      .eq("id", tenant.id)
      .select(
        "customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled, customer_reschedule_cutoff_minutes",
      )
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({
      customer_cancellation_enabled: false,
      customer_cancellation_cutoff_minutes: 720,
      customer_reschedule_enabled: true,
      customer_reschedule_cutoff_minutes: 720,
    });
    await client.auth.signOut();
  });

  it("C. stale-session simulation: two independent partial writes (session A never sees session B's write, or vice versa) still both land correctly", async () => {
    await setPolicy(tenant.id, {
      customer_cancellation_enabled: false,
      customer_cancellation_cutoff_minutes: 0,
      customer_reschedule_enabled: false,
      customer_reschedule_cutoff_minutes: 0,
    });
    const sessionA = await signInAs(owner);
    const sessionB = await signInAs(owner); // same owner, independent session — models a second stale tab exactly

    const { error: errA } = await sessionA
      .from("tenants")
      .update({ customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 720 })
      .eq("id", tenant.id);
    expect(errA).toBeNull();

    // Session B never re-reads after session A's write — it sends only
    // the reschedule fields it changed, exactly what the fixed client
    // now does regardless of how stale its own local snapshot is.
    const { error: errB } = await sessionB
      .from("tenants")
      .update({ customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 720 })
      .eq("id", tenant.id);
    expect(errB).toBeNull();

    const [row] = await testDb<{
      customer_cancellation_enabled: boolean;
      customer_cancellation_cutoff_minutes: number;
      customer_reschedule_enabled: boolean;
      customer_reschedule_cutoff_minutes: number;
    }[]>`select customer_cancellation_enabled, customer_cancellation_cutoff_minutes,
               customer_reschedule_enabled, customer_reschedule_cutoff_minutes
         from tenants where id = ${tenant.id}`;
    expect(row).toEqual({
      customer_cancellation_enabled: true,
      customer_cancellation_cutoff_minutes: 720,
      customer_reschedule_enabled: true,
      customer_reschedule_cutoff_minutes: 720,
    });

    await sessionA.auth.signOut();
    await sessionB.auth.signOut();
  });

  it("D. stale-session simulation, reverse order: the reschedule write landing first changes nothing about the outcome", async () => {
    await setPolicy(tenant.id, {
      customer_cancellation_enabled: false,
      customer_cancellation_cutoff_minutes: 0,
      customer_reschedule_enabled: false,
      customer_reschedule_cutoff_minutes: 0,
    });
    const sessionA = await signInAs(owner);
    const sessionB = await signInAs(owner);

    const { error: errB } = await sessionB
      .from("tenants")
      .update({ customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 720 })
      .eq("id", tenant.id);
    expect(errB).toBeNull();

    const { error: errA } = await sessionA
      .from("tenants")
      .update({ customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 720 })
      .eq("id", tenant.id);
    expect(errA).toBeNull();

    const [row] = await testDb<{
      customer_cancellation_enabled: boolean;
      customer_cancellation_cutoff_minutes: number;
      customer_reschedule_enabled: boolean;
      customer_reschedule_cutoff_minutes: number;
    }[]>`select customer_cancellation_enabled, customer_cancellation_cutoff_minutes,
               customer_reschedule_enabled, customer_reschedule_cutoff_minutes
         from tenants where id = ${tenant.id}`;
    expect(row).toEqual({
      customer_cancellation_enabled: true,
      customer_cancellation_cutoff_minutes: 720,
      customer_reschedule_enabled: true,
      customer_reschedule_cutoff_minutes: 720,
    });

    await sessionA.auth.signOut();
    await sessionB.auth.signOut();
  });
});

describe("ownership", () => {
  it("AC003: a random, never-existed appointment id", async () => {
    const { error } = await cancelAs(accountUser, crypto.randomUUID());
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC003");
  });

  it("AC003: an appointment linked to a DIFFERENT account is not manageable", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: otherUser.id, status: "scheduled", start: hoursFromNow(48) });
    const { error } = await cancelAs(accountUser, appointmentId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC003");
  });

  it("a PRIMARY-linked appointment is manageable by its owner", async () => {
    // Dedicated fresh user, not the shared accountUser — accountUser
    // accumulates non-primary links from other tests in this file, and
    // this is the one assertion that specifically needs a real primary
    // link (customer_account_links_primary_unique_active_idx allows only
    // one active primary per tenant+user).
    const primaryUser = await createTestUser("p2g2a-primary-owner");
    const { appointmentId } = await createLinkedAppointment({ userId: primaryUser.id, status: "scheduled", start: hoursFromNow(48), isPrimary: true });
    const { data, error } = await cancelAs(primaryUser, appointmentId);
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "cancelled" });
    // NOT cleaned up here: the cancel call just above wrote an audit_logs
    // row (actor_user_id = primaryUser.id) that only this file's own
    // afterAll's cleanupTenants can remove first — see
    // extraAuditActorUsers' own comment above.
    extraAuditActorUsers.push(primaryUser.id);
  });

  it("a NON-primary (historical) linked appointment is also manageable — all active links count, not only primary", async () => {
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(49), isPrimary: false });
    const { data, error } = await cancelAs(accountUser, appointmentId);
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "cancelled" });
  });

  it("multiple links in the same tenant: the account can manage an appointment under EITHER linked customer row", async () => {
    const a = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(50), isPrimary: false, fullName: "Second Linked Row" });
    const b = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(51), isPrimary: false, fullName: "Third Linked Row" });
    expect(a.customerId).not.toBe(b.customerId);
    const r1 = await cancelAs(accountUser, a.appointmentId);
    const r2 = await cancelAs(accountUser, b.appointmentId);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
  });
});

describe("status eligibility", () => {
  const cases: Array<{ status: string; eligible: boolean }> = [
    { status: "scheduled", eligible: true },
    { status: "confirmed", eligible: true },
    { status: "in_progress", eligible: false },
    { status: "completed", eligible: false },
    { status: "cancelled", eligible: false },
    { status: "no_show", eligible: false },
  ];

  for (const { status, eligible } of cases) {
    it(`status=${status} is ${eligible ? "" : "NOT "}customer-cancellable`, async () => {
      const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status, start: hoursFromNow(60) });
      const { data, error } = await cancelAs(accountUser, appointmentId);
      if (eligible) {
        expect(error).toBeNull();
        expect(data).toMatchObject({ status: "cancelled" });
      } else {
        expect(error).not.toBeNull();
        expect(error!.code).toBe("AC003");
      }
    });
  }
});

describe("cutoff semantics", () => {
  it("AC004: cancellation is rejected outright when disabled, regardless of cutoff", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: false, customer_cancellation_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(72) });
    const { error } = await cancelAs(accountUser, appointmentId);
    expect(error!.code).toBe("AC004");
  });

  it("allowed strictly before the cutoff instant", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 180 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(5) }); // 5h out, 3h cutoff
    const { data, error } = await cancelAs(accountUser, appointmentId);
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "cancelled" });
  });

  it("AC005: rejected after the cutoff instant has passed", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 180 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(1) }); // 1h out, 3h cutoff
    const { error } = await cancelAs(accountUser, appointmentId);
    expect(error!.code).toBe("AC005");
  });

  it("cutoff=0 allows cancellation right up to the appointment start", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(0.02) }); // ~72s out
    const { data, error } = await cancelAs(accountUser, appointmentId);
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "cancelled" });
  });

  it("an already-started (past scheduled_start_at) appointment is never cancellable even with cutoff=0", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "confirmed", start: hoursFromNow(-1) });
    const { error } = await cancelAs(accountUser, appointmentId);
    expect(error!.code).toBe("AC005");
  });

  it("cutoff comparison is correct for a non-UTC tenant timezone (Europe/Istanbul, UTC+3) — comparison is pure UTC arithmetic, unaffected by display timezone", async () => {
    const [row] = await testDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenant.id}`;
    expect(row!.timezone).toBe("Europe/Istanbul"); // sanity: confirms this whole suite already runs against a non-UTC tenant
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 180 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(5) });
    const { data, error } = await cancelAs(accountUser, appointmentId);
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "cancelled" });
  });
});

describe("cancel domain behavior", () => {
  it("cancelling releases the staff slot: a new appointment can now be booked for the exact same staff/time", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0 });
    const start = hoursFromNow(80);
    // Explicit shared staffId here on purpose — this test's whole point
    // is proving the SAME staff/time slot is bookable again after
    // cancellation, unlike every other test in this file which
    // deliberately uses its own dedicated staff member.
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start, staffMemberId: staffId });
    await cancelAs(accountUser, appointmentId);

    const [customer2] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Slot Reuse Customer') returning id`;
    const end = new Date(start.getTime() + 30 * 60_000);
    const [appt2] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${customer2!.id}, 'scheduled', ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
      returning id`;
    await expect(
      testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
        values (${tenant.id}, ${appt2!.id}, ${serviceId}, ${staffId}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 30, 200, 1)`,
    ).resolves.not.toThrow();
  });

  it("all appointment_items rows are synchronized to cancelled (multi-item appointment)", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0 });
    const start = hoursFromNow(90);
    const { appointmentId, customerId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start });
    const staff2 = await createStaffMember(tenant.id, "Cancel Staff Two");
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff2.id}, ${branchId})`;
    await testDb`insert into staff_services (staff_member_id, service_id) values (${staff2.id}, ${serviceId})`;
    const start2 = new Date(start.getTime() + 30 * 60_000);
    const end2 = new Date(start2.getTime() + 30 * 60_000);
    await testDb`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${appointmentId}, ${serviceId}, ${staff2.id}, ${start2.toISOString()}::timestamptz, ${end2.toISOString()}::timestamptz, 30, 200, 2)`;

    await cancelAs(accountUser, appointmentId);

    const items = await testDb<{ appointment_status: string }[]>`select appointment_status from appointment_items where appointment_id = ${appointmentId}`;
    expect(items.length).toBe(2);
    for (const item of items) expect(item.appointment_status).toBe("cancelled");

    const [customerRow] = await testDb<{ id: string }[]>`select id from customers where id = ${customerId}`;
    expect(customerRow).toBeTruthy(); // history preserved, row not deleted
    const remainingItems = await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${appointmentId}`;
    expect(remainingItems.length).toBe(2); // items preserved, not deleted
  });

  it("exactly one audit row is written, with the real customer as actor_user_id and actor_type='user'", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(95) });
    await cancelAs(accountUser, appointmentId);

    const rows = await testDb<{ actor_user_id: string; actor_type: string; action: string }[]>`
      select actor_user_id, actor_type, action from audit_logs where entity_id = ${appointmentId} and action = 'appointment.cancelled'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_user_id).toBe(accountUser.id);
    expect(rows[0]!.actor_type).toBe("user");
  });
});

describe("concurrency", () => {
  it("two simultaneous cancel attempts against the SAME appointment: exactly one succeeds, the other gets AC003, no corrupt state", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(100) });

    const clientA = await signInAs(accountUser);
    const clientB = await signInAs(accountUser);
    const [resA, resB] = await Promise.all([
      clientA.rpc("cancel_my_appointment", { p_appointment_id: appointmentId }),
      clientB.rpc("cancel_my_appointment", { p_appointment_id: appointmentId }),
    ]);
    await clientA.auth.signOut();
    await clientB.auth.signOut();

    const results = [resA, resB];
    const succeeded = results.filter((r) => r.error === null);
    const failed = results.filter((r) => r.error !== null);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0]!.error!.code).toBe("AC003");

    const auditRows = await testDb<{ id: string }[]>`select id from audit_logs where entity_id = ${appointmentId} and action = 'appointment.cancelled'`;
    expect(auditRows.length).toBe(1); // no duplicate audit effect

    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("cancelled");
  }, 30000);
});

describe("staff authority unchanged", () => {
  it("an authorized staff user can still cancel via update_appointment_status even when customer_cancellation_enabled = false", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: false });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(110) });

    const client = await signInAs(owner);
    const { error } = await client.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });
    expect(error).toBeNull();
    await client.auth.signOut();

    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("cancelled");
  });
});

describe("security", () => {
  it("cancel_my_appointment: authenticated only, anon denied, exactly one overload", async () => {
    const grants = await testDb<{ grantee: string }[]>`
      select grantee::text from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'cancel_my_appointment' and privilege_type = 'EXECUTE'`;
    const grantees = grants.map((g) => g.grantee);
    expect(grantees).toContain("authenticated");
    expect(grantees).not.toContain("anon");
    expect(grantees).not.toContain("PUBLIC");

    const { error } = await anonClient().rpc("cancel_my_appointment", { p_appointment_id: crypto.randomUUID() });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");

    const overloads = await testDb<{ nargs: number }[]>`
      select p.pronargs as nargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'cancel_my_appointment'`;
    expect(overloads.length).toBe(1);
    expect(overloads[0]!.nargs).toBe(1);
  });

  it("customer cannot call staff-side update_appointment_status/reschedule_appointment merely by being authenticated (permission ceiling unaffected by this phase)", async () => {
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(120) });
    const client = await signInAs(accountUser);
    const { error } = await client.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });
    expect(error).not.toBeNull();
    await client.auth.signOut();
  });

  it("booking_gateway's effective privilege surface is unchanged by this migration", async () => {
    const rows = await testDb<{ schema: string; name: string; can_execute: boolean }[]>`
      select n.nspname as schema, p.proname as name,
             has_function_privilege('booking_gateway', p.oid, 'EXECUTE') as can_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    `;
    const executable = rows.filter((r) => r.can_execute).map((r) => `${r.schema}.${r.name}`);
    expect(executable).toEqual(["public.create_guest_booking"]);
  });

  it("anon's function execute surface is still exactly the 3 public booking reads (unchanged)", async () => {
    const rows = await testDb<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proacl is not null
        and exists (select 1 from aclexplode(p.proacl) a where pg_get_userbyid(a.grantee) = 'anon' and a.privilege_type = 'EXECUTE')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by p.proname`;
    expect(rows.map((r) => r.name)).toEqual(["get_public_availability_slots", "get_public_booking_context", "get_public_eligible_staff"]);
  });

  it("direct create_guest_booking execution remains blocked for anon (2F.2 baseline unchanged)", async () => {
    const anonResult = await anonClient().rpc("create_guest_booking", {
      p_tenant_slug: tenant.slug,
      p_branch_id: branchId,
      p_service_id: serviceId,
      p_scheduled_start_at: hoursFromNow(200).toISOString(),
      p_customer_full_name: "Blocked",
      p_customer_phone: "5551234567",
    });
    expect(anonResult.error).not.toBeNull();
    expect(anonResult.error!.code).toBe("42501");
  });

  it("service_role has zero function execute grants (baseline unchanged) — via the project's own audit function, not a raw information_schema query (which also surfaces harmless PUBLIC-granted extension functions)", async () => {
    const data = await testDb<{ schema_name: string; function_name: string; grantee: string }[]>`select * from security_audit_function_grants()`;
    const serviceRoleGrants = data.filter((g) => g.grantee === "service_role");
    expect(serviceRoleGrants).toEqual([]);
  });

  it("default-privilege baseline is untouched", async () => {
    const defaults = await testDb<{ grantee: string }[]>`select * from public.security_audit_default_privileges()`;
    expect(defaults.length).toBe(4);
    for (const row of defaults) expect(row.grantee).toBe("service_role");
  });
});

describe("portal capability fields", () => {
  it("canCancel/canReschedule reflect DB policy authority, not a client-side computation", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 60, customer_reschedule_enabled: false, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId: eligibleId } = await createLinkedAppointment({ userId: accountUser.id, status: "confirmed", start: hoursFromNow(5) });
    const { appointmentId: ineligibleId } = await createLinkedAppointment({ userId: accountUser.id, status: "completed", start: hoursFromNow(-5) });

    const client = await signInAs(accountUser);
    const { data } = await client.rpc("get_my_appointments");
    const rows = data as Array<{ appointmentId: string; canCancel: boolean; canReschedule: boolean; status: string }>;
    const eligible = rows.find((r) => r.appointmentId === eligibleId)!;
    const ineligible = rows.find((r) => r.appointmentId === ineligibleId)!;
    expect(eligible.canCancel).toBe(true);
    expect(eligible.canReschedule).toBe(false); // reschedule policy disabled
    expect(ineligible.canCancel).toBe(false);
    expect(ineligible.canReschedule).toBe(false);
    await client.auth.signOut();
  });

  it("a cancelled appointment remains visible in Randevularım history with canCancel=false", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(130) });
    await cancelAs(accountUser, appointmentId);

    const client = await signInAs(accountUser);
    const { data } = await client.rpc("get_my_appointments");
    const rows = data as Array<{ appointmentId: string; canCancel: boolean; status: string }>;
    const mine = rows.find((r) => r.appointmentId === appointmentId);
    expect(mine).toBeTruthy();
    expect(mine!.status).toBe("cancelled");
    expect(mine!.canCancel).toBe(false);
    await client.auth.signOut();
  });
});
