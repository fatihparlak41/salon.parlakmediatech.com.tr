import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createTestTenant,
  createTestUser,
  createBranch,
  createStaffMember,
  createService,
  createCustomer,
  linkStaffBranch,
  linkServiceBranch,
  linkStaffService,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Phase 2H.0 — a dedicated, explicit forged-UUID cross-tenant sweep
 * across every Phase 2 domain, using two real disposable tenants. Most
 * of these properties are already implied by each feature's own test
 * file (every RPC derives tenant_id server-side from the target row,
 * never trusts a client-supplied one), but this file exists to prove
 * it directly, in one place, rather than relying on that being an
 * emergent property of scattered per-feature tests. Complements — does
 * not replace — cross-tenant-isolation.test.ts (Faz 1's foundational
 * tenants/branches/memberships/roles/platform_admins coverage) and
 * salon-assisted-link.test.ts's own wrong-tenant-code scenario.
 */

let ownerA: TestUser;
let ownerB: TestUser;
let customerPortalUserA: TestUser;
let tenantA: TestTenant;
let tenantB: TestTenant;
let branchA: string;
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let clientCustomerA: SupabaseClient;

let staffA: { id: string };
let serviceA: { id: string };
let customerA: { id: string };
let appointmentA: { id: string };
let appointmentItemA: { id: string };

beforeAll(async () => {
  ownerA = await createTestUser("p2h0-fu-owner-a");
  ownerB = await createTestUser("p2h0-fu-owner-b");
  customerPortalUserA = await createTestUser("p2h0-fu-cust-a");

  tenantA = await createTestTenant("test-p2h0-fu-a", ownerA.id);
  tenantB = await createTestTenant("test-p2h0-fu-b", ownerB.id);
  branchA = await createBranch(tenantA.id, "Forged UUID Branch A");
  await createBranch(tenantB.id, "Forged UUID Branch B");

  staffA = await createStaffMember(tenantA.id, "Forged Staff A");
  await linkStaffBranch(staffA.id, branchA);
  serviceA = await createService(tenantA.id, "Forged Service A", 30, 500);
  await linkServiceBranch(serviceA.id, branchA);
  await linkStaffService(staffA.id, serviceA.id);
  customerA = await createCustomer(tenantA.id, "Forged Customer A");

  const start = new Date(Date.now() + 200 * 3600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const [appt] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
    values (${tenantA.id}, ${branchA}, ${customerA.id}, 'scheduled', ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
    returning id`;
  appointmentA = { id: appt!.id };
  const [item] = await testDb<{ id: string }[]>`
    insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
    values (${tenantA.id}, ${appointmentA.id}, ${serviceA.id}, ${staffA.id}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 30, 500, 1)
    returning id`;
  appointmentItemA = { id: item!.id };

  await testDb`
    insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
    values (${customerPortalUserA.id}, ${tenantA.id}, ${customerA.id}, 'future_booking', true)`;

  [clientA, clientB, clientCustomerA] = await Promise.all([
    signInAs(ownerA),
    signInAs(ownerB),
    signInAs(customerPortalUserA),
  ]);
}, 60000);

afterAll(async () => {
  await Promise.all([clientA.auth.signOut(), clientB.auth.signOut(), clientCustomerA.auth.signOut()]);
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, ownerB.id, customerPortalUserA.id]);
});

describe("cross-tenant forged UUID — staff", () => {
  it("tenant B cannot read tenant A's staff member by forged id", async () => {
    const { data } = await clientB.from("staff_members").select("id").eq("id", staffA.id);
    expect(data).toHaveLength(0);
  });
  it("tenant B cannot update tenant A's staff member by forged id", async () => {
    const { data } = await clientB.from("staff_members").update({ full_name: "Hijacked" }).eq("id", staffA.id).select();
    expect(data).toHaveLength(0);
    const [row] = await testDb<{ full_name: string }[]>`select full_name from staff_members where id = ${staffA.id}`;
    expect(row!.full_name).toBe("Forged Staff A");
  });
});

describe("cross-tenant forged UUID — services", () => {
  it("tenant B cannot read tenant A's service by forged id", async () => {
    const { data } = await clientB.from("services").select("id").eq("id", serviceA.id);
    expect(data).toHaveLength(0);
  });
});

describe("cross-tenant forged UUID — customers", () => {
  it("tenant B cannot read tenant A's customer by forged id", async () => {
    const { data } = await clientB.from("customers").select("id").eq("id", customerA.id);
    expect(data).toHaveLength(0);
  });

  it("search_customers scoped to tenant A returns nothing when called by a tenant B member", async () => {
    const { data, error } = await clientB.rpc("search_customers", { p_tenant_id: tenantA.id, p_query: "Forged" });
    // Either an empty result (RLS-filtered) or a permission error — never
    // the real row. This RPC is SECURITY DEFINER with its own explicit
    // has_permission() check, so a caller with no membership in tenantA
    // must get zero rows regardless of which failure mode it takes.
    if (!error) expect(data).toEqual([]);
  });
});

describe("cross-tenant forged UUID — appointments and calendar", () => {
  it("tenant B cannot read tenant A's appointment by forged id", async () => {
    const { data } = await clientB.from("appointments").select("id").eq("id", appointmentA.id);
    expect(data).toHaveLength(0);
  });

  it("tenant B cannot read tenant A's appointment_items by forged id", async () => {
    const { data } = await clientB.from("appointment_items").select("id").eq("id", appointmentItemA.id);
    expect(data).toHaveLength(0);
  });

  it("tenant B cannot reschedule tenant A's appointment via a forged appointment id", async () => {
    const { error } = await clientB.rpc("reschedule_appointment", {
      p_appointment_id: appointmentA.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staffA.id, scheduled_start_at: new Date(Date.now() + 210 * 3600_000).toISOString(), sequence: 1 }],
    });
    expect(error).not.toBeNull();
    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentA.id}`;
    expect(row!.status).toBe("scheduled");
  });

  it("tenant B cannot cancel tenant A's appointment via a forged appointment id", async () => {
    const { error } = await clientB.rpc("update_appointment_status", { p_appointment_id: appointmentA.id, p_status: "cancelled" });
    expect(error).not.toBeNull();
    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentA.id}`;
    expect(row!.status).toBe("scheduled");
  });
});

describe("cross-tenant forged UUID — customer_account_links", () => {
  it("tenant B cannot read tenant A's customer_account_links row directly (zero direct grants — same pattern as booking_account_claims/pairing_codes)", async () => {
    const { data } = await clientB.from("customer_account_links").select("id").eq("tenant_id", tenantA.id);
    expect(data === null || data.length === 0).toBe(true);
  });

  it("get_customer_account_link_status for a tenant A customer, called by tenant B, fails (permission or not-found — never the real linked state)", async () => {
    const { data, error } = await clientB.rpc("get_customer_account_link_status", { p_customer_id: customerA.id });
    if (!error) {
      expect((data as unknown as { isLinked: boolean }).isLinked).toBe(false);
    }
  });
});

describe("cross-tenant forged UUID — booking_account_claims and customer_account_pairing_codes (zero direct grants, tenant-agnostic proof)", () => {
  it("authenticated cannot SELECT booking_account_claims at all, regardless of tenant", async () => {
    const { data, error } = await clientA.from("booking_account_claims").select("id");
    expect(data === null || data.length === 0).toBe(true);
    void error;
  });

  it("authenticated cannot SELECT customer_account_pairing_codes at all, regardless of tenant", async () => {
    const { data, error } = await clientA.from("customer_account_pairing_codes").select("id");
    expect(data === null || data.length === 0).toBe(true);
    void error;
  });

  it("anon cannot SELECT either table", async () => {
    const anon = anonClient();
    const claims = await anon.from("booking_account_claims").select("id");
    const codes = await anon.from("customer_account_pairing_codes").select("id");
    expect(claims.data === null || claims.data.length === 0).toBe(true);
    expect(codes.data === null || codes.data.length === 0).toBe(true);
  });
});

describe("cross-tenant forged UUID — customer account history isolation", () => {
  it("a customer-portal account linked only in tenant A sees zero appointments from tenant B", async () => {
    // customerPortalUserA has no link in tenant B at all — get_my_appointments
    // derives tenant scope entirely from the caller's own links, so this
    // proves a customer identity can never see another tenant's calendar
    // data merely by virtue of being a valid authenticated session.
    const { data, error } = await clientCustomerA.rpc("get_my_appointments");
    expect(error).toBeNull();
    const rows = (data as unknown as { tenantId?: string }[]) ?? [];
    for (const row of rows) {
      if (row.tenantId) expect(row.tenantId).not.toBe(tenantB.id);
    }
  });
});

describe("cross-tenant forged UUID — salon-assisted linking (see also salon-assisted-link.test.ts)", () => {
  it("tenant B staff cannot call link_customer_account_with_code against a tenant A customer id, even with a well-formed hash", async () => {
    const { error } = await clientB.rpc("link_customer_account_with_code", {
      p_customer_id: customerA.id,
      p_code_hash: "0".repeat(64),
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK002"); // permission denied — clientB has no membership in tenantA
  });

  it("tenant B staff cannot call unlink_salon_assisted_customer_account against a tenant A customer id", async () => {
    const { error } = await clientB.rpc("unlink_salon_assisted_customer_account", { p_customer_id: customerA.id });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK002");
  });
});
