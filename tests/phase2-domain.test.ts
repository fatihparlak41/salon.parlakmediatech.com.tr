import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupTenants,
  cleanupUsers,
  createCustomer,
  createRoleForTenant,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Phase 2A: staff_members, services, staff_services, customers,
 * staff_schedules/exceptions. All are direct RLS-gated tables (no RPC) —
 * these tests are the actual proof that "member reads, permission
 * writes" holds and that tenant isolation/cross-tenant linking is
 * enforced in Postgres, not just believed. Every assertion that matters
 * goes through a real signed-in user's client; testDb (admin/postgres)
 * is fixture setup only, same rule as every other test file.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let ownerB: TestUser;
let limitedA: TestUser; // staff.view/services.view/schedules.view/customers.view only — no manage/create/update
let ownerAClient: SupabaseClient;
let limitedAClient: SupabaseClient;
let ownerBClient: SupabaseClient;

let branchA: string;
let branchB: string;
let staffA: { id: string; fullName: string };
let staffB: { id: string; fullName: string };
let serviceA: { id: string; name: string; durationMinutes: number; price: number };
let serviceB: { id: string; name: string; durationMinutes: number; price: number };
let customerB: { id: string; fullName: string };

beforeAll(async () => {
  ownerA = await createTestUser("p2dom-owner-a");
  ownerB = await createTestUser("p2dom-owner-b");
  limitedA = await createTestUser("p2dom-limited-a");

  tenantA = await createTestTenant("test-p2dom-a", ownerA.id);
  tenantB = await createTestTenant("test-p2dom-b", ownerB.id);

  const limitedRoleA = await createRoleForTenant(tenantA.id, "Salt Okunur", [
    "staff.view",
    "services.view",
    "schedules.view",
    "customers.view",
  ]);
  await testDb`
    insert into tenant_memberships (tenant_id, user_id, role_id, status)
    values (${tenantA.id}, ${limitedA.id}, ${limitedRoleA}, 'active')
  `;

  const [branchARow] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantA.id}, 'Ana Şube A') returning id
  `;
  branchA = branchARow!.id;
  const [branchBRow] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantB.id}, 'Ana Şube B') returning id
  `;
  branchB = branchBRow!.id;

  staffA = await createStaffMember(tenantA.id, "Staff A");
  staffB = await createStaffMember(tenantB.id, "Staff B");
  serviceA = await createService(tenantA.id, "Saç Kesimi A", 30, 150);
  serviceB = await createService(tenantB.id, "Saç Kesimi B", 30, 150);
  customerB = await createCustomer(tenantB.id, "Customer B");

  ownerAClient = await signInAs(ownerA);
  limitedAClient = await signInAs(limitedA);
  ownerBClient = await signInAs(ownerB);
}, 45000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, ownerB.id, limitedA.id]);
}, 45000);

describe("staff_members", () => {
  it("tenant A cannot see tenant B's staff", async () => {
    const { data } = await ownerAClient.from("staff_members").select("id").eq("id", staffB.id);
    expect(data ?? []).toHaveLength(0);
  });

  it("a member with only staff.view can read staff but not create", async () => {
    const { data: readData, error: readError } = await limitedAClient
      .from("staff_members")
      .select("id")
      .eq("id", staffA.id);
    expect(readError).toBeNull();
    expect(readData).toHaveLength(1);

    const { error: writeError } = await limitedAClient
      .from("staff_members")
      .insert({ tenant_id: tenantA.id, full_name: "Sızma Personel" });
    expect(writeError).not.toBeNull();
  });

  it("staff.manage holder can create and update staff", async () => {
    const { data, error } = await ownerAClient
      .from("staff_members")
      .insert({ tenant_id: tenantA.id, full_name: "Yeni Personel" })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();

    const { error: updateError } = await ownerAClient
      .from("staff_members")
      .update({ status: "inactive" })
      .eq("id", data!.id);
    expect(updateError).toBeNull();

    await testDb`delete from staff_members where id = ${data!.id}`;
  });

  it("a forged tenant_id insert is rejected", async () => {
    const { error } = await limitedAClient
      .from("staff_members")
      .insert({ tenant_id: tenantB.id, full_name: "Forged" });
    expect(error).not.toBeNull();
  });

  it("a staff member can exist with no tenant_membership_id (no login)", async () => {
    const [row] = await testDb<{ id: string; tenant_membership_id: string | null }[]>`
      select id, tenant_membership_id from staff_members where id = ${staffA.id}
    `;
    expect(row?.tenant_membership_id).toBeNull();
  });

  it("linking a staff record to a tenant_membership from a DIFFERENT tenant is rejected at the database level", async () => {
    const [ownerBMembership] = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantB.id} and user_id = ${ownerB.id}
    `;
    await expect(
      testDb`
        update staff_members set tenant_membership_id = ${ownerBMembership!.id} where id = ${staffA.id}
      `,
    ).rejects.toThrow();
  });
});

describe("services", () => {
  it("tenant A cannot see tenant B's services", async () => {
    const { data } = await ownerAClient.from("services").select("id").eq("id", serviceB.id);
    expect(data ?? []).toHaveLength(0);
  });

  it("services.view without services.manage can read but not write", async () => {
    const { data: readData } = await limitedAClient.from("services").select("id").eq("id", serviceA.id);
    expect(readData).toHaveLength(1);

    const { error: writeError } = await limitedAClient
      .from("services")
      .insert({ tenant_id: tenantA.id, name: "Sızma Hizmet", duration_minutes: 10, price: 1 });
    expect(writeError).not.toBeNull();
  });

  it("an inactive service remains readable (status is a business flag, not an RLS gate)", async () => {
    const { data, error } = await ownerAClient
      .from("services")
      .insert({ tenant_id: tenantA.id, name: "Pasif Hizmet", duration_minutes: 15, price: 50, status: "inactive" })
      .select("id, status")
      .single();
    expect(error).toBeNull();
    expect(data?.status).toBe("inactive");

    const { data: readBack } = await limitedAClient.from("services").select("status").eq("id", data!.id);
    expect(readBack).toHaveLength(1);

    await testDb`delete from services where id = ${data!.id}`;
  });
});

describe("staff_services eligibility", () => {
  it("linking staff and a service from different tenants is rejected", async () => {
    const { error } = await ownerAClient
      .from("staff_services")
      .insert({ staff_member_id: staffA.id, service_id: serviceB.id });
    expect(error).not.toBeNull();
  });

  it("staff.manage holder can grant and revoke eligibility within one tenant", async () => {
    const { error: insertError } = await ownerAClient
      .from("staff_services")
      .insert({ staff_member_id: staffA.id, service_id: serviceA.id });
    expect(insertError).toBeNull();

    const { error: deleteError } = await ownerAClient
      .from("staff_services")
      .delete()
      .eq("staff_member_id", staffA.id)
      .eq("service_id", serviceA.id);
    expect(deleteError).toBeNull();
  });
});

describe("staff_branches and service_branches (Phase 2A.1)", () => {
  it("linking staff to a branch from a different tenant is rejected", async () => {
    const { error } = await ownerAClient.from("staff_branches").insert({ staff_member_id: staffA.id, branch_id: branchB });
    expect(error).not.toBeNull();
  });

  it("linking a service to a branch from a different tenant is rejected", async () => {
    const { error } = await ownerAClient
      .from("service_branches")
      .insert({ service_id: serviceA.id, branch_id: branchB });
    expect(error).not.toBeNull();
  });

  it("staff.manage holder can assign and remove a staff member's branch", async () => {
    const { error: insertError } = await ownerAClient
      .from("staff_branches")
      .insert({ staff_member_id: staffA.id, branch_id: branchA });
    expect(insertError).toBeNull();

    const { data: readData } = await limitedAClient
      .from("staff_branches")
      .select("branch_id")
      .eq("staff_member_id", staffA.id);
    expect(readData).toHaveLength(1);

    const { error: deleteError } = await ownerAClient
      .from("staff_branches")
      .delete()
      .eq("staff_member_id", staffA.id)
      .eq("branch_id", branchA);
    expect(deleteError).toBeNull();
  });

  it("staff.view without staff.manage cannot assign a branch", async () => {
    const { error } = await limitedAClient
      .from("staff_branches")
      .insert({ staff_member_id: staffA.id, branch_id: branchA });
    expect(error).not.toBeNull();
  });

  it("services.manage holder can assign and remove a service's branch", async () => {
    const { error: insertError } = await ownerAClient
      .from("service_branches")
      .insert({ service_id: serviceA.id, branch_id: branchA });
    expect(insertError).toBeNull();

    const { data: readData } = await limitedAClient
      .from("service_branches")
      .select("branch_id")
      .eq("service_id", serviceA.id);
    expect(readData).toHaveLength(1);

    const { error: deleteError } = await ownerAClient
      .from("service_branches")
      .delete()
      .eq("service_id", serviceA.id)
      .eq("branch_id", branchA);
    expect(deleteError).toBeNull();
  });

  it("tenant A cannot see tenant B's staff_branches/service_branches rows", async () => {
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staffB.id}, ${branchB})`;
    await testDb`insert into service_branches (service_id, branch_id) values (${serviceB.id}, ${branchB})`;

    const { data: staffRows } = await ownerAClient.from("staff_branches").select("staff_member_id").eq("staff_member_id", staffB.id);
    expect(staffRows ?? []).toHaveLength(0);

    const { data: serviceRows } = await ownerAClient
      .from("service_branches")
      .select("service_id")
      .eq("service_id", serviceB.id);
    expect(serviceRows ?? []).toHaveLength(0);
  });
});

describe("customers", () => {
  it("tenant A cannot see tenant B's customers", async () => {
    const { data } = await ownerAClient.from("customers").select("id").eq("id", customerB.id);
    expect(data ?? []).toHaveLength(0);
  });

  it("customers.view without customers.create cannot insert", async () => {
    const { error } = await limitedAClient
      .from("customers")
      .insert({ tenant_id: tenantA.id, full_name: "Sızma Müşteri" });
    expect(error).not.toBeNull();
  });

  it("an archived customer remains readable and isolated the same as an active one", async () => {
    const { data, error } = await ownerAClient
      .from("customers")
      .insert({ tenant_id: tenantA.id, full_name: "Arşivlenen Müşteri", status: "archived" })
      .select("id, status")
      .single();
    expect(error).toBeNull();
    expect(data?.status).toBe("archived");

    const { data: fromB } = await ownerBClient.from("customers").select("id").eq("id", data!.id);
    expect(fromB ?? []).toHaveLength(0);

    await testDb`delete from customers where id = ${data!.id}`;
  });

  it("owner can create and update a customer end to end", async () => {
    const { data, error } = await ownerAClient
      .from("customers")
      .insert({ tenant_id: tenantA.id, full_name: "Gerçek Müşteri", phone: "5551234567" })
      .select("id")
      .single();
    expect(error).toBeNull();

    const { error: updateError } = await ownerAClient
      .from("customers")
      .update({ notes: "test note" })
      .eq("id", data!.id);
    expect(updateError).toBeNull();

    await testDb`delete from customers where id = ${data!.id}`;
  });
});

describe("staff_schedules and exceptions", () => {
  it("recurring schedule is visible to a member and writable only by schedules.manage", async () => {
    const scheduleId = await createStaffSchedule(tenantA.id, staffA.id, 1, "09:00", "18:00");

    const { data: readData } = await limitedAClient.from("staff_schedules").select("id").eq("id", scheduleId);
    expect(readData).toHaveLength(1);

    const { error: writeError } = await limitedAClient
      .from("staff_schedules")
      .insert({ tenant_id: tenantA.id, staff_member_id: staffA.id, weekday: 2, start_time: "09:00", end_time: "17:00" });
    expect(writeError).not.toBeNull();

    await testDb`delete from staff_schedules where id = ${scheduleId}`;
  });

  it("a date exception of type unavailable requires null hours", async () => {
    const { error } = await ownerAClient.from("staff_schedule_exceptions").insert({
      tenant_id: tenantA.id,
      staff_member_id: staffA.id,
      exception_date: "2026-09-01",
      type: "unavailable",
    });
    expect(error).toBeNull();

    await testDb`delete from staff_schedule_exceptions where staff_member_id = ${staffA.id} and exception_date = '2026-09-01'`;
  });

  it("a date exception of type custom_hours requires both hours and end > start", async () => {
    const { error: badError } = await ownerAClient.from("staff_schedule_exceptions").insert({
      tenant_id: tenantA.id,
      staff_member_id: staffA.id,
      exception_date: "2026-09-02",
      type: "custom_hours",
    });
    expect(badError).not.toBeNull();

    const { error: goodError } = await ownerAClient.from("staff_schedule_exceptions").insert({
      tenant_id: tenantA.id,
      staff_member_id: staffA.id,
      exception_date: "2026-09-02",
      type: "custom_hours",
      start_time: "10:00",
      end_time: "14:00",
    });
    expect(goodError).toBeNull();

    await testDb`delete from staff_schedule_exceptions where staff_member_id = ${staffA.id} and exception_date = '2026-09-02'`;
  });
});

describe("audit logging for staff/service/customer writes (Phase 2A.1)", () => {
  // 20260819064500: staff_members/services/customers have no RPC layer
  // (plain RLS-gated CRUD), so auditing them uses an AFTER INSERT OR
  // UPDATE trigger + a SECURITY DEFINER trigger function to reach
  // private.log_audit_event() — authenticated itself has no direct
  // EXECUTE on that function. These tests are the actual proof a write
  // through the normal client produces a real audit_logs row, not just
  // that the trigger was created without erroring.
  async function latestAuditRow(entityType: string, entityId: string) {
    const [row] = await testDb<
      { action: string; before: unknown; after: Record<string, unknown>; actor_user_id: string }[]
    >`
      select action, before, after, actor_user_id from audit_logs
      where entity_type = ${entityType} and entity_id = ${entityId}
      order by created_at desc limit 1
    `;
    return row;
  }

  it("creating a staff member writes a staff_member.created audit row", async () => {
    const { data, error } = await ownerAClient
      .from("staff_members")
      .insert({ tenant_id: tenantA.id, full_name: "Audit Personeli" })
      .select("id")
      .single();
    expect(error).toBeNull();

    const row = await latestAuditRow("staff_member", data!.id);
    expect(row?.action).toBe("staff_member.created");
    expect(row?.before).toBeNull();
    expect(row?.after?.full_name).toBe("Audit Personeli");
    expect(row?.actor_user_id).toBe(ownerA.id);

    await testDb`delete from staff_members where id = ${data!.id}`;
  });

  it("updating a staff member writes a staff_member.updated audit row with before/after", async () => {
    const { data } = await ownerAClient
      .from("staff_members")
      .insert({ tenant_id: tenantA.id, full_name: "Güncellenecek Personel" })
      .select("id")
      .single();

    await ownerAClient.from("staff_members").update({ status: "inactive" }).eq("id", data!.id);

    const row = await latestAuditRow("staff_member", data!.id);
    expect(row?.action).toBe("staff_member.updated");
    expect((row?.before as Record<string, unknown> | null)?.status).toBe("active");
    expect(row?.after?.status).toBe("inactive");

    await testDb`delete from staff_members where id = ${data!.id}`;
  });

  it("creating and updating a service writes service.created/service.updated audit rows", async () => {
    const { data } = await ownerAClient
      .from("services")
      .insert({ tenant_id: tenantA.id, name: "Audit Hizmeti", duration_minutes: 20, price: 60 })
      .select("id")
      .single();

    const createdRow = await latestAuditRow("service", data!.id);
    expect(createdRow?.action).toBe("service.created");

    await ownerAClient.from("services").update({ status: "inactive" }).eq("id", data!.id);
    const updatedRow = await latestAuditRow("service", data!.id);
    expect(updatedRow?.action).toBe("service.updated");
    expect(updatedRow?.after?.status).toBe("inactive");

    await testDb`delete from services where id = ${data!.id}`;
  });

  it("creating and updating a customer (archiving) writes customer.created/customer.updated audit rows", async () => {
    const { data } = await ownerAClient
      .from("customers")
      .insert({ tenant_id: tenantA.id, full_name: "Audit Müşterisi" })
      .select("id")
      .single();

    const createdRow = await latestAuditRow("customer", data!.id);
    expect(createdRow?.action).toBe("customer.created");

    await ownerAClient.from("customers").update({ status: "archived" }).eq("id", data!.id);
    const updatedRow = await latestAuditRow("customer", data!.id);
    expect(updatedRow?.action).toBe("customer.updated");
    expect((updatedRow?.before as Record<string, unknown> | null)?.status).toBe("active");
    expect(updatedRow?.after?.status).toBe("archived");

    await testDb`delete from customers where id = ${data!.id}`;
  });
});
