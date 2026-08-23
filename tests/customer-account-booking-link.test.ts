import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createTestTenant,
  createTestUser,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  type TestUser,
} from "./helpers";

/**
 * Faz 2G.1 (20260822190000) — the "Option A" future-booking link inside
 * create_guest_booking's own transaction: p_customer_account_user_id is
 * always server-derived (see lib/modules/public-booking/actions.ts), so
 * this file drives the function directly via testDb with an explicit
 * value, the same way public-booking-flow.test.ts already drives the
 * guest path — auth.uid() plays no role in create_guest_booking itself,
 * only in the 3 portal-read RPCs covered by
 * tests/customer-account-portal.test.ts.
 */

let accountUser: TestUser;
let otherUser: TestUser;
let owner: TestUser;
let tenant: { id: string; slug: string };
let branchId: string;
let serviceId: string;
let staffId: string;

function futureIso(daysFromNow: number, hour: number): string {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

async function bookDirect(params: {
  scheduledStartAtUtc: string;
  idempotencyKey: string;
  customerAccountUserId?: string | null;
  fullName?: string;
  phone?: string;
}) {
  return testDb<{ create_guest_booking: Record<string, unknown> }[]>`
    select public.create_guest_booking(
      ${tenant.slug},
      ${branchId}::uuid,
      ${serviceId}::uuid,
      ${params.scheduledStartAtUtc}::timestamptz,
      ${params.fullName ?? "Link Test Customer"},
      ${params.phone ?? "5551239900"},
      ${staffId}::uuid,
      null,
      ${params.idempotencyKey}::uuid,
      ${params.customerAccountUserId ?? null}::uuid
    )
  `;
}

beforeAll(async () => {
  owner = await createTestUser("p2g1-link-owner");
  accountUser = await createTestUser("p2g1-link-acct");
  otherUser = await createTestUser("p2g1-link-other");
  const tenantRow = await createTestTenant("test-p2g1-link", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug };
  const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenant.id}, ${feature!.id}, true)`;

  branchId = await createBranch(tenant.id, "Link Branch");
  const service = await createService(tenant.id, "Link Service", 30, 200);
  serviceId = service.id;
  const staff = await createStaffMember(tenant.id, "Link Staff");
  staffId = staff.id;
  await linkServiceBranch(serviceId, branchId);
  await linkStaffBranch(staffId, branchId);
  await linkStaffService(staffId, serviceId);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenant.id, staffId, weekday, "00:00", "23:59");
  }
}, 60000);

afterAll(async () => {
  await testDb`delete from customer_account_links where tenant_id = ${tenant.id}`;
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id, accountUser.id, otherUser.id]);
});

describe("no stale overload after the signature change", () => {
  it("private.create_guest_booking and private.canonical_booking_fingerprint each resolve to exactly one function", async () => {
    const rows = await testDb<{ proname: string; nargs: number }[]>`
      select p.proname, p.pronargs as nargs
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ('create_guest_booking', 'canonical_booking_fingerprint')`;
    const byName = new Map(rows.map((r) => [r.proname, r.nargs]));
    expect(byName.get("create_guest_booking")).toBe(10);
    expect(byName.get("canonical_booking_fingerprint")).toBe(9);
  });
});

describe("guest path is unchanged when no account identity is present", () => {
  it("a plain guest booking (customerAccountUserId omitted) still succeeds and creates no link", async () => {
    const key = crypto.randomUUID();
    const [result] = await bookDirect({ scheduledStartAtUtc: futureIso(30, 9), idempotencyKey: key, fullName: "Plain Guest", phone: "5550001111" });
    expect(result!.create_guest_booking).toBeTruthy();
    const links = await testDb<{ id: string }[]>`select id from customer_account_links where tenant_id = ${tenant.id}
      and customer_id in (select id from customers where tenant_id = ${tenant.id} and full_name = 'Plain Guest')`;
    expect(links.length).toBe(0);
  });
});

describe("first authenticated booking creates a primary link", () => {
  it("creates a new customer row and a primary future_booking link", async () => {
    const key = crypto.randomUUID();
    const [result] = await bookDirect({ scheduledStartAtUtc: futureIso(31, 9), idempotencyKey: key, customerAccountUserId: accountUser.id });
    expect(result!.create_guest_booking).toBeTruthy();

    const links = await testDb<{ customer_id: string; is_primary: boolean; claimed_via: string }[]>`
      select customer_id, is_primary, claimed_via from customer_account_links
      where tenant_id = ${tenant.id} and user_id = ${accountUser.id} and deleted_at is null`;
    expect(links.length).toBe(1);
    expect(links[0]!.is_primary).toBe(true);
    expect(links[0]!.claimed_via).toBe("future_booking");
  });

  it("a second authenticated booking reuses the SAME customer_id via the primary link, and never rewrites that CRM row from new contact fields", async () => {
    const [before] = await testDb<{ customer_id: string }[]>`
      select customer_id from customer_account_links where tenant_id = ${tenant.id} and user_id = ${accountUser.id} and deleted_at is null`;

    const key = crypto.randomUUID();
    await bookDirect({
      scheduledStartAtUtc: futureIso(32, 9),
      idempotencyKey: key,
      customerAccountUserId: accountUser.id,
      fullName: "Totally Different Name",
      phone: "5559990000",
    });

    const [after] = await testDb<{ customer_id: string }[]>`
      select customer_id from customer_account_links where tenant_id = ${tenant.id} and user_id = ${accountUser.id} and deleted_at is null`;
    expect(after!.customer_id).toBe(before!.customer_id);

    const [customerRow] = await testDb<{ full_name: string }[]>`select full_name from customers where id = ${before!.customer_id}`;
    expect(customerRow!.full_name).not.toBe("Totally Different Name");

    const stillOneLink = await testDb<{ id: string }[]>`
      select id from customer_account_links where tenant_id = ${tenant.id} and user_id = ${accountUser.id} and deleted_at is null`;
    expect(stillOneLink.length).toBe(1);
  });

  it("the SAME idempotency key with a DIFFERENT account identity (guest vs authenticated) is a fingerprint mismatch (BK007), never silently reused across ownership boundaries", async () => {
    const key = crypto.randomUUID();
    const slot = futureIso(33, 9);
    await bookDirect({ scheduledStartAtUtc: slot, idempotencyKey: key, customerAccountUserId: null, fullName: "Fingerprint Guest", phone: "5551110000" });
    await expect(
      bookDirect({ scheduledStartAtUtc: slot, idempotencyKey: key, customerAccountUserId: accountUser.id, fullName: "Fingerprint Guest", phone: "5551110000" }),
    ).rejects.toMatchObject({ code: "BK007" });
  });

  it("no account identity is ever present in the public confirmation payload", async () => {
    const key = crypto.randomUUID();
    const [result] = await bookDirect({ scheduledStartAtUtc: futureIso(34, 9), idempotencyKey: key, customerAccountUserId: accountUser.id });
    expect(JSON.stringify(result!.create_guest_booking)).not.toContain(accountUser.id);
  });
});

describe("hijack protection", () => {
  it("never attaches a customer row already actively linked to a DIFFERENT account — creates a fresh row instead, original ownership untouched", async () => {
    const hijacker = await createTestUser("p2g1-link-hijacker");
    const [hijackTarget] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, status)
      values (${tenant.id}, 'Hijack Target', '5552223300', 'active')
      returning id`;
    await testDb`
      insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
      values (${otherUser.id}, ${tenant.id}, ${hijackTarget!.id}, 'future_booking', true)`;

    const key = crypto.randomUUID();
    await bookDirect({
      scheduledStartAtUtc: futureIso(35, 9),
      idempotencyKey: key,
      customerAccountUserId: hijacker.id,
      fullName: "Hijack Target",
      phone: "5552223300",
    });

    const attachedToHijackTarget = await testDb<{ user_id: string }[]>`
      select user_id from customer_account_links where customer_id = ${hijackTarget!.id} and deleted_at is null`;
    expect(attachedToHijackTarget.length).toBe(1);
    expect(attachedToHijackTarget[0]!.user_id).toBe(otherUser.id);

    const hijackerLink = await testDb<{ customer_id: string }[]>`
      select customer_id from customer_account_links where tenant_id = ${tenant.id} and user_id = ${hijacker.id} and deleted_at is null`;
    expect(hijackerLink.length).toBe(1);
    expect(hijackerLink[0]!.customer_id).not.toBe(hijackTarget!.id);

    await cleanupUsers([hijacker.id]);
  });
});

describe("primary-link concurrency", () => {
  it("two simultaneous first-time authenticated bookings for the same user+tenant produce exactly one primary link, not two, and no unhandled error", async () => {
    const concurrentUser = await createTestUser("p2g1-link-concurrent");
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();

    const [resA, resB] = await Promise.all([
      bookDirect({ scheduledStartAtUtc: futureIso(36, 9), idempotencyKey: keyA, customerAccountUserId: concurrentUser.id, fullName: "Concurrent Person", phone: "5557778800" }),
      bookDirect({ scheduledStartAtUtc: futureIso(36, 14), idempotencyKey: keyB, customerAccountUserId: concurrentUser.id, fullName: "Concurrent Person", phone: "5557778800" }),
    ]);
    expect(resA[0]!.create_guest_booking).toBeTruthy();
    expect(resB[0]!.create_guest_booking).toBeTruthy();

    const links = await testDb<{ id: string; customer_id: string; is_primary: boolean }[]>`
      select id, customer_id, is_primary from customer_account_links
      where tenant_id = ${tenant.id} and user_id = ${concurrentUser.id} and deleted_at is null`;
    expect(links.length).toBe(1);
    expect(links[0]!.is_primary).toBe(true);

    // Both concurrent bookings must have landed on the SAME customer_id —
    // the whole point of serializing the decision inside the transaction.
    const appts = await testDb<{ customer_id: string }[]>`
      select customer_id from appointments where tenant_id = ${tenant.id} and idempotency_key in (${keyA}, ${keyB})`;
    expect(appts.length).toBe(2);
    expect(appts[0]!.customer_id).toBe(appts[1]!.customer_id);
    expect(appts[0]!.customer_id).toBe(links[0]!.customer_id);

    await cleanupUsers([concurrentUser.id]);
  }, 30000);
});
