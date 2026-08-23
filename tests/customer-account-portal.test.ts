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
 * Faz 2G.1 (20260822190000) — the 3-function customer-portal RPC
 * surface: get_my_account_profile, update_my_account_profile,
 * get_my_appointments. All three derive identity exclusively from
 * auth.uid() — none accepts an id parameter — so every test here drives
 * them through a REAL authenticated session (signInAs), not testDb
 * directly: a raw Postgres connection has no JWT, so auth.uid() would
 * read null and every one of these assertions would be meaningless.
 */

let portalUser: TestUser;
let strangerUser: TestUser;
let owner: TestUser;
let tenant: { id: string; slug: string };
let customerId: string;
let appointmentId: string;

function futureIso(daysFromNow: number, hour: number): string {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

beforeAll(async () => {
  portalUser = await createTestUser("p2g1-portal-user");
  strangerUser = await createTestUser("p2g1-portal-stranger");
  owner = await createTestUser("p2g1-portal-owner");
  const tenantRow = await createTestTenant("test-p2g1-portal", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug };

  const branchId = await createBranch(tenant.id, "Portal Branch");
  const service = await createService(tenant.id, "Portal Service", 45, 350);
  const staff = await createStaffMember(tenant.id, "Portal Staff");

  const [customer] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name, notes) values (${tenant.id}, 'Portal Customer', 'private internal note') returning id`;
  customerId = customer!.id;

  await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
    values (${portalUser.id}, ${tenant.id}, ${customerId}, 'future_booking', true)`;

  const start = futureIso(15, 10);
  const end = futureIso(15, 11);
  const [appt] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at)
    values (${tenant.id}, ${branchId}, ${customerId}, 'confirmed', 'public_booking', ${start}::timestamptz, ${end}::timestamptz)
    returning id`;
  appointmentId = appt!.id;
  await testDb`
    insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
    values (${tenant.id}, ${appointmentId}, ${service.id}, ${staff.id}, ${start}::timestamptz, ${end}::timestamptz, 45, 350, 1)`;
}, 60000);

afterAll(async () => {
  await testDb`delete from customer_account_links where tenant_id = ${tenant.id}`;
  await cleanupTenants([tenant.id]);
  await cleanupUsers([portalUser.id, strangerUser.id, owner.id]);
});

describe("get_my_account_profile / update_my_account_profile", () => {
  it("AC001: an unauthenticated (anon) caller cannot execute it at all — permission denied at the grant, before AC001 would even run", async () => {
    const { error } = await anonClient().rpc("get_my_account_profile");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });

  it("returns the caller's own email (from auth.users) and profile fields", async () => {
    const client = await signInAs(portalUser);
    const { data, error } = await client.rpc("get_my_account_profile");
    expect(error).toBeNull();
    expect((data as unknown as { email: string }).email).toBe(portalUser.email);
    await client.auth.signOut();
  });

  it("update_my_account_profile persists full_name/phone and never touches any tenant's customers row", async () => {
    const client = await signInAs(portalUser);
    const { data, error } = await client.rpc("update_my_account_profile", {
      p_full_name: "Portal Display Name",
      p_phone: "5551234567",
    });
    expect(error).toBeNull();
    expect((data as unknown as { fullName: string; phone: string }).fullName).toBe("Portal Display Name");
    expect((data as unknown as { fullName: string; phone: string }).phone).toBe("5551234567");

    const [profileRow] = await testDb<{ full_name: string }[]>`select full_name from profiles where id = ${portalUser.id}`;
    expect(profileRow!.full_name).toBe("Portal Display Name");

    // The tenant's own CRM copy of this person must be completely
    // unaffected — global account profile and tenant CRM profile are
    // deliberately independent records (2G.1 section 9).
    const [customerRow] = await testDb<{ full_name: string }[]>`select full_name from customers where id = ${customerId}`;
    expect(customerRow!.full_name).toBe("Portal Customer");
    await client.auth.signOut();
  });

  it("rejects a blank full name (AC002)", async () => {
    const client = await signInAs(portalUser);
    const { error } = await client.rpc("update_my_account_profile", { p_full_name: "   " });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC002");
    await client.auth.signOut();
  });
});

describe("get_my_appointments", () => {
  it("an unauthenticated (anon) caller cannot execute it at all", async () => {
    const { error } = await anonClient().rpc("get_my_appointments");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });

  it("returns the linked appointment with exactly the safe field shape, no more, no less", async () => {
    const client = await signInAs(portalUser);
    const { data, error } = await client.rpc("get_my_appointments");
    expect(error).toBeNull();
    const rows = data as Array<Record<string, unknown>>;
    const mine = rows.find((r) => r.appointmentId === appointmentId);
    expect(mine).toBeTruthy();
    expect(Object.keys(mine!).sort()).toEqual(
      ["appointmentId", "branchName", "scheduledEndAt", "scheduledStartAt", "services", "status", "tenantName", "tenantSlug", "tenantTimezone"].sort(),
    );
    expect(mine!.status).toBe("confirmed");
    expect(mine!.tenantSlug).toBe(tenant.slug);
    const services = mine!.services as Array<Record<string, unknown>>;
    expect(services.length).toBe(1);
    expect(services[0]).toEqual({
      serviceName: "Portal Service",
      staffName: "Portal Staff",
      durationMinutes: 45,
      price: 350,
    });
    await client.auth.signOut();
  });

  it("never includes CRM notes, internal ids, or any other private field, anywhere in the payload", async () => {
    const client = await signInAs(portalUser);
    const { data } = await client.rpc("get_my_appointments");
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/private internal note/);
    expect(serialized).not.toMatch(/customer_id|created_by|notes|phone_normalized|email_normalized/i);
    await client.auth.signOut();
  });

  it("a stranger with zero links sees an empty list, never another account's appointments", async () => {
    const client = await signInAs(strangerUser);
    const { data, error } = await client.rpc("get_my_appointments");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    await client.auth.signOut();
  });

  it("a salon owner with a tenant membership but no customer link also sees an empty list — membership grants no portal visibility", async () => {
    const client = await signInAs(owner);
    const { data, error } = await client.rpc("get_my_appointments");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    await client.auth.signOut();
  });
});
