import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  signInAs,
  createTestTenant,
  createTestUser,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
} from "./helpers";

/**
 * Faz 2G.2B.1 — closes a real, empirically-confirmed vulnerability
 * introduced by 20260823205200: private.validate_and_insert_appointment_item
 * read OPTIONAL duration_minutes/price keys off the item jsonb to
 * support reschedule snapshot preservation, but create_appointment/
 * create_guest_booking pass their caller's own p_items essentially
 * unfiltered into that function — a crafted p_items entry
 * ({..., "duration_minutes": 1, "price": 1}) was stored verbatim,
 * confirmed via a real RPC call as a real signed-in user before this
 * migration existed. Fixed in 20260824055133 by making the override an
 * explicit SQL parameter, never a jsonb field read from arbitrary
 * caller input, plus explicit key-stripping in reschedule_appointment's
 * own merge. Every test here drives the exact same reachable surface a
 * real attacker would use — the real RPC, as a real signed-in user —
 * not a direct private.* call, since the point is proving the boundary
 * holds at the only place a client can actually reach.
 */

let owner: TestUser;
let tenant: { id: string; slug: string };
let branchId: string;

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3600_000);
}

/** Local 08:00 (Europe/Istanbul, UTC+3, no DST) N days out — same helper
 * and same reasoning as customer-reschedule.test.ts's own copy: a fixed
 * hoursFromNow start+delta pair is a genuine latent flake whenever the
 * resulting local time happens to cross midnight (staff_is_available's
 * own pre-existing, unrelated guard), which depends only on what time of
 * day the suite happens to run. Used only where a test doesn't actually
 * need real-clock cutoff relativity. */
function safeMorningStart(daysFromNow: number): Date {
  const tzOffsetMs = 3 * 3600_000;
  const localNow = new Date(Date.now() + tzOffsetMs);
  const localMorning = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + daysFromNow, 8, 0, 0));
  return new Date(localMorning.getTime() - tzOffsetMs);
}

async function makeStaffAndService(durationMinutes: number, price: number) {
  const staff = await createStaffMember(tenant.id, `Trust Staff ${crypto.randomUUID().slice(0, 8)}`);
  const service = await createService(tenant.id, `Trust Service ${crypto.randomUUID().slice(0, 8)}`, durationMinutes, price);
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${branchId})`;
  await testDb`insert into service_branches (service_id, branch_id) values (${service.id}, ${branchId})`;
  await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${service.id})`;
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenant.id, staff.id, weekday, "00:00", "23:59");
  }
  return { staff, service };
}

beforeAll(async () => {
  owner = await createTestUser("p2g2b1-owner");
  const tenantRow = await createTestTenant("test-p2g2b1-trust", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug };
  branchId = await createBranch(tenant.id, "Trust Branch");
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id]);
});

describe("new staff booking — create_appointment cannot be repriced by the caller", () => {
  it("service = 1100/60, malicious payload sends price=1/duration=1, stored snapshot is the authoritative 1100/60", async () => {
    const { staff, service } = await makeStaffAndService(60, 1100);
    const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Trust Customer 1') returning id`;
    const start = hoursFromNow(48);

    const client = await signInAs(owner);
    const { data: appointmentId, error } = await client.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customer!.id,
      // Deliberately malicious extra fields — p_items is typed as Json,
      // so TypeScript doesn't reject them either; the DB is the real
      // boundary being tested here, not the type system.
      p_items: [{ service_id: service.id, staff_member_id: staff.id, scheduled_start_at: start.toISOString(), duration_minutes: 1, price: 1 }],
    });
    await client.auth.signOut();
    expect(error).toBeNull();

    const [item] = await testDb<{ duration_minutes: number; price: string; scheduled_start_at: string; scheduled_end_at: string }[]>`
      select duration_minutes, price, scheduled_start_at, scheduled_end_at from appointment_items where appointment_id = ${appointmentId}`;
    expect(item!.duration_minutes).toBe(60);
    expect(Number(item!.price)).toBe(1100);
    const durationMs = new Date(item!.scheduled_end_at).getTime() - new Date(item!.scheduled_start_at).getTime();
    expect(durationMs).toBe(60 * 60_000); // scheduled_end_at follows the authoritative duration, not the malicious one
  });
});

describe("new guest booking — no field exists to inject a snapshot through", () => {
  it("public.create_guest_booking's signature has no duration/price parameter at all — structurally, not just behaviorally, unreachable", async () => {
    const rows = await testDb<{ args: string }[]>`
      select pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'create_guest_booking'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.args).not.toMatch(/duration|price/i);
  });

  it("a real guest booking through the booking_gateway role still stores the authoritative catalog price/duration", async () => {
    const { staff, service } = await makeStaffAndService(45, 900);
    const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
    await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenant.id}, ${feature!.id}, true) on conflict do nothing`;
    const start = hoursFromNow(50);

    const [result] = await testDb<{ create_guest_booking: Record<string, unknown> }[]>`
      select public.create_guest_booking(
        ${tenant.slug}, ${branchId}::uuid, ${service.id}::uuid, ${start.toISOString()}::timestamptz,
        'Guest Trust Test', '5559990000', ${staff.id}::uuid, null, ${crypto.randomUUID()}::uuid, null
      )`;
    const appointmentId = (result!.create_guest_booking as { appointmentReference: string }).appointmentReference;

    const [item] = await testDb<{ duration_minutes: number; price: string }[]>`
      select duration_minutes, price from appointment_items where appointment_id = ${appointmentId}`;
    expect(item!.duration_minutes).toBe(45);
    expect(Number(item!.price)).toBe(900);
  });
});

describe("staff reschedule — same service — cannot be repriced by the caller", () => {
  it("old snapshot 900/45, catalog changed to 1100/60, malicious reschedule payload sends 1/1, result stays 900/45", async () => {
    const { staff, service } = await makeStaffAndService(45, 900);
    const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Trust Customer 2') returning id`;
    // safeMorningStart, not hoursFromNow — same reasoning as the other
    // fix further down in this file: a fixed +60h/+62h pair is a latent
    // flake whenever it crosses local midnight (staff_is_available's
    // own pre-existing, unrelated guard), which depends only on what
    // time of day the suite happens to run. This test asserts snapshot
    // preservation, not cutoff timing, so it doesn't need real-clock
    // relativity.
    const start = safeMorningStart(1);
    const end = new Date(start.getTime() + 45 * 60_000);
    const [appt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${customer!.id}, 'scheduled', ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${appt!.id}, ${service.id}, ${staff.id}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 45, 900, 1)`;

    // Catalog changes AFTER booking — the classic snapshot scenario.
    await testDb`update services set duration_minutes = 60, price = 1100 where id = ${service.id}`;

    const newStart = new Date(start.getTime() + 2 * 3600_000);
    const client = await signInAs(owner);
    const { error } = await client.rpc("reschedule_appointment", {
      p_appointment_id: appt!.id,
      // Malicious extra fields, same service_id (unchanged) — p_items is typed as Json
      p_items: [{ service_id: service.id, staff_member_id: staff.id, scheduled_start_at: newStart.toISOString(), sequence: 1, duration_minutes: 1, price: 1 }],
    });
    await client.auth.signOut();
    expect(error).toBeNull();

    const [item] = await testDb<{ duration_minutes: number; price: string; scheduled_start_at: string; scheduled_end_at: string }[]>`
      select duration_minutes, price, scheduled_start_at, scheduled_end_at from appointment_items where appointment_id = ${appt!.id}`;
    expect(item!.duration_minutes).toBe(45); // preserved snapshot, NOT the malicious 1, NOT the new catalog 60
    expect(Number(item!.price)).toBe(900); // preserved snapshot, NOT the malicious 1, NOT the new catalog 1100
    const durationMs = new Date(item!.scheduled_end_at).getTime() - new Date(item!.scheduled_start_at).getTime();
    expect(durationMs).toBe(45 * 60_000);
  });
});

describe("staff reschedule — service changed — authoritative new-service pricing, never the caller's number", () => {
  it("old service 900/45, intentionally switched to a new service 1500/75, caller attempts an arbitrary snapshot, result is the authoritative 1500/75", async () => {
    const { staff: oldStaff, service: oldService } = await makeStaffAndService(45, 900);
    const { staff: newStaff, service: newService } = await makeStaffAndService(75, 1500);
    const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Trust Customer 3') returning id`;
    const start = hoursFromNow(70);
    const end = new Date(start.getTime() + 45 * 60_000);
    const [appt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${customer!.id}, 'scheduled', ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${appt!.id}, ${oldService.id}, ${oldStaff.id}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 45, 900, 1)`;

    const newStart = hoursFromNow(72);
    const client = await signInAs(owner);
    const { error } = await client.rpc("reschedule_appointment", {
      p_appointment_id: appt!.id,
      // DIFFERENT service_id (a real swap) plus a malicious snapshot attempt — p_items is typed as Json
      p_items: [{ service_id: newService.id, staff_member_id: newStaff.id, scheduled_start_at: newStart.toISOString(), sequence: 1, duration_minutes: 1, price: 1 }],
    });
    await client.auth.signOut();
    expect(error).toBeNull();

    const [item] = await testDb<{ duration_minutes: number; price: string; service_id: string; scheduled_start_at: string; scheduled_end_at: string }[]>`
      select duration_minutes, price, service_id, scheduled_start_at, scheduled_end_at from appointment_items where appointment_id = ${appt!.id}`;
    expect(item!.service_id).toBe(newService.id);
    expect(item!.duration_minutes).toBe(75); // the NEW service's authoritative duration, not 1, not the old 45
    expect(Number(item!.price)).toBe(1500); // the NEW service's authoritative price, not 1, not the old 900
    const durationMs = new Date(item!.scheduled_end_at).getTime() - new Date(item!.scheduled_start_at).getTime();
    expect(durationMs).toBe(75 * 60_000);
  });
});

describe("customer reschedule — no field exists to inject a snapshot through", () => {
  it("public.reschedule_my_appointment's signature has no duration/price/item parameter at all", async () => {
    const rows = await testDb<{ args: string }[]>`
      select pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'reschedule_my_appointment'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.args).toBe("p_appointment_id uuid, p_new_start_at timestamp with time zone");
  });

  it("a real customer reschedule preserves the original snapshot unchanged, even after a catalog price change", async () => {
    const { staff, service } = await makeStaffAndService(30, 200);
    const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Trust Customer 4') returning id`;
    const custAuth = await createTestUser("p2g2b1-cust");
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${custAuth.id}, ${tenant.id}, ${customer!.id}, 'future_booking', true)`;
    await testDb`update tenants set customer_reschedule_enabled = true, customer_reschedule_cutoff_minutes = 0 where id = ${tenant.id}`;

    // safeMorningStart, not hoursFromNow: this test asserts snapshot
    // preservation, not cutoff timing, so it doesn't need real-clock
    // relativity — and a fixed +80h/+82h pair is a genuine latent flake
    // (reproduced independently: crosses local midnight on some runs,
    // tripping staff_is_available's own pre-existing, unrelated
    // midnight-crossing guard purely by wall-clock coincidence).
    const start = safeMorningStart(1);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [appt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${customer!.id}, 'scheduled', ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${appt!.id}, ${service.id}, ${staff.id}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 30, 200, 1)`;

    await testDb`update services set duration_minutes = 999, price = 99999 where id = ${service.id}`;

    const client = await signInAs(custAuth);
    const { error } = await client.rpc("reschedule_my_appointment", { p_appointment_id: appt!.id, p_new_start_at: new Date(start.getTime() + 2 * 3600_000).toISOString() });
    await client.auth.signOut();
    expect(error).toBeNull();

    const [item] = await testDb<{ duration_minutes: number; price: string }[]>`select duration_minutes, price from appointment_items where appointment_id = ${appt!.id}`;
    expect(item!.duration_minutes).toBe(30);
    expect(Number(item!.price)).toBe(200);

    await cleanupUsers([custAuth.id]);
  });
});

describe("caller inventory — a future new caller cannot silently gain the snapshot-preserve mechanism", () => {
  it("exactly the expected set of functions reference validate_and_insert_appointment_item in their body", async () => {
    // MATERIALIZED forces the namespace/prokind filter to run BEFORE
    // pg_get_functiondef is ever called — without it, the planner may
    // call pg_get_functiondef on an aggregate function's oid first
    // (found empirically: raises "X is an aggregate function", since
    // aggregates have no plain function definition to render), before
    // the cheaper filters get a chance to exclude it.
    const rows = await testDb<{ name: string }[]>`
      with candidates as materialized (
        select p.oid, p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prokind = 'f'
      )
      select proname as name from candidates
      where pg_get_functiondef(oid) ilike '%validate_and_insert_appointment_item%'
        and proname <> 'validate_and_insert_appointment_item'`;
    const callers = rows.map((r) => r.name).sort();
    // create_appointment/create_guest_booking pass no override (always
    // live pricing); replace_appointment_items is the only caller that
    // ever forwards a non-null override, and only for items its own
    // callers (reschedule_appointment, reschedule_my_appointment) have
    // already made trustworthy. Any new name appearing here means a new
    // caller was added without this test being deliberately updated —
    // exactly the "explicit decision required" property asked for.
    expect(callers).toEqual(["create_appointment", "create_guest_booking", "replace_appointment_items"]);
  });

  it("validate_and_insert_appointment_item has exactly one overload, at the new 7-arg signature", async () => {
    const rows = await testDb<{ nargs: number }[]>`
      select p.pronargs as nargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'validate_and_insert_appointment_item'`;
    expect(rows).toEqual([{ nargs: 7 }]);
  });
});
