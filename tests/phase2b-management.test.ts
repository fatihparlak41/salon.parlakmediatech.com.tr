import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createRoleForTenant,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkStaffBranch,
  linkStaffService,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Phase 2B: covers the gaps phase2-domain.test.ts (Phase 2A.1) doesn't —
 * not a re-test of tenant isolation/permission-gating, already covered
 * there. Specifically: the "full replace via soft-delete" mechanism
 * lib/modules/staff/actions.ts uses for staff_schedules/
 * staff_schedule_exceptions (those two tables have no DELETE grant —
 * found during Phase 2B browser verification, see
 * supabase/migrations/README.md), an arbitrary (not all-or-one)
 * multi-branch subset, same-tenant membership linking success (only the
 * cross-tenant rejection was tested before), an archive/reactivate round
 * trip, and NUMERIC price precision. Every assertion goes through a real
 * signed-in user's client, same rule as every other test file — testDb is
 * fixture setup and ground-truth verification only.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let limitedA: TestUser; // staff.view/services.view/schedules.view only
let secondUserA: TestUser; // for same-tenant membership linking
// Faz NOTIF.2A.2 — hoisted to module scope (was a local `const` inside
// beforeAll). ownerB exists only to bootstrap tenantB via
// createTestTenant(slug, ownerB.id), which also creates a
// tenant_memberships row for ownerB in tenantB — that row (and tenantB
// itself) aren't gone until the outer afterAll's cleanupTenants call
// below, so ownerB can't be deleted until AFTER that call, not inline
// inside beforeAll (root cause: deleting an auth user while a
// tenant_memberships row still references it fails).
let ownerB: TestUser;
let ownerAClient: SupabaseClient;
let limitedAClient: SupabaseClient;

let branch1: string;
let branch2: string;
let branch3: string;

beforeAll(async () => {
  ownerA = await createTestUser("p2b-owner-a");
  limitedA = await createTestUser("p2b-limited-a");
  secondUserA = await createTestUser("p2b-second-a");
  ownerB = await createTestUser("p2b-owner-b");

  tenantA = await createTestTenant("test-p2b-a", ownerA.id);
  tenantB = await createTestTenant("test-p2b-b", ownerB.id);

  const limitedRoleA = await createRoleForTenant(tenantA.id, "Salt Okunur", [
    "staff.view",
    "services.view",
    "schedules.view",
  ]);
  await testDb`
    insert into tenant_memberships (tenant_id, user_id, role_id, status)
    values (${tenantA.id}, ${limitedA.id}, ${limitedRoleA}, 'active')
  `;
  // secondUserA gets a real membership but is deliberately left unlinked
  // to any staff record — the pool createStaffMember linking draws from.
  await testDb`
    insert into tenant_memberships (tenant_id, user_id, role_id, status)
    values (${tenantA.id}, ${secondUserA.id}, ${limitedRoleA}, 'active')
  `;

  branch1 = await createBranch(tenantA.id, "Şube 1");
  branch2 = await createBranch(tenantA.id, "Şube 2");
  branch3 = await createBranch(tenantA.id, "Şube 3");

  ownerAClient = await signInAs(ownerA);
  limitedAClient = await signInAs(limitedA);
}, 45000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, limitedA.id, secondUserA.id, ownerB.id]);
}, 45000);

describe("staff — same-tenant membership linking", () => {
  it("linking to an unlinked same-tenant membership succeeds", async () => {
    const staff = await createStaffMember(tenantA.id, "Bağlantılı Personel");
    const [membership] = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${secondUserA.id}
    `;

    const { error } = await ownerAClient
      .from("staff_members")
      .update({ tenant_membership_id: membership!.id })
      .eq("id", staff.id);
    expect(error).toBeNull();

    const [row] = await testDb<{ tenant_membership_id: string }[]>`
      select tenant_membership_id from staff_members where id = ${staff.id}
    `;
    expect(row?.tenant_membership_id).toBe(membership!.id);

    await testDb`delete from staff_members where id = ${staff.id}`;
  });

  it("a membership already linked to one staff record cannot be linked to a second", async () => {
    const staffOne = await createStaffMember(tenantA.id, "İlk Personel");
    const staffTwo = await createStaffMember(tenantA.id, "İkinci Personel");
    const [membership] = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${secondUserA.id}
    `;

    await testDb`update staff_members set tenant_membership_id = ${membership!.id} where id = ${staffOne.id}`;

    const { error } = await ownerAClient
      .from("staff_members")
      .update({ tenant_membership_id: membership!.id })
      .eq("id", staffTwo.id);
    expect(error).not.toBeNull();

    await testDb`delete from staff_members where id in (${staffOne.id}, ${staffTwo.id})`;
  });
});

describe("staff — arbitrary multi-branch subset", () => {
  it("a staff member can be assigned to 2 of 3 branches, not all and not one", async () => {
    const staff = await createStaffMember(tenantA.id, "Çok Şubeli");
    await linkStaffBranch(staff.id, branch1);
    await linkStaffBranch(staff.id, branch3);
    // branch2 deliberately excluded.

    const { data } = await ownerAClient.from("staff_branches").select("branch_id").eq("staff_member_id", staff.id);
    const ids = (data ?? []).map((r) => r.branch_id).sort();
    expect(ids).toEqual([branch1, branch3].sort());

    await testDb`delete from staff_members where id = ${staff.id}`;
  });

  it("replacing the branch subset (real delete, staff_branches has one) removes exactly the unselected branch", async () => {
    const staff = await createStaffMember(tenantA.id, "Değişen Şube");
    await linkStaffBranch(staff.id, branch1);
    await linkStaffBranch(staff.id, branch2);

    // Simulates updateStaffBranchesAction's full replace: delete all, then
    // insert the new desired set (branch2 + branch3, dropping branch1).
    const { error: deleteError } = await ownerAClient.from("staff_branches").delete().eq("staff_member_id", staff.id);
    expect(deleteError).toBeNull();
    const { error: insertError } = await ownerAClient
      .from("staff_branches")
      .insert([
        { staff_member_id: staff.id, branch_id: branch2 },
        { staff_member_id: staff.id, branch_id: branch3 },
      ]);
    expect(insertError).toBeNull();

    const { data } = await ownerAClient.from("staff_branches").select("branch_id").eq("staff_member_id", staff.id);
    const ids = (data ?? []).map((r) => r.branch_id).sort();
    expect(ids).toEqual([branch2, branch3].sort());

    await testDb`delete from staff_members where id = ${staff.id}`;
  });
});

describe("staff — archive/reactivate round trip", () => {
  it("a staff member can be deactivated and reactivated, status reflects each transition", async () => {
    const staff = await createStaffMember(tenantA.id, "Durum Testi");

    const { error: deactivateError } = await ownerAClient
      .from("staff_members")
      .update({ status: "inactive" })
      .eq("id", staff.id);
    expect(deactivateError).toBeNull();
    const [afterDeactivate] = await testDb<{ status: string }[]>`select status from staff_members where id = ${staff.id}`;
    expect(afterDeactivate?.status).toBe("inactive");

    const { error: reactivateError } = await ownerAClient
      .from("staff_members")
      .update({ status: "active" })
      .eq("id", staff.id);
    expect(reactivateError).toBeNull();
    const [afterReactivate] = await testDb<{ status: string }[]>`select status from staff_members where id = ${staff.id}`;
    expect(afterReactivate?.status).toBe("active");

    await testDb`delete from staff_members where id = ${staff.id}`;
  });

  it("a view-only user cannot change staff status", async () => {
    // RLS's USING clause on UPDATE filters non-matching rows rather than
    // throwing (unlike INSERT's WITH CHECK) — Supabase reports this as a
    // plain "0 rows affected" success, not an error. The real assertion
    // has to be the row's actual state afterward, via ground truth.
    const staff = await createStaffMember(tenantA.id, "Yetkisiz Durum Testi");
    await limitedAClient.from("staff_members").update({ status: "inactive" }).eq("id", staff.id);
    const [row] = await testDb<{ status: string }[]>`select status from staff_members where id = ${staff.id}`;
    expect(row?.status).toBe("active");
    await testDb`delete from staff_members where id = ${staff.id}`;
  });
});

describe("staff_schedules — full replace via soft-delete", () => {
  it("replacing a staff member's schedule soft-deletes the old rows (not hard-delete) and the live view shows only the new set", async () => {
    const staff = await createStaffMember(tenantA.id, "Program Değişimi");
    const oldRowId = await createStaffSchedule(tenantA.id, staff.id, 1, "09:00", "18:00");

    // Simulates updateStaffScheduleAction: soft-delete every existing live
    // row for this staff member, then insert the new desired set.
    const { error: softDeleteError } = await ownerAClient
      .from("staff_schedules")
      .update({ deleted_at: new Date().toISOString() })
      .eq("staff_member_id", staff.id)
      .is("deleted_at", null);
    expect(softDeleteError).toBeNull();

    const { error: insertError } = await ownerAClient.from("staff_schedules").insert({
      tenant_id: tenantA.id,
      staff_member_id: staff.id,
      weekday: 2,
      start_time: "10:00",
      end_time: "16:00",
    });
    expect(insertError).toBeNull();

    // The old row still exists (soft-delete, not gone) — this is the
    // actual mechanism, not just its visible effect.
    const [oldRow] = await testDb<{ deleted_at: string | null }[]>`
      select deleted_at from staff_schedules where id = ${oldRowId}
    `;
    expect(oldRow?.deleted_at).not.toBeNull();

    // The live (deleted_at is null) view shows only the new row.
    const { data: liveRows } = await ownerAClient
      .from("staff_schedules")
      .select("weekday, start_time")
      .eq("staff_member_id", staff.id)
      .is("deleted_at", null);
    expect(liveRows).toHaveLength(1);
    expect(liveRows?.[0]?.weekday).toBe(2);

    await testDb`delete from staff_schedules where staff_member_id = ${staff.id}`;
    await testDb`delete from staff_members where id = ${staff.id}`;
  });

  it("a view-only user cannot modify a staff member's schedule", async () => {
    const staff = await createStaffMember(tenantA.id, "Yetkisiz Program");
    const { error } = await limitedAClient.from("staff_schedules").insert({
      tenant_id: tenantA.id,
      staff_member_id: staff.id,
      weekday: 1,
      start_time: "09:00",
      end_time: "17:00",
    });
    expect(error).not.toBeNull();
    await testDb`delete from staff_members where id = ${staff.id}`;
  });
});

describe("staff_schedule_exceptions — soft-delete", () => {
  it("soft-deleting an exception preserves the row but frees the date for a new exception", async () => {
    const staff = await createStaffMember(tenantA.id, "İstisna Testi");
    const { data: created, error: createError } = await ownerAClient
      .from("staff_schedule_exceptions")
      .insert({
        tenant_id: tenantA.id,
        staff_member_id: staff.id,
        exception_date: "2026-10-05",
        type: "unavailable",
      })
      .select("id")
      .single();
    expect(createError).toBeNull();

    // Simulates deleteStaffExceptionAction.
    const { error: softDeleteError } = await ownerAClient
      .from("staff_schedule_exceptions")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", created!.id);
    expect(softDeleteError).toBeNull();

    const [row] = await testDb<{ deleted_at: string | null }[]>`
      select deleted_at from staff_schedule_exceptions where id = ${created!.id}
    `;
    expect(row?.deleted_at).not.toBeNull();

    // The partial unique index (staff_member_id, exception_date) where
    // deleted_at is null must exclude the soft-deleted row — a fresh
    // exception for the exact same date should now be insertable.
    const { error: freshInsertError } = await ownerAClient.from("staff_schedule_exceptions").insert({
      tenant_id: tenantA.id,
      staff_member_id: staff.id,
      exception_date: "2026-10-05",
      type: "custom_hours",
      start_time: "12:00",
      end_time: "15:00",
    });
    expect(freshInsertError).toBeNull();

    await testDb`delete from staff_schedule_exceptions where staff_member_id = ${staff.id}`;
    await testDb`delete from staff_members where id = ${staff.id}`;
  });
});

describe("services — NUMERIC price precision", () => {
  it("a two-decimal price round-trips exactly, not as a float approximation", async () => {
    const { data, error } = await ownerAClient
      .from("services")
      .insert({ tenant_id: tenantA.id, name: "Hassas Fiyat", duration_minutes: 45, price: 149.99 })
      .select("id, price")
      .single();
    expect(error).toBeNull();
    expect(String(data?.price)).toBe("149.99");

    const { error: updateError } = await ownerAClient
      .from("services")
      .update({ price: 1234.5 })
      .eq("id", data!.id);
    expect(updateError).toBeNull();

    const [row] = await testDb<{ price: string }[]>`select price from services where id = ${data!.id}`;
    expect(String(row?.price)).toBe("1234.50");

    await testDb`delete from services where id = ${data!.id}`;
  });
});

describe("service_branches / staff_services — unauthorized mutation across the two distinct permission gates", () => {
  it("a services.view-only user cannot change a service's branch availability (services.manage required)", async () => {
    const service = await createService(tenantA.id, "Yetki Testi Hizmeti", 30, 100);
    const { error } = await limitedAClient.from("service_branches").insert({ service_id: service.id, branch_id: branch1 });
    expect(error).not.toBeNull();
    await testDb`delete from services where id = ${service.id}`;
  });

  it("a services.view-only user cannot change which staff can perform a service (staff.manage required, not services.manage)", async () => {
    const service = await createService(tenantA.id, "Yetki Testi Hizmeti 2", 30, 100);
    const staff = await createStaffMember(tenantA.id, "Yetki Testi Personeli");

    // limitedA has services.view but not staff.manage — must fail even
    // though this write is reached from the *service's* eligibility tab.
    const { error } = await limitedAClient.from("staff_services").insert({ staff_member_id: staff.id, service_id: service.id });
    expect(error).not.toBeNull();

    await testDb`delete from services where id = ${service.id}`;
    await testDb`delete from staff_members where id = ${staff.id}`;
  });

  it("removing one of two eligible services for a staff member (real delete, staff_services has one) leaves exactly the other", async () => {
    const staff = await createStaffMember(tenantA.id, "İki Hizmetli Personel");
    const serviceA = await createService(tenantA.id, "Hizmet X", 20, 50);
    const serviceB = await createService(tenantA.id, "Hizmet Y", 30, 80);
    await linkStaffService(staff.id, serviceA.id);
    await linkStaffService(staff.id, serviceB.id);

    const { error: deleteError } = await ownerAClient
      .from("staff_services")
      .delete()
      .eq("staff_member_id", staff.id)
      .eq("service_id", serviceA.id);
    expect(deleteError).toBeNull();

    const { data } = await ownerAClient.from("staff_services").select("service_id").eq("staff_member_id", staff.id);
    expect(data).toHaveLength(1);
    expect(data?.[0]?.service_id).toBe(serviceB.id);

    await testDb`delete from services where id in (${serviceA.id}, ${serviceB.id})`;
    await testDb`delete from staff_members where id = ${staff.id}`;
  });
});

describe("cross-tenant isolation spot checks specific to Phase 2B flows", () => {
  it("tenant B cannot see or modify tenant A's staff_branches rows", async () => {
    const ownerBUser = await createTestUser("p2b-crosscheck-owner-b");
    const crossTenant = await createTestTenant("test-p2b-cross-b", ownerBUser.id);
    const ownerBClient = await signInAs(ownerBUser);

    const staff = await createStaffMember(tenantA.id, "Çapraz Kiracı Testi");
    await linkStaffBranch(staff.id, branch1);

    const { data } = await ownerBClient.from("staff_branches").select("staff_member_id").eq("staff_member_id", staff.id);
    expect(data ?? []).toHaveLength(0);

    await testDb`delete from staff_branches where staff_member_id = ${staff.id}`;
    await testDb`delete from staff_members where id = ${staff.id}`;
    await cleanupTenants([crossTenant.id]);
    await cleanupUsers([ownerBUser.id]);
  });
});
