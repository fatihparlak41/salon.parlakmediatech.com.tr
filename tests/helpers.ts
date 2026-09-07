import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import type { Database } from "@/lib/supabase/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!url || !publishableKey || !serviceRoleKey || !testDatabaseUrl) {
  throw new Error(
    "Missing env vars for tests. Check .env.local has " +
      "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, " +
      "SUPABASE_SERVICE_ROLE_KEY and TEST_DATABASE_URL (all added " +
      "manually, never committed — see .env.example). Never paste any " +
      "of these in chat.",
  );
}

/** GoTrue Admin API only (createUser/deleteUser/generateLink/...) — this
 * goes over Supabase Auth's admin REST surface, not PostgREST, so it has
 * nothing to do with Postgres table/function grants and doesn't belong
 * in the service_role grant discussion below. Never use this for table
 * reads/writes — see testDb. */
export const admin = createSupabaseClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Direct Postgres connection for fixture setup/teardown and
 * ground-truth reads in assertions (e.g. "did this row actually change,
 * independent of what RLS lets the test's own client see"). Deliberately
 * NOT the service_role Data API: fixture setup needs to create
 * cross-tenant test data no RLS-scoped client could create, and routing
 * that through PostgREST would mean granting service_role broad table
 * access in production migrations just so tests can run — a test
 * infrastructure need shaping a production security surface. This
 * connection's own Postgres role carries that access instead, so
 * service_role's actual grants can stay at whatever the application
 * runtime genuinely needs (currently: nothing — see
 * supabase/migrations/README.md). DEV-only; TEST_DATABASE_URL must never
 * be set in Vercel or point at PROD. */
export const testDb = postgres(testDatabaseUrl, { ssl: "require", max: 5 });

export type TestUser = { id: string; email: string; password: string };
export type TestTenant = { id: string; slug: string; ownerRoleId: string };

export function anonClient() {
  return createSupabaseClient<Database>(url!, publishableKey!);
}

/** Real-clock-relative future timestamp. Only appropriate when a test's
 * own semantics genuinely need relativity to "now" — e.g. proving a
 * cutoff-minutes boundary. For "just needs some valid future slot" use
 * safeMorningStart instead: a fixed hoursFromNow(N) is a genuine latent
 * flake whenever N hours from the real current moment happens to cross
 * tenant-local midnight (staff_is_available's own pre-existing,
 * unrelated guard) — which depends only on what wall-clock time the
 * suite happens to run at, confirmed repeatedly in Faz 2H.0's audit. */
export function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3600_000);
}

/** Local 08:00, Europe/Istanbul (this project's fixed-offset UTC+3
 * tenant default — no DST), N days out — decoupled from the real
 * current time-of-day, so a start/delta pair built from this can never
 * land near tenant-local midnight by wall-clock coincidence the way a
 * fixed hoursFromNow(N)/hoursFromNow(N+delta) pair can. Use for any
 * fixture that just needs "some valid future slot with same-day
 * headroom", not genuine real-clock relativity. */
export function safeMorningStart(daysFromNow: number): Date {
  const tzOffsetMs = 3 * 3600_000;
  const localNow = new Date(Date.now() + tzOffsetMs);
  const localMorning = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + daysFromNow, 8, 0, 0));
  return new Date(localMorning.getTime() - tzOffsetMs);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createTestUser(label: string): Promise<TestUser> {
  const email = `test-${uniqueSuffix()}-${label}@example.com`;
  const password = "Test1234!Test1234!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`failed to create test user ${label}: ${error?.message}`);
  }
  return { id: data.user.id, email, password };
}

export async function signInAs(user: TestUser) {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) {
    throw new Error(`failed to sign in as ${user.email}: ${error.message}`);
  }
  return client;
}

/** Tenant with the SALON_OWNER template cloned as-is (full permission
 * set, including permissions.manage_unrestricted) for `ownerId`. */
export async function createTestTenant(
  slug: string,
  ownerId: string,
): Promise<TestTenant> {
  const [tenant] = await testDb<{ id: string }[]>`
    insert into tenants (name, slug, created_by)
    values (${`Test Tenant ${slug}`}, ${slug}, ${ownerId})
    returning id
  `;
  if (!tenant) throw new Error("failed to create test tenant");

  const [template] = await testDb<
    { id: string; key: string; name: string; description: string | null }[]
  >`
    select id, key, name, description from role_templates where key = 'SALON_OWNER'
  `;
  if (!template) throw new Error("SALON_OWNER role template is missing");

  const [role] = await testDb<{ id: string }[]>`
    insert into roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
    values (${tenant.id}, ${template.key}, ${template.name}, ${template.description}, true, ${template.id})
    returning id
  `;
  if (!role) throw new Error("failed to create test role");

  const templatePermissions = await testDb<{ permission_id: string }[]>`
    select permission_id from role_template_permissions where role_template_id = ${template.id}
  `;

  if (templatePermissions.length > 0) {
    await testDb`
      insert into role_permissions ${testDb(
        templatePermissions.map((p) => ({ role_id: role.id, permission_id: p.permission_id })),
      )}
    `;
  }

  await testDb`
    insert into tenant_memberships (tenant_id, user_id, role_id, status)
    values (${tenant.id}, ${ownerId}, ${role.id}, 'active')
  `;

  return { id: tenant.id, slug, ownerRoleId: role.id };
}

/** A role with exactly `permissionKeys` — for building a deliberately
 * limited (non-owner) tenant member. Not attached to any membership. */
export async function createRoleForTenant(
  tenantId: string,
  name: string,
  permissionKeys: string[],
): Promise<string> {
  const [role] = await testDb<{ id: string }[]>`
    insert into roles (tenant_id, name, is_system_default)
    values (${tenantId}, ${name}, false)
    returning id
  `;
  if (!role) throw new Error(`failed to create role "${name}"`);

  if (permissionKeys.length > 0) {
    const perms = await testDb<{ id: string; key: string }[]>`
      select id, key from permissions where key in ${testDb(permissionKeys)}
    `;
    if (perms.length > 0) {
      await testDb`
        insert into role_permissions ${testDb(
          perms.map((p) => ({ role_id: role.id, permission_id: p.id })),
        )}
      `;
    }
  }

  return role.id;
}

export async function addMembership(
  tenantId: string,
  userId: string,
  roleId: string,
): Promise<string> {
  const [membership] = await testDb<{ id: string }[]>`
    insert into tenant_memberships (tenant_id, user_id, role_id, status)
    values (${tenantId}, ${userId}, ${roleId}, 'active')
    returning id
  `;
  if (!membership) throw new Error("failed to create membership");
  return membership.id;
}

/** Clones a REAL role_templates row (SALON_MANAGER, RECEPTIONIST, ...)
 * into this tenant's own roles/role_permissions, exactly mirroring what
 * createTestTenant already does for SALON_OWNER, then attaches userId
 * to it. Unlike createRoleForTenant (an explicit, hand-picked
 * permission list, useful for "this exact set" fixtures), this is for
 * proving a role template's actual DEFAULT grants — e.g. Faz 2G.3.2's
 * "Manager yes, Receptionist no by default" requirement — since a
 * hand-picked list can't accidentally drift out of sync with what the
 * template really ships. */
export async function createTestMembershipFromTemplate(
  tenantId: string,
  userId: string,
  templateKey: string,
): Promise<{ roleId: string }> {
  const [template] = await testDb<
    { id: string; key: string; name: string; description: string | null }[]
  >`select id, key, name, description from role_templates where key = ${templateKey}`;
  if (!template) throw new Error(`role template ${templateKey} not found`);

  const [role] = await testDb<{ id: string }[]>`
    insert into roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
    values (${tenantId}, ${template.key}, ${template.name}, ${template.description}, true, ${template.id})
    returning id
  `;
  if (!role) throw new Error(`failed to clone role template ${templateKey}`);

  const templatePermissions = await testDb<{ permission_id: string }[]>`
    select permission_id from role_template_permissions where role_template_id = ${template.id}
  `;
  if (templatePermissions.length > 0) {
    await testDb`
      insert into role_permissions ${testDb(
        templatePermissions.map((p) => ({ role_id: role.id, permission_id: p.permission_id })),
      )}
    `;
  }

  await addMembership(tenantId, userId, role.id);
  return { roleId: role.id };
}

/**
 * FK-safe teardown, in dependency order. audit_logs and branches are the
 * two easy-to-forget ones — private.log_audit_event() and the "insert a
 * branch" test both leave rows that block a plain tenants delete (found
 * the hard way twice in Faz 1/1.5, see supabase/migrations/README.md).
 * Every test file's afterAll should route through this rather than
 * reimplementing the order.
 *
 * Phase 2 tables go first, in their own dependency order: appointment_items
 * before appointments/services/staff_members; appointments before
 * branches/customers; schedules/staff_services before staff_members;
 * staff_members before branches/tenant_memberships (both nullable FKs,
 * but the referenced row must still exist while set).
 */
export async function cleanupTenants(tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;

  // booking_account_claims: NO ACTION on both its composite FKs
  // (appointment_id, tenant_id) and (customer_id, tenant_id) — a claim
  // row still pointing at either blocks the deletes just below, same
  // FK-order lesson as customer_account_links.
  await testDb`delete from booking_account_claims where tenant_id in ${testDb(tenantIds)}`;
  // customer_account_pairing_codes (Faz 2G.3.2): same FK-order lesson —
  // its composite FK (consumed_by_customer_id, tenant_id) blocks a plain
  // customers delete once a code has been redeemed.
  await testDb`delete from customer_account_pairing_codes where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from appointment_items where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from appointments where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from staff_schedule_exceptions where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from staff_schedules where tenant_id in ${testDb(tenantIds)}`;

  const staff = await testDb<{ id: string }[]>`
    select id from staff_members where tenant_id in ${testDb(tenantIds)}
  `;
  const staffIds = staff.map((s) => s.id);
  if (staffIds.length > 0) {
    await testDb`delete from staff_services where staff_member_id in ${testDb(staffIds)}`;
  }
  // customer_account_links: NO ACTION on its composite (customer_id,
  // tenant_id) FK — a link row still pointing at a customer blocks the
  // customers delete just below, same FK-order lesson as tenant_features.
  await testDb`delete from customer_account_links where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from customers where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from services where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from staff_members where tenant_id in ${testDb(tenantIds)}`;

  await testDb`delete from audit_logs where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from branches where tenant_id in ${testDb(tenantIds)}`;
  await testDb`delete from tenant_memberships where tenant_id in ${testDb(tenantIds)}`;
  // tenant_features: not written by any fixture helper above (no
  // createXxx wrapper for it) — Faz 2F is the first test file to insert
  // it directly (enabling online_booking), which is what surfaced this
  // gap. FK-blocks the tenants delete below if left out.
  await testDb`delete from tenant_features where tenant_id in ${testDb(tenantIds)}`;

  const roles = await testDb<{ id: string }[]>`
    select id from roles where tenant_id in ${testDb(tenantIds)}
  `;
  const roleIds = roles.map((r) => r.id);
  if (roleIds.length > 0) {
    await testDb`delete from role_permissions where role_id in ${testDb(roleIds)}`;
  }
  await testDb`delete from roles where tenant_id in ${testDb(tenantIds)}`;

  await testDb`delete from tenants where id in ${testDb(tenantIds)}`;
}

// --- Phase 2 fixture helpers ------------------------------------------

export type TestStaffMember = { id: string; fullName: string };
export type TestService = { id: string; name: string; durationMinutes: number; price: number };
export type TestCustomer = { id: string; fullName: string };

export async function createBranch(tenantId: string, name: string): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantId}, ${name}) returning id
  `;
  if (!row) throw new Error("failed to create test branch");
  return row.id;
}

// Faz 2I.2B: concurrentCapacity defaults to 1 (the DB column's own
// default), so every existing call site keeps today's exact one-at-a-time
// behavior unchanged; only capacity-specific tests pass a higher value.
export async function createStaffMember(
  tenantId: string,
  fullName: string,
  concurrentCapacity = 1,
): Promise<TestStaffMember> {
  const [row] = await testDb<{ id: string }[]>`
    insert into staff_members (tenant_id, full_name, concurrent_capacity)
    values (${tenantId}, ${fullName}, ${concurrentCapacity})
    returning id
  `;
  if (!row) throw new Error("failed to create test staff member");
  return { id: row.id, fullName };
}

/** Phase 2A.1: staff_members/services carry no branch_id column anymore —
 * staff_branches/service_branches are the sole source of truth, and a
 * staff member/service with zero rows here is bookable at NO branch (not
 * "every branch"), so any fixture used in an appointment-creation test
 * must call this (and linkServiceBranch) explicitly. See
 * supabase/migrations/20260819062000. */
export async function linkStaffBranch(staffMemberId: string, branchId: string): Promise<void> {
  await testDb`
    insert into staff_branches (staff_member_id, branch_id)
    values (${staffMemberId}, ${branchId})
  `;
}

export async function linkServiceBranch(serviceId: string, branchId: string): Promise<void> {
  await testDb`
    insert into service_branches (service_id, branch_id)
    values (${serviceId}, ${branchId})
  `;
}

export async function createService(
  tenantId: string,
  name: string,
  durationMinutes: number,
  price: number,
): Promise<TestService> {
  const [row] = await testDb<{ id: string }[]>`
    insert into services (tenant_id, name, duration_minutes, price)
    values (${tenantId}, ${name}, ${durationMinutes}, ${price})
    returning id
  `;
  if (!row) throw new Error("failed to create test service");
  return { id: row.id, name, durationMinutes, price };
}

export async function createCustomer(tenantId: string, fullName: string): Promise<TestCustomer> {
  const [row] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name)
    values (${tenantId}, ${fullName})
    returning id
  `;
  if (!row) throw new Error("failed to create test customer");
  return { id: row.id, fullName };
}

export async function linkStaffService(staffMemberId: string, serviceId: string): Promise<void> {
  await testDb`
    insert into staff_services (staff_member_id, service_id)
    values (${staffMemberId}, ${serviceId})
  `;
}

/** weekday: 0=Sunday..6=Saturday (Postgres EXTRACT(DOW) convention, see
 * 20260819052446). startTime/endTime: "HH:MM" 24h. branchId: omitted/null
 * (the default, matching every existing call site) means the row's own
 * branch_id stays NULL — "applies at every branch this staff member is
 * assigned to" per staff_is_available's own semantics (Faz 5A.3B). */
export async function createStaffSchedule(
  tenantId: string,
  staffMemberId: string,
  weekday: number,
  startTime: string,
  endTime: string,
  branchId: string | null = null,
): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into staff_schedules (tenant_id, staff_member_id, weekday, start_time, end_time, branch_id)
    values (${tenantId}, ${staffMemberId}, ${weekday}, ${startTime}, ${endTime}, ${branchId})
    returning id
  `;
  if (!row) throw new Error("failed to create test staff schedule");
  return row.id;
}

/** Faz 5A.3B: a date-specific override for one staff member — a day off
 * (type="unavailable", startTime/endTime omitted) or different-than-usual
 * hours (type="custom_hours", both required). exceptionDate: "YYYY-MM-DD".
 * Staff-wide by design — staff_schedule_exceptions has no branch_id
 * column (see 20260819052446). */
export async function createScheduleException(
  tenantId: string,
  staffMemberId: string,
  exceptionDate: string,
  type: "unavailable" | "custom_hours",
  startTime?: string,
  endTime?: string,
): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into staff_schedule_exceptions (tenant_id, staff_member_id, exception_date, type, start_time, end_time)
    values (${tenantId}, ${staffMemberId}, ${exceptionDate}, ${type}, ${startTime ?? null}, ${endTime ?? null})
    returning id
  `;
  if (!row) throw new Error("failed to create test schedule exception");
  return row.id;
}

export async function cleanupUsers(userIds: string[]): Promise<void> {
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
}

export async function cleanupPlatformAdmins(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await testDb`delete from platform_admins where user_id in ${testDb(userIds)}`;
}
