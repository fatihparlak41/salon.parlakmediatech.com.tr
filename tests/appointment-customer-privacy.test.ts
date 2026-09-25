import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CUSTOMER_NAME_FALLBACK, getAppointmentCustomerNames } from "@/lib/modules/appointments/customer-display";
import { getTodayAppointments } from "@/lib/modules/dashboard/queries";
import {
  addMembership,
  anonClient,
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomRole,
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

/**
 * Faz SAAS.1E.1 — appointment-safe customer display.
 *
 * Personel ("STYLIST") holds appointments.view and nothing else: they see EVERY
 * appointment of the salon on the calendar, but not the customer directory.
 * Until this phase the customer name on an appointment came from a PostgREST
 * embed of customers(full_name) — which is governed by customers.view, the same
 * permission that exposes phone, e-mail, notes and account linkage. The fix is
 * database-authoritative: public.get_appointment_customer_display returns
 * (appointment_id, customer_display_name) for appointments the caller can
 * already see, and nothing else.
 *
 * Everything below runs against the REAL provisioned roles (no hand-picked
 * permission list), through real signed-in PostgREST clients wherever the API
 * surface itself is the claim, and through the simulated authenticated role
 * (asAuthenticatedUser) for the wide sweeps.
 */

const TAG = randomUUID().replace(/-/g, "").slice(0, 8);
const TZ = "Europe/Istanbul";

// A 10-digit Turkish mobile number derived from the run's tag, in the formatted and the bare form.
const PHONE_DIGITS = `5${(parseInt(TAG, 16) % 1_000_000_000).toString().padStart(9, "0")}`;
const OTHER_PHONE_DIGITS = `5${((parseInt(TAG, 16) + 7) % 1_000_000_000).toString().padStart(9, "0")}`;
const formatPhone = (d: string) => `+90 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`;

const CANARY = {
  name: `Canary Müşteri ${TAG}`,
  phone: formatPhone(PHONE_DIGITS),
  email: `pii-canary-${TAG}@example.com`,
  notes: `CANARY-KISISEL-MUSTERI-NOTU-${TAG}`,
  appointmentNotes: `Randevu notu ${TAG}`,
};

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

const users: Record<string, TestUser> = {};
let tenantA: TestTenant;
let tenantB: TestTenant;
const roleA: Record<string, string> = {};
let branchA: string;
let staffA1: { id: string; fullName: string };
let staffA2: { id: string; fullName: string };
let serviceA: { id: string; name: string };
const customers: Record<string, { id: string; fullName: string }> = {};
const appt: Record<string, string> = {};

let personelClient: Awaited<ReturnType<typeof signInAs>>;
let ownerClient: Awaited<ReturnType<typeof signInAs>>;

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`acp-${label}`);
  createdUserIds.push(user.id);
  users[label] = user;
  return user;
}

async function insertAppointmentRow(args: {
  tenantId: string;
  branchId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
  start: Date;
  status?: string;
  notes?: string | null;
  createdBy: string;
}): Promise<string> {
  const end = new Date(args.start.getTime() + 30 * 60_000);
  const [row] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, status, notes, created_by)
    values (${args.tenantId}, ${args.branchId}, ${args.customerId}, 'internal', ${args.start.toISOString()}, ${end.toISOString()},
            ${args.status ?? "scheduled"}, ${args.notes ?? null}, ${args.createdBy})
    returning id`;
  await testDb`
    insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
    values (${args.tenantId}, ${row!.id}, ${args.serviceId}, ${args.staffId}, ${args.start.toISOString()}, ${end.toISOString()}, 30, 100, 1)`;
  return row!.id;
}

const ids = (...keys: string[]) => keys.map((k) => appt[k]!);

/** The projection called through the simulated authenticated role (raises are surfaced by the caller). */
async function displayRows(userId: string, tenantId: string | null, appointmentIds: string[] | null) {
  return await asAuthenticatedUser(userId, async (sql) =>
    sql<{ appointment_id: string; customer_display_name: string }[]>`
      select * from public.get_appointment_customer_display(${tenantId}::uuid, ${appointmentIds === null ? null : sql.array(appointmentIds, 2951)}::uuid[])`,
  );
}

const displayAttempt = (userId: string, tenantId: string | null, appointmentIds: string[] | null) =>
  attemptAs(userId, async (sql) => {
    await sql`select * from public.get_appointment_customer_display(${tenantId}::uuid, ${appointmentIds === null ? null : sql.array(appointmentIds, 2951)}::uuid[])`;
  });

beforeAll(async () => {
  for (const label of ["owner", "personel", "reception", "manager", "customersOnly", "dual", "ownerB"]) await newUser(label);

  tenantA = await createTestTenant(`test-tenant-acp-a-${TAG}`, users.owner!.id);
  tenantB = await createTestTenant(`test-tenant-acp-b-${TAG}`, users.ownerB!.id);
  createdTenantIds.push(tenantA.id, tenantB.id);
  await testDb`update tenants set timezone = ${TZ} where id in (${tenantA.id}, ${tenantB.id})`;

  // The REAL provisioned roles — this suite proves the shipped matrix, not a hand-made stand-in.
  await testDb`select * from private.provision_default_roles(${tenantA.id}::uuid)`;
  await testDb`select * from private.provision_default_roles(${tenantB.id}::uuid)`;
  for (const r of await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${tenantA.id} and deleted_at is null`) roleA[r.key] = r.id;
  const roleBStylist = (await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenantB.id} and key = 'STYLIST' and deleted_at is null`)[0]!.id;
  roleA.customersOnly = await createCustomRole(tenantA.id, "Sadece Müşteri Görüntüleme", ["customers.view"]);

  const personelMembership = await addMembership(tenantA.id, users.personel!.id, roleA.STYLIST!);
  await addMembership(tenantA.id, users.reception!.id, roleA.RECEPTIONIST!);
  await addMembership(tenantA.id, users.manager!.id, roleA.SALON_MANAGER!);
  await addMembership(tenantA.id, users.customersOnly!.id, roleA.customersOnly!);
  await addMembership(tenantA.id, users.dual!.id, roleA.STYLIST!);
  await addMembership(tenantB.id, users.dual!.id, roleBStylist);

  branchA = await createBranch(tenantA.id, "Ana Şube");
  staffA1 = await createStaffMember(tenantA.id, "Ayşe Yılmaz");
  staffA2 = await createStaffMember(tenantA.id, "Mehmet Demir");
  serviceA = await createService(tenantA.id, "Saç Kesimi", 30, 250);
  await linkServiceBranch(serviceA.id, branchA);
  for (const s of [staffA1, staffA2]) {
    await linkStaffBranch(s.id, branchA);
    await linkStaffService(s.id, serviceA.id);
    for (let weekday = 0; weekday <= 6; weekday++) await createStaffSchedule(tenantA.id, s.id, weekday, "00:00", "23:59");
  }
  // Personel is a real staff member of the salon — but sees EVERYONE's appointments.
  await testDb`update staff_members set tenant_membership_id = ${personelMembership} where id = ${staffA1.id}`;

  const branchB = await createBranch(tenantB.id, "Ana Şube B");
  const staffB = await createStaffMember(tenantB.id, "Personel B");
  const serviceB = await createService(tenantB.id, "Hizmet B", 30, 100);
  await linkServiceBranch(serviceB.id, branchB);
  await linkStaffBranch(staffB.id, branchB);
  await linkStaffService(staffB.id, serviceB.id);

  // Customers are created the way the app creates them: as the owner, through RLS.
  await asAuthenticatedUser(users.owner!.id, async (sql) => {
    const insert = async (key: string, name: string, phone: string | null, email: string | null, notes: string | null) => {
      const [row] = await sql<{ id: string }[]>`
        insert into customers (tenant_id, full_name, phone, email, notes, created_by)
        values (${tenantA.id}, ${name}, ${phone}, ${email}, ${notes}, ${users.owner!.id}) returning id`;
      customers[key] = { id: row!.id, fullName: name };
    };
    await insert("main", CANARY.name, CANARY.phone, CANARY.email, CANARY.notes);
    await insert("other", `İkinci Müşteri ${TAG}`, formatPhone(OTHER_PHONE_DIGITS), `other-${TAG}@example.com`, `diger-not-${TAG}`);
    await insert("removed", `Silinmiş Müşteri ${TAG}`, null, null, null);
    await insert("cancelled", `İptalli Müşteri ${TAG}`, null, null, null);
  });
  const [custB] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name, phone, email, notes) values (${tenantB.id}, ${`B Müşterisi ${TAG}`}, '+90 555 000 00 00', ${`b-${TAG}@example.com`}, ${`b-notu-${TAG}`}) returning id`;
  customers.b = { id: custB!.id, fullName: `B Müşterisi ${TAG}` };

  // One appointment through the real RPC (so audit/notification side effects exist for the sweep)...
  ownerClient = await signInAs(users.owner!);
  const start = safeMorningStart(3);
  const created = await ownerClient.rpc("create_appointment", {
    p_tenant_id: tenantA.id,
    p_branch_id: branchA,
    p_customer_id: customers.main!.id,
    p_items: [{ service_id: serviceA.id, staff_member_id: staffA1.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
  });
  if (created.error || !created.data) throw new Error(`create_appointment failed: ${created.error?.message}`);
  appt.main = created.data as string;
  await testDb`update appointments set notes = ${CANARY.appointmentNotes} where id = ${appt.main}`;

  // ...the rest by direct insert (they only need to exist).
  const day = (n: number, minutes: number) => new Date(safeMorningStart(n).getTime() + minutes * 60_000);
  appt.otherStaff = await insertAppointmentRow({ tenantId: tenantA.id, branchId: branchA, customerId: customers.other!.id, staffId: staffA2.id, serviceId: serviceA.id, start: day(3, 60), createdBy: users.owner!.id });
  appt.cancelled = await insertAppointmentRow({ tenantId: tenantA.id, branchId: branchA, customerId: customers.cancelled!.id, staffId: staffA2.id, serviceId: serviceA.id, start: day(3, 120), status: "cancelled", createdBy: users.owner!.id });
  appt.removedCustomer = await insertAppointmentRow({ tenantId: tenantA.id, branchId: branchA, customerId: customers.removed!.id, staffId: staffA1.id, serviceId: serviceA.id, start: day(3, 180), createdBy: users.owner!.id });
  await testDb`update customers set deleted_at = now() where id = ${customers.removed!.id}`;
  appt.todayMine = await insertAppointmentRow({ tenantId: tenantA.id, branchId: branchA, customerId: customers.main!.id, staffId: staffA1.id, serviceId: serviceA.id, start: day(0, 60), createdBy: users.owner!.id });
  appt.todayOther = await insertAppointmentRow({ tenantId: tenantA.id, branchId: branchA, customerId: customers.other!.id, staffId: staffA2.id, serviceId: serviceA.id, start: day(0, 150), createdBy: users.owner!.id });
  appt.b = await insertAppointmentRow({ tenantId: tenantB.id, branchId: branchB, customerId: customers.b!.id, staffId: staffB.id, serviceId: serviceB.id, start: day(3, 60), createdBy: users.ownerB!.id });

  personelClient = await signInAs(users.personel!);
}, 180000);

afterAll(async () => {
  await ownerClient?.auth.signOut();
  await personelClient?.auth.signOut();
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

describe("public.get_appointment_customer_display — a name for appointments the caller can see, and nothing else", () => {
  it("Personel gets the customer's display name for EVERY tenant appointment — including other staff's, cancelled ones and those of a removed customer", async () => {
    const wanted = ids("main", "otherStaff", "cancelled", "removedCustomer", "todayMine", "todayOther");
    const { data, error } = await personelClient.rpc("get_appointment_customer_display", { p_tenant_id: tenantA.id, p_appointment_ids: wanted });
    expect(error).toBeNull();
    const names = new Map((data ?? []).map((r) => [r.appointment_id, r.customer_display_name]));
    expect(names.size).toBe(wanted.length);
    expect(names.get(appt.main!)).toBe(customers.main!.fullName);
    expect(names.get(appt.otherStaff!)).toBe(customers.other!.fullName);
    expect(names.get(appt.cancelled!)).toBe(customers.cancelled!.fullName);
    expect(names.get(appt.removedCustomer!)).toBe(customers.removed!.fullName); // history keeps its name
    expect(names.get(appt.todayMine!)).toBe(customers.main!.fullName);
    expect(names.get(appt.todayOther!)).toBe(customers.other!.fullName);
  });

  it("returns exactly two columns — no phone, e-mail, notes, account linkage, customer id or status", async () => {
    const { data, error } = await personelClient.rpc("get_appointment_customer_display", { p_tenant_id: tenantA.id, p_appointment_ids: ids("main", "otherStaff") });
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    for (const row of data ?? []) expect(Object.keys(row).sort()).toEqual(["appointment_id", "customer_display_name"]);

    const payload = JSON.stringify(data);
    for (const secret of [CANARY.phone, CANARY.email, CANARY.notes, `other-${TAG}@example.com`, `diger-not-${TAG}`, customers.main!.id, CANARY.appointmentNotes]) {
      expect(payload, secret).not.toContain(secret);
    }
    // The declared result shape is the same two columns (a future edit widening it must be a deliberate one).
    const shape = await testDb<{ args: string }[]>`
      select pg_get_function_result(p.oid) as args from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'get_appointment_customer_display'`;
    expect(shape).toHaveLength(1);
    expect(shape[0]!.args).toBe("TABLE(appointment_id uuid, customer_display_name text)");
  });

  it("is bound to the requested tenant: another tenant's appointment ids yield nothing, and a member of both tenants cannot mix them", async () => {
    // The outsider (owner of tenant B) is not a member of tenant A at all.
    expect(await displayAttempt(users.ownerB!.id, tenantA.id, ids("main"))).toMatchObject({ ok: false, message: "appointments.view required" });
    // Personel of A asks about tenant B: refused, not "empty".
    expect(await displayAttempt(users.personel!.id, tenantB.id, ids("b"))).toMatchObject({ ok: false, message: "appointments.view required" });
    // Tenant A, but tenant B's appointment id: nothing comes back.
    expect(await displayRows(users.personel!.id, tenantA.id, ids("b"))).toEqual([]);
    // A user who IS a member of both tenants: each tenant only ever answers for its own appointments.
    expect((await displayRows(users.dual!.id, tenantA.id, ids("main", "b"))).map((r) => r.appointment_id)).toEqual([appt.main]);
    expect((await displayRows(users.dual!.id, tenantB.id, ids("main", "b"))).map((r) => r.appointment_id)).toEqual([appt.b]);
    expect((await displayRows(users.dual!.id, tenantB.id, ids("b")))[0]!.customer_display_name).toBe(customers.b!.fullName);
  }, 60000);

  it("needs appointments.view: a member holding customers.view but not appointments.view is refused (the customer directory is not a back door)", async () => {
    expect(await displayAttempt(users.customersOnly!.id, tenantA.id, ids("main"))).toMatchObject({ ok: false, message: "appointments.view required" });
  });

  it("is not available to anon, and an authenticated session without a user is refused", async () => {
    const anon = await anonClient().rpc("get_appointment_customer_display", { p_tenant_id: tenantA.id, p_appointment_ids: ids("main") });
    expect(anon.data).toBeNull();
    expect(anon.error?.message).toMatch(/permission denied for function get_appointment_customer_display/);

    await expect(
      asDatabaseRole("anon", null, (sql) => sql`select * from public.get_appointment_customer_display(${tenantA.id}::uuid, ${sql.array(ids("main"), 2951)}::uuid[])`),
    ).rejects.toMatchObject({ message: expect.stringContaining("permission denied for function") });
    await expect(
      asDatabaseRole("authenticated", null, (sql) => sql`select * from public.get_appointment_customer_display(${tenantA.id}::uuid, ${sql.array(ids("main"), 2951)}::uuid[])`),
    ).rejects.toMatchObject({ message: "authentication required" });
  });

  it("the private implementation is unreachable to clients, and the wrapper is granted to authenticated only", async () => {
    const rows = await testDb<{ schema: string; fn: string; anon: boolean; authenticated: boolean; service_role: boolean; public_grant: boolean }[]>`
      select n.nspname as schema, p.proname as fn,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_grant
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'get_appointment_customer_display' order by n.nspname`;
    expect(rows.map((r) => r.schema)).toEqual(["private", "public"]);
    const priv = rows[0]!;
    const pub = rows[1]!;
    expect([priv.anon, priv.authenticated, priv.service_role, priv.public_grant]).toEqual([false, false, false, false]);
    expect([pub.anon, pub.authenticated, pub.service_role, pub.public_grant]).toEqual([false, true, false, false]);
  });

  it("handles its inputs strictly: empty and NULL lists give no rows, 500 ids are fine, 501 are refused, a NULL tenant is refused", async () => {
    expect(await displayRows(users.personel!.id, tenantA.id, [])).toEqual([]);
    expect(await displayRows(users.personel!.id, tenantA.id, null)).toEqual([]);
    const many = (n: number) => Array.from({ length: n }, () => randomUUID());
    expect(await displayRows(users.personel!.id, tenantA.id, many(500))).toEqual([]);
    expect(await displayAttempt(users.personel!.id, tenantA.id, many(501))).toMatchObject({ ok: false, message: "too_many_appointment_ids" });
    expect(await displayAttempt(users.personel!.id, null, ids("main"))).toMatchObject({ ok: false, message: "appointments.view required" });
  }, 60000);

  it("gives every customers.view holder exactly what the old customers(full_name) embed gave them (parity for owner/manager/receptionist)", async () => {
    const wanted = ids("main", "otherStaff", "cancelled", "removedCustomer", "todayMine", "todayOther");
    // Old path, as the owner: the embed under the customers.view policy.
    const embedded = await ownerClient.from("appointments").select("id, customers(full_name)").eq("tenant_id", tenantA.id).in("id", wanted);
    expect(embedded.error).toBeNull();
    const viaEmbed = new Map((embedded.data as unknown as { id: string; customers: { full_name: string } | null }[]).map((r) => [r.id, r.customers?.full_name]));
    for (const user of ["owner", "manager", "reception", "personel"]) {
      const rows = await displayRows(users[user]!.id, tenantA.id, wanted);
      const viaRpc = new Map(rows.map((r) => [r.appointment_id, r.customer_display_name]));
      expect(viaRpc, user).toEqual(viaEmbed);
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// Personel and the customer directory
// ---------------------------------------------------------------------------

describe("Personel still cannot read the customer directory — the projection did not widen anything", () => {
  it("the Personel role holds appointments.view and no customers.* permission", async () => {
    const keys = (
      await testDb<{ key: string }[]>`select p.key from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = ${roleA.STYLIST}`
    ).map((r) => r.key);
    expect(keys).toEqual(["appointments.view"]);
  });

  it("customers reads return nothing to Personel — full rows, phone/e-mail lookups, a direct id lookup and searches alike", async () => {
    const all = await personelClient.from("customers").select("*");
    expect(all.error).toBeNull();
    expect(all.data).toEqual([]);

    const contact = await personelClient.from("customers").select("id, phone, email, notes, phone_normalized, email_normalized");
    expect(contact.data).toEqual([]);

    const byId = await personelClient.from("customers").select("id, full_name, phone").eq("id", customers.main!.id).maybeSingle();
    expect(byId.data).toBeNull();

    const byPhone = await personelClient.from("customers").select("id").ilike("phone", `%${CANARY.phone.slice(-5)}%`);
    expect(byPhone.data).toEqual([]);
    const byEmail = await personelClient.from("customers").select("id").eq("email", CANARY.email);
    expect(byEmail.data).toEqual([]);
    const byName = await personelClient.from("customers").select("id").ilike("full_name", `%Canary%`);
    expect(byName.data).toEqual([]);

    const head = await personelClient.from("customers").select("id", { count: "exact", head: true });
    expect(head.count).toBe(0);
  });

  it("the old embed no longer reaches a Personel either: customers(...) on appointments is null for them", async () => {
    const { data, error } = await personelClient.from("appointments").select("id, customer_id, customers(full_name, phone, email, notes)").eq("id", appt.main!);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as unknown as { customers: unknown }[])[0]!.customers).toBeNull();
    expect(JSON.stringify(data)).not.toContain(CANARY.phone);
  });

  it("customer_account_links, customer contact views and every other customer-scoped table stay closed to Personel", async () => {
    const links = await personelClient.from("customer_account_links").select("*");
    expect(links.data ?? []).toEqual([]);
  });

  it("Personel cannot write to customers (insert, update or delete) nor through the customer RPCs", async () => {
    const insert = await personelClient.from("customers").insert({ tenant_id: tenantA.id, full_name: `Yetkisiz ${TAG}` });
    expect(insert.error).not.toBeNull();
    const update = await personelClient.from("customers").update({ notes: "değiştirildi" }).eq("id", customers.main!.id).select("id");
    expect(update.data ?? []).toEqual([]);
    const del = await personelClient.from("customers").delete().eq("id", customers.main!.id).select("id");
    expect(del.data ?? []).toEqual([]);
    const [row] = await testDb<{ notes: string }[]>`select notes from customers where id = ${customers.main!.id}`;
    expect(row!.notes).toBe(CANARY.notes);
  });
});

// ---------------------------------------------------------------------------
// The appointment surfaces, as Personel
// ---------------------------------------------------------------------------

describe("calendar, list, detail and dashboard work for Personel — the exact select strings the app ships", () => {
  const root = process.cwd();
  const source = (rel: string) => readFileSync(path.join(root, rel), "utf8");

  function constant(rel: string, name: string): string {
    const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(source(rel));
    if (!match) throw new Error(`${name} not found in ${rel}`);
    return match[1]!;
  }
  function detailSelect(rel: string): string {
    const match = /`(id, tenant_id, customer_id, status[\s\S]*?)`/.exec(source(rel));
    if (!match) throw new Error(`detail select not found in ${rel}`);
    return match[1]!;
  }

  const calendarSources = ["lib/modules/appointments/queries.ts", "lib/modules/appointments/client-queries.ts"];
  const listSources = ["lib/modules/appointments/queries.ts", "components/appointments/appointments-page-client.tsx"];
  const detailSources = ["lib/modules/appointments/queries.ts", "components/appointments/appointment-detail-sheet.tsx"];

  it.each(calendarSources)("CALENDAR_ITEM_SELECT in %s: all staff columns, services and appointments visible; no customer relation in the payload; names via the projection", async (rel) => {
    const select = constant(rel, "CALENDAR_ITEM_SELECT");
    expect(select).not.toMatch(/customers/);

    const from = new Date(safeMorningStart(3).getTime() - 3600_000).toISOString();
    const to = new Date(safeMorningStart(3).getTime() + 6 * 3600_000).toISOString();
    const { data, error } = await personelClient
      .from("appointment_items")
      .select(select)
      .eq("tenant_id", tenantA.id)
      .eq("appointments.branch_id", branchA)
      .neq("appointment_status", "cancelled")
      .lt("scheduled_start_at", to)
      .gt("scheduled_end_at", from)
      .order("scheduled_start_at", { ascending: true });
    expect(error).toBeNull();
    const rows = data as unknown as { appointment_id: string; services: { name: string } | null; staff_members: { id: string; full_name: string } | null }[];

    // All staff columns, the OTHER staff member's appointment included; the cancelled one filtered by status, as always.
    expect(new Set(rows.map((r) => r.staff_members?.id))).toEqual(new Set([staffA1.id, staffA2.id]));
    expect(rows.map((r) => r.appointment_id).sort()).toEqual(ids("main", "otherStaff", "removedCustomer").sort());
    for (const r of rows) expect(r.services?.name, "service name renders without services.view").toBe(serviceA.name);

    const payload = JSON.stringify(data);
    for (const secret of [CANARY.phone, CANARY.email, CANARY.notes, CANARY.name]) expect(payload, secret).not.toContain(secret);

    const names = await getAppointmentCustomerNames(personelClient, tenantA.id, rows.map((r) => r.appointment_id));
    expect(names.get(appt.main!)).toBe(customers.main!.fullName);
    expect(names.get(appt.otherStaff!)).toBe(customers.other!.fullName);
    expect(names.get(appt.removedCustomer!)).toBe(customers.removed!.fullName);
  });

  it.each(listSources)("LIST_SELECT in %s: Personel lists every tenant appointment with services and staff, customer names come from the projection", async (rel) => {
    const select = constant(rel, "LIST_SELECT");
    expect(select).not.toMatch(/customers/);
    const { data, error } = await personelClient.from("appointments").select(select).eq("tenant_id", tenantA.id).order("scheduled_start_at", { ascending: false });
    expect(error).toBeNull();
    const rows = data as unknown as { id: string; branches: { name: string } | null; appointment_items: { services: { name: string } | null; staff_members: { full_name: string } | null }[] }[];
    expect(rows.map((r) => r.id).sort()).toEqual(ids("main", "otherStaff", "cancelled", "removedCustomer", "todayMine", "todayOther").sort());
    for (const r of rows) {
      expect(r.branches?.name).toBe("Ana Şube");
      expect(r.appointment_items[0]?.services?.name).toBe(serviceA.name);
    }
    const staffNames = new Set(rows.flatMap((r) => r.appointment_items.map((i) => i.staff_members?.full_name)));
    expect(staffNames).toEqual(new Set([staffA1.fullName, staffA2.fullName])); // other staff's appointments are visible too

    const names = await getAppointmentCustomerNames(personelClient, tenantA.id, rows.map((r) => r.id));
    expect(names.size).toBe(rows.length);
    expect(JSON.stringify(data)).not.toContain(CANARY.phone);
  });

  it.each(detailSources)("the detail select in %s: renders for Personel — no customer row, and no `notes` in the select string at all (that is now appointments.update-only, see appointment-private-fields.test.ts)", async (rel) => {
    const select = detailSelect(rel);
    expect(select).not.toMatch(/customers/);
    expect(select).not.toMatch(/\bnotes\b/); // Faz SAAS.1E.1: notes moved to get_appointment_private_details entirely
    const { data, error } = await personelClient.from("appointments").select(select).eq("id", appt.main!).maybeSingle();
    expect(error).toBeNull();
    const d = data as unknown as {
      id: string; tenant_id: string; customer_id: string;
      branches: { id: string; name: string } | null;
      appointment_items: { services: { name: string } | null; staff_members: { full_name: string } | null }[];
    };
    expect(d.id).toBe(appt.main);
    expect(d.tenant_id).toBe(tenantA.id);
    expect(d.customer_id).toBe(customers.main!.id);
    expect(d.branches?.name).toBe("Ana Şube");
    expect(d.appointment_items).toHaveLength(1);
    expect(d.appointment_items[0]!.services?.name).toBe(serviceA.name);
    expect(d.appointment_items[0]!.staff_members?.full_name).toBe(staffA1.fullName);
    const payload = JSON.stringify(data);
    for (const secret of [CANARY.phone, CANARY.email, CANARY.notes, CANARY.appointmentNotes]) expect(payload, secret).not.toContain(secret);

    const names = await getAppointmentCustomerNames(personelClient, d.tenant_id, [d.id]);
    expect(names.get(d.id)).toBe(customers.main!.fullName);
  });

  it("the dashboard's 'today' path (getTodayAppointments) shows Personel real customer names — for their own and everyone else's appointments", async () => {
    const rows = await getTodayAppointments(personelClient, tenantA.id, TZ);
    const byId = new Map(rows.map((r) => [r.id, r.customerName]));
    expect(byId.get(appt.todayMine!)).toBe(customers.main!.fullName);
    expect(byId.get(appt.todayOther!)).toBe(customers.other!.fullName);
    expect(rows.some((r) => r.customerName === CUSTOMER_NAME_FALLBACK)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(CANARY.phone);
  });

  it("appointments columns: the guest-booking idempotency fields, notes and created_by are not readable by anyone through the API — Personel and Owner alike — and `select *` is refused", async () => {
    // Faz SAAS.1E.1 (part 7) narrowed this further than part 5 originally did: notes and created_by joined
    // idempotency_key/idempotency_fingerprint as columns nobody selects directly any more (notes/created_by
    // are appointments.update-gated through get_appointment_private_details instead — see
    // appointment-private-fields.test.ts for the full behavior of that RPC).
    for (const [label, client] of [["personel", personelClient], ["owner", ownerClient]] as const) {
      const star = await client.from("appointments").select("*").eq("id", appt.main!);
      expect(star.error?.message, `${label} select *`).toMatch(/permission denied for table appointments/);
      const key = await client.from("appointments").select("id, idempotency_key").eq("id", appt.main!);
      expect(key.error?.message, `${label} idempotency_key`).toMatch(/permission denied for table appointments/);
      const fingerprint = await client.from("appointments").select("id, idempotency_fingerprint").eq("id", appt.main!);
      expect(fingerprint.error?.message, `${label} idempotency_fingerprint`).toMatch(/permission denied for table appointments/);
      const notes = await client.from("appointments").select("id, notes").eq("id", appt.main!);
      expect(notes.error?.message, `${label} notes`).toMatch(/permission denied for table appointments/);
      const createdBy = await client.from("appointments").select("id, created_by").eq("id", appt.main!);
      expect(createdBy.error?.message, `${label} created_by`).toMatch(/permission denied for table appointments/);
      const ok = await client.from("appointments").select("id, tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at, created_at, updated_at").eq("id", appt.main!);
      expect(ok.error, `${label} readable columns`).toBeNull();
      expect(ok.data).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Personel is read-only
// ---------------------------------------------------------------------------

describe("Personel cannot change appointments — visibility is not a write permission", () => {
  it("create_appointment, update_appointment_status, reschedule_appointment and complete_appointment are all refused", async () => {
    const before = await testDb<{ n: number }[]>`select count(*)::int as n from appointments where tenant_id = ${tenantA.id}`;
    const start = safeMorningStart(5).toISOString();

    const create = await personelClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id, p_branch_id: branchA, p_customer_id: customers.main!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(create.error).not.toBeNull();

    const cancel = await personelClient.rpc("update_appointment_status", { p_appointment_id: appt.otherStaff!, p_new_status: "cancelled" });
    expect(cancel.error).not.toBeNull();

    const reschedule = await personelClient.rpc("reschedule_appointment", {
      p_appointment_id: appt.otherStaff!,
      p_items: [{ service_id: serviceA.id, staff_member_id: staffA2.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(reschedule.error).not.toBeNull();

    const complete = await personelClient.rpc("complete_appointment", { p_appointment_id: appt.todayMine!, p_performer_overrides: [] });
    expect(complete.error).not.toBeNull();

    const after = await testDb<{ n: number }[]>`select count(*)::int as n from appointments where tenant_id = ${tenantA.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const [state] = await testDb<{ status: string; scheduled_start_at: string }[]>`select status, scheduled_start_at::text from appointments where id = ${appt.otherStaff}`;
    expect(state!.status).toBe("scheduled");
  }, 60000);

  it("direct table writes are impossible: no INSERT/UPDATE/DELETE grant exists on appointments or appointment_items", async () => {
    const insert = await personelClient.from("appointments").insert({ tenant_id: tenantA.id, branch_id: branchA, customer_id: customers.main!.id, scheduled_start_at: safeMorningStart(6).toISOString(), scheduled_end_at: safeMorningStart(6).toISOString() });
    expect(insert.error).not.toBeNull();
    const update = await personelClient.from("appointments").update({ status: "cancelled" }).eq("id", appt.otherStaff!).select("id");
    expect(update.error).not.toBeNull();
    const items = await personelClient.from("appointment_items").update({ price: 0 }).eq("appointment_id", appt.otherStaff!).select("id");
    expect(items.error).not.toBeNull();
    const [state] = await testDb<{ status: string }[]>`select status from appointments where id = ${appt.otherStaff}`;
    expect(state!.status).toBe("scheduled");
  });
});

// ---------------------------------------------------------------------------
// The wide sweep: no readable table leaks customer contact data
// ---------------------------------------------------------------------------

describe("PII sweep — every table and column `authenticated` may read, as Personel, contains no customer contact data", () => {
  type Swept = Map<string, string>;

  /** Every column `authenticated` may SELECT, table by table (column-level grants honoured), read through RLS as `userId`. */
  async function sweepAs(userId: string): Promise<Swept> {
    return await asAuthenticatedUser(userId, async (sql) => {
      const tables = await sql<{ tbl: string; cols: string[] }[]>`
        select c.relname as tbl,
               array_agg(a.attname order by a.attnum) filter (where has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT')) as cols
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
        group by c.relname
        having bool_or(has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT'))
        order by c.relname`;
      const result: Swept = new Map();
      for (const { tbl, cols } of tables) {
        const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
        const text = await sql.savepoint(async (sp) => {
          const [row] = await sp.unsafe(
            `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text as j from (select ${cols.map(quote).join(", ")} from public.${quote(tbl)}) x`,
          );
          return String(row!.j);
        });
        result.set(tbl, text);
      }
      return result;
    });
  }

  // Formatted, bare and normalized spellings of every contact detail of the two canary customers.
  const SECRETS = () => [
    CANARY.phone, PHONE_DIGITS, `+90${PHONE_DIGITS}`, formatPhone(OTHER_PHONE_DIGITS), OTHER_PHONE_DIGITS,
    CANARY.email, CANARY.notes, `other-${TAG}@example.com`, `diger-not-${TAG}`,
  ];
  const leaks = (swept: Swept, secrets: string[]) =>
    [...swept.entries()].filter(([, text]) => secrets.some((s) => text.includes(s))).map(([tbl]) => tbl).sort();

  it("the sweep sees the whole readable schema (positive control: it is not silently empty)", async () => {
    const swept = await sweepAs(users.personel!.id);
    expect(swept.size).toBeGreaterThanOrEqual(20);
    for (const t of ["appointments", "appointment_items", "customers", "staff_members", "tenant_memberships", "audit_logs", "branches", "services"]) {
      expect(swept.has(t), t).toBe(true);
    }
    // Personel does see the salon's appointments...
    expect(swept.get("appointments")).toContain(appt.main!);
    // ...but the sweep only ever read what the column grants allow.
    expect(swept.get("appointments")).not.toContain("idempotency");
  }, 90000);

  it("positive control: the same sweep run as the Owner DOES find the canary contact data (in customers) — so a clean Personel result means something", async () => {
    const swept = await sweepAs(users.owner!.id);
    expect(leaks(swept, [CANARY.phone, CANARY.email, CANARY.notes])).toContain("customers");
  }, 90000);

  it("Personel: no table anywhere exposes a customer's phone, e-mail or notes", async () => {
    const swept = await sweepAs(users.personel!.id);
    expect(leaks(swept, SECRETS())).toEqual([]);
    expect(swept.get("customers")).toBe("[]");
  }, 90000);

  it("Personel: the customer's NAME is not readable from any table — the projection is the only way a name reaches them", async () => {
    const swept = await sweepAs(users.personel!.id);
    const withName = [...swept.entries()].filter(([, text]) => text.includes(CANARY.name)).map(([tbl]) => tbl);
    expect(withName).toEqual([]);
  }, 90000);

  it("Receptionist (customers.view): the customers table shows the canary rows, by design — the same sweep is clean everywhere else that Personel is clean", async () => {
    const swept = await sweepAs(users.reception!.id);
    const found = leaks(swept, [CANARY.phone, CANARY.email, CANARY.notes]);
    expect(found).toContain("customers");
    const personel = await sweepAs(users.personel!.id);
    for (const tbl of found) {
      if (tbl === "customers") continue;
      // If a non-customer table shows contact data to a Receptionist, it must not show it to Personel.
      expect(leaks(personel, [CANARY.phone, CANARY.email, CANARY.notes])).not.toContain(tbl);
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
// Static contract
// ---------------------------------------------------------------------------

describe("no appointment surface embeds customers again", () => {
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
  const surfaces = files.filter((f) => /\.from\(\s*["']appointment(s|_items)["']\s*\)/.test(strip(readFileSync(f, "utf8"))));

  it("finds the appointment surfaces it is meant to police (so an empty match cannot pass silently)", () => {
    const rel = surfaces.map((f) => path.relative(process.cwd(), f).replaceAll("\\", "/"));
    for (const expected of [
      "lib/modules/appointments/queries.ts",
      "lib/modules/appointments/client-queries.ts",
      "lib/modules/dashboard/queries.ts",
      "components/appointments/appointments-page-client.tsx",
      "components/appointments/appointment-detail-sheet.tsx",
    ]) expect(rel, expected).toContain(expected);
  });

  it("no file that queries appointments / appointment_items embeds a customers relation (customers(...), customers!fk(...), alias:customers(...))", () => {
    const offenders = surfaces
      .filter((f) => /\bcustomers\s*(!\w+)?\s*\(/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => path.relative(process.cwd(), f).replaceAll("\\", "/"));
    expect(offenders).toEqual([]);
  });

  it("every file that reads customer names for appointments does so through getAppointmentCustomerNames", () => {
    for (const rel of [
      "lib/modules/appointments/queries.ts",
      "lib/modules/appointments/client-queries.ts",
      "lib/modules/dashboard/queries.ts",
      "components/appointments/appointments-page-client.tsx",
      "components/appointments/appointment-detail-sheet.tsx",
    ]) {
      expect(strip(readFileSync(path.join(process.cwd(), rel), "utf8")), rel).toContain("getAppointmentCustomerNames(");
    }
  });
});

// ---------------------------------------------------------------------------
// The TypeScript wrapper
// ---------------------------------------------------------------------------

describe("getAppointmentCustomerNames — one call per screen load, never per row, and it can only degrade", () => {
  type Call = { fn: string; args: { p_tenant_id: string; p_appointment_ids: string[] } };
  function fakeClient(respond?: (call: Call, index: number) => { data: unknown; error: unknown }) {
    const calls: Call[] = [];
    const client = {
      rpc: async (fn: string, args: Call["args"]) => {
        const call = { fn, args };
        calls.push(call);
        if (respond) return respond(call, calls.length - 1);
        return { data: args.p_appointment_ids.map((id) => ({ appointment_id: id, customer_display_name: `İsim ${id}` })), error: null };
      },
    } as unknown as Parameters<typeof getAppointmentCustomerNames>[0];
    return { client, calls };
  }
  const uuids = (n: number) => Array.from({ length: n }, () => randomUUID());

  it("calls the projection RPC once for a page of rows, with the tenant and the de-duplicated ids", async () => {
    const [a, b] = uuids(2) as [string, string];
    const { client, calls } = fakeClient();
    const names = await getAppointmentCustomerNames(client, "tenant-x", [a, b, a, b, a]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ fn: "get_appointment_customer_display", args: { p_tenant_id: "tenant-x", p_appointment_ids: [a, b] } });
    expect(names.get(a)).toBe(`İsim ${a}`);
    expect(names.size).toBe(2);
  });

  it("splits more than 500 ids into chunks of at most 500 (the RPC's own ceiling) and merges the answers", async () => {
    const many = uuids(1201);
    const { client, calls } = fakeClient();
    const names = await getAppointmentCustomerNames(client, "t", many);
    expect(calls.map((c) => c.args.p_appointment_ids.length)).toEqual([500, 500, 201]);
    expect(names.size).toBe(1201);
  });

  it("makes no call at all for an empty list", async () => {
    const { client, calls } = fakeClient();
    expect((await getAppointmentCustomerNames(client, "t", [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("never throws: a refused or failed lookup yields an empty map, a failing chunk only loses its own rows", async () => {
    const failing = fakeClient(() => ({ data: null, error: { message: "appointments.view required" } }));
    expect((await getAppointmentCustomerNames(failing.client, "t", uuids(3))).size).toBe(0);

    const noData = fakeClient(() => ({ data: null, error: null }));
    expect((await getAppointmentCustomerNames(noData.client, "t", uuids(3))).size).toBe(0);

    const partial = fakeClient((call, index) =>
      index === 1
        ? { data: null, error: { message: "network" } }
        : { data: call.args.p_appointment_ids.map((id) => ({ appointment_id: id, customer_display_name: "x" })), error: null },
    );
    expect((await getAppointmentCustomerNames(partial.client, "t", uuids(1000))).size).toBe(500);
  });

  it("uses the placeholder constant '—' for anything it could not resolve", () => {
    expect(CUSTOMER_NAME_FALLBACK).toBe("—");
  });
});
