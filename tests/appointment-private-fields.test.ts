import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  asAuthenticatedUser,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomer,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  safeMorningStart,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";
import { getAppointmentPrivateDetails } from "@/lib/modules/appointments/private-details";

/**
 * Faz SAAS.1E.1 — appointment NOTES and appointment-item PRICE snapshots are
 * gated by appointments.UPDATE, not merely appointments.view.
 *
 * Personel holds appointments.view alone and must see every operational
 * field of every tenant appointment (date/time, status, branch, booked and
 * actual staff, service, duration, customer display name) but NOT notes,
 * item prices, or the creating login (appointments.created_by). Owner,
 * Yönetici and Resepsiyon all hold appointments.update and keep full access
 * to notes and prices through get_appointment_private_details — nothing
 * about their workflow changes.
 */

const TAG = randomUUID().slice(0, 8);
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`apf-${label}`);
  createdUserIds.push(user.id);
  return user;
}

async function provisionedRoles(tenantId: string): Promise<Record<string, string>> {
  await testDb`select * from private.provision_default_roles(${tenantId}::uuid)`;
  const rows = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${tenantId} and deleted_at is null`;
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

describe("appointments.notes / appointment_items.price — appointments.update-only, via get_appointment_private_details", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const role: Record<string, string> = {};
  let branchId: string;
  let apptId: string;
  let itemId: string;
  const NOTES = `gizli-randevu-notu-${TAG}`;
  const PRICE = "555.00";

  beforeAll(async () => {
    users.owner = await newUser("owner");
    tenant = await createTestTenant(`test-tenant-apf-${TAG}`, users.owner!.id);
    createdTenantIds.push(tenant.id);
    Object.assign(role, await provisionedRoles(tenant.id));
    for (const [label, key] of [["manager", "SALON_MANAGER"], ["reception", "RECEPTIONIST"], ["personel", "STYLIST"]] as const) {
      users[label] = await newUser(label);
      await addMembership(tenant.id, users[label]!.id, role[key]!);
    }

    branchId = await createBranch(tenant.id, "APF Şube");
    const staff = await createStaffMember(tenant.id, "APF Personel");
    const service = await createService(tenant.id, "APF Hizmet", 45, Number(PRICE));
    await linkServiceBranch(service.id, branchId);
    await linkStaffBranch(staff.id, branchId);
    await linkStaffService(staff.id, service.id);
    for (let weekday = 0; weekday <= 6; weekday++) await createStaffSchedule(tenant.id, staff.id, weekday, "00:00", "23:59");
    const customer = await createCustomer(tenant.id, "APF Müşteri");

    const ownerClient = await signInAs(users.owner!);
    const start = safeMorningStart(11);
    const { data, error } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customer.id,
      p_items: [{ service_id: service.id, staff_member_id: staff.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });
    if (error || !data) throw new Error(`create_appointment failed: ${error?.message}`);
    apptId = data as string;
    await testDb`update appointments set notes = ${NOTES} where id = ${apptId}`;
    const [item] = await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${apptId}`;
    itemId = item!.id;
    await ownerClient.auth.signOut();
  }, 120000);

  afterAll(async () => {
    await cleanupTenants(createdTenantIds);
    await cleanupUsers(createdUserIds);
  }, 120000);

  const privateDetails = (userId: string) =>
    asAuthenticatedUser(userId, async (sql) => {
      const rows = await sql<{ v: { visible: boolean; notes: string | null; prices: Record<string, string> } }[]>`
        select public.get_appointment_private_details(${tenant.id}::uuid, ${apptId}::uuid) as v`;
      return rows[0]!.v;
    });

  it("Owner, Yönetici and Resepsiyon (all hold appointments.update) get notes and the item's price, unabridged", async () => {
    for (const label of ["owner", "manager", "reception"] as const) {
      const details = await privateDetails(users[label]!.id);
      expect(details.visible, label).toBe(true);
      expect(details.notes, label).toBe(NOTES);
      expect(details.prices[itemId], label).toBe(PRICE);
    }
  });

  it("Personel (appointments.view only) gets visible:false, notes:null, an empty price map — never an error", async () => {
    const details = await privateDetails(users.personel!.id);
    expect(details).toEqual({ visible: false, notes: null, prices: {} });
  });

  it("price round-trips as TEXT (this codebase's money convention), never a native JSON number", async () => {
    const details = await privateDetails(users.owner!.id);
    expect(typeof details.prices[itemId]).toBe("string");
  });

  it("requires appointments.view at all — a non-member and a member with zero permissions are refused, not merely hidden", async () => {
    const outsider = await newUser("outsider");
    const zeroPerm = await newUser("zero-perm");
    const emptyRole = await testDb<{ id: string }[]>`insert into roles (tenant_id, name, is_system_default) values (${tenant.id}, 'Boş', false) returning id`;
    await addMembership(tenant.id, zeroPerm.id, emptyRole[0]!.id);

    const outsiderAttempt = await attemptAs(outsider.id, (sql) => sql`select public.get_appointment_private_details(${tenant.id}::uuid, ${apptId}::uuid)`);
    const zeroPermAttempt = await attemptAs(zeroPerm.id, (sql) => sql`select public.get_appointment_private_details(${tenant.id}::uuid, ${apptId}::uuid)`);
    expect(outsiderAttempt).toMatchObject({ ok: false, message: "appointments.view required" });
    expect(zeroPermAttempt).toMatchObject({ ok: false, message: "appointments.view required" });
  }, 60000);

  it("is tenant-bound: another tenant's Owner holds appointments.view in THEIR OWN tenant, so the call succeeds, but the join finds nothing — never this appointment's data, no error, no oracle", async () => {
    const otherOwner = await newUser("other-owner");
    const other = await createTestTenant(`test-tenant-apf-other-${TAG}`, otherOwner.id);
    createdTenantIds.push(other.id);
    const rows = await asAuthenticatedUser(otherOwner.id, (sql) =>
      sql<{ v: { visible: boolean; notes: string | null; prices: Record<string, string> } }[]>`select public.get_appointment_private_details(${other.id}::uuid, ${apptId}::uuid) as v`,
    );
    // visible:true (they hold appointments.update in THEIR tenant) but the tenant-bound join matched nothing.
    expect(rows[0]!.v).toEqual({ visible: true, notes: null, prices: {} });
  }, 60000);

  it("a caller with no membership at all in the target tenant is refused outright", async () => {
    const outsider = await newUser("apf-outsider");
    const attempt = await attemptAs(outsider.id, (sql) => sql`select public.get_appointment_private_details(${tenant.id}::uuid, ${apptId}::uuid)`);
    expect(attempt).toMatchObject({ ok: false, message: "appointments.view required" });
  }, 60000);

  it("appointments.notes and appointment_items.price are NOT selectable columns for anyone — Owner included, and select * is refused", async () => {
    for (const label of ["owner", "manager", "personel"] as const) {
      const notesAttempt = await attemptAs(users[label]!.id, (sql) => sql`select notes from appointments where id = ${apptId}`);
      const priceAttempt = await attemptAs(users[label]!.id, (sql) => sql`select price from appointment_items where id = ${itemId}`);
      const starAppointments = await attemptAs(users[label]!.id, (sql) => sql`select * from appointments where id = ${apptId}`);
      const starItems = await attemptAs(users[label]!.id, (sql) => sql`select * from appointment_items where id = ${itemId}`);
      for (const [name, r] of [["notes", notesAttempt], ["price", priceAttempt], ["star-appt", starAppointments], ["star-items", starItems]] as const) {
        expect(r, `${label}.${name}`).toMatchObject({ ok: false, message: expect.stringContaining("permission denied") });
      }
    }
  });

  it("appointments.created_by is also hidden (the access-graph link the audit found alongside notes)", async () => {
    const attempt = await attemptAs(users.owner!.id, (sql) => sql`select created_by from appointments where id = ${apptId}`);
    expect(attempt).toMatchObject({ ok: false, message: expect.stringContaining("permission denied") });
  });

  it("the 12 non-idempotency appointments columns and the 12 non-price appointment_items columns remain readable for everyone with appointments.view", async () => {
    const rows = await asAuthenticatedUser(users.personel!.id, (sql) => sql<{ id: string; status: string; scheduled_start_at: string }[]>`
      select id, tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at, created_at, updated_at from appointments where id = ${apptId}`);
    expect(rows).toHaveLength(1);
    const items = await asAuthenticatedUser(users.personel!.id, (sql) => sql<{ id: string; duration_minutes: number }[]>`
      select id, tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, sequence, appointment_status, created_at, updated_at, actual_staff_member_id
      from appointment_items where id = ${itemId}`);
    expect(items).toHaveLength(1);
    expect(items[0]!.duration_minutes).toBe(45);
  });
});

describe("the TypeScript helper — private-details.ts", () => {
  it("degrades to hidden on any error, no-data, or malformed response — never throws", async () => {
    const failing = { rpc: async () => ({ data: null, error: { message: "appointments.view required" } }) } as unknown as Parameters<typeof getAppointmentPrivateDetails>[0];
    expect(await getAppointmentPrivateDetails(failing, "t", "a")).toEqual({ visible: false, notes: null, prices: new Map() });

    const noData = { rpc: async () => ({ data: null, error: null }) } as unknown as Parameters<typeof getAppointmentPrivateDetails>[0];
    expect(await getAppointmentPrivateDetails(noData, "t", "a")).toEqual({ visible: false, notes: null, prices: new Map() });

    const notVisible = { rpc: async () => ({ data: { visible: false, notes: "should be ignored", prices: { x: "1" } }, error: null }) } as unknown as Parameters<typeof getAppointmentPrivateDetails>[0];
    expect(await getAppointmentPrivateDetails(notVisible, "t", "a")).toEqual({ visible: false, notes: null, prices: new Map() });
  });

  it("returns a real Map of item id -> price text when visible", async () => {
    const ok = { rpc: async () => ({ data: { visible: true, notes: "n", prices: { "item-1": "10.00", "item-2": "20.00" } }, error: null }) } as unknown as Parameters<typeof getAppointmentPrivateDetails>[0];
    const result = await getAppointmentPrivateDetails(ok, "t", "a");
    expect(result.visible).toBe(true);
    expect(result.notes).toBe("n");
    expect(result.prices.get("item-1")).toBe("10.00");
    expect(result.prices.get("item-2")).toBe("20.00");
  });
});

describe("no appointment surface re-introduces a direct notes/price select", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", ".next", ".git"].includes(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith("database.types.ts")) out.push(full);
    }
    return out;
  }
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const files = ["app", "components", "lib"].flatMap((d) => walk(path.join(process.cwd(), d)));
  const surfaces = files.filter((f) => /\.from\(\s*["']appointments["']\s*\)|\.from\(\s*["']appointment_items["']\s*\)/.test(strip(readFileSync(f, "utf8"))));

  it("finds the appointment surfaces it is meant to police", () => {
    const rel = surfaces.map((f) => path.relative(process.cwd(), f).replaceAll("\\", "/"));
    for (const expected of ["lib/modules/appointments/queries.ts", "components/appointments/appointment-detail-sheet.tsx"]) {
      expect(rel, expected).toContain(expected);
    }
  });

  it("no direct select string in a file that queries appointments/appointment_items lists `notes` or (a bare, non-service) `price`", () => {
    const offenders: string[] = [];
    for (const f of surfaces) {
      const src = strip(readFileSync(f, "utf8"));
      const selects = src.match(/\.select\(\s*[`"][\s\S]*?[`"]/g) ?? [];
      for (const s of selects) {
        if (/\bnotes\b/.test(s)) offenders.push(`${f}: notes in a select string`);
        // "price" alone is ambiguous (services.price is legitimately selected elsewhere) — only flag it
        // paired with appointment_items in the very same select string, the shape this migration restricts.
        if (/appointment_items/.test(s) && /\bprice\b/.test(s)) offenders.push(`${f}: appointment_items(...price...) in a select string`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("getAppointmentDetail / appointment-detail-sheet.tsx both read private fields through getAppointmentPrivateDetails", () => {
    for (const rel of ["lib/modules/appointments/queries.ts", "components/appointments/appointment-detail-sheet.tsx"]) {
      expect(strip(readFileSync(path.join(process.cwd(), rel), "utf8")), rel).toContain("getAppointmentPrivateDetails(");
    }
  });
});
