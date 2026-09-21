import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  asDatabaseRole,
  attemptAs,
  auditRows,
  cleanupTenants,
  cleanupUsers,
  createCustomRole,
  createStaffMember,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.0 — staff <-> membership link security (F).
 *
 * staff_members.tenant_membership_id may be CHANGED only from trusted
 * (definer) context: link_staff_membership / unlink_staff_membership /
 * remove_membership_access / accept_team_invitation. The guard is the
 * BEFORE INSERT/UPDATE OF trigger staff_members_membership_link_guard,
 * which trusts a write only if current_user is a member of `postgres`.
 * PostgREST executes every client request as authenticated/anon, so no
 * client-controlled flag exists to spoof — the "cannot bypass" block below
 * proves that with real signed-in clients, a client sending spoofed
 * headers, the set_config route, role-level SQL evidence, and an allowlist
 * of the ONLY functions in the schema permitted to write the link.
 *
 * A write that leaves the value UNCHANGED still passes: the currently
 * deployed Personnel forms always resend the column, and that must keep
 * working while this ships.
 */

const MANAGER_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update", "customers.link_account",
  "reports.basic", "reports.staff", "schedules.view", "schedules.manage",
  "services.view", "services.manage", "staff.view", "staff.manage",
];
const LOWER_KEYS = ["appointments.view", "customers.view"];

let tenant: TestTenant;
let tenantB: TestTenant;

const users: Record<string, TestUser> = {};
const membershipOf: Record<string, string> = {};
const staffOf: Record<string, string> = {};
const roleOf: Record<string, string> = {};

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

let ownerClient: SupabaseClient;
let managerClient: SupabaseClient;

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`sml-${label}`);
  createdUserIds.push(user.id);
  users[label] = user;
  return user;
}

async function linkOf(staffId: string): Promise<string | null> {
  const [row] = await testDb<{ tenant_membership_id: string | null }[]>`
    select tenant_membership_id from staff_members where id = ${staffId}`;
  return row!.tenant_membership_id;
}

/** Privileged reset (the database owner is a trusted writer of the link). */
async function setLink(staffId: string, membershipId: string | null) {
  await testDb`update staff_members set tenant_membership_id = ${membershipId} where id = ${staffId}`;
}

const link = (callerId: string, staffId: string, membershipId: string, tenantId = tenant.id) =>
  attemptAs(callerId, (sql) => sql`select public.link_staff_membership(${tenantId}::uuid, ${staffId}::uuid, ${membershipId}::uuid)`);
const unlink = (callerId: string, staffId: string, tenantId = tenant.id) =>
  attemptAs(callerId, (sql) => sql`select public.unlink_staff_membership(${tenantId}::uuid, ${staffId}::uuid)`);

beforeAll(async () => {
  for (const label of ["owner", "manager", "member1", "member2", "personel", "ownerB"]) await newUser(label);

  tenant = await createTestTenant("test-tenant-sml-a", users.owner!.id);
  tenantB = await createTestTenant("test-tenant-sml-b", users.ownerB!.id);
  createdTenantIds.push(tenant.id, tenantB.id);

  roleOf.manager = await createCustomRole(tenant.id, "Yönetici", MANAGER_KEYS);
  roleOf.lower = await createCustomRole(tenant.id, "Personel", LOWER_KEYS);

  const [ownerMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${users.owner!.id}`;
  membershipOf.owner = ownerMembership!.id;
  membershipOf.manager = await addMembership(tenant.id, users.manager!.id, roleOf.manager);
  membershipOf.member1 = await addMembership(tenant.id, users.member1!.id, roleOf.lower);
  membershipOf.member2 = await addMembership(tenant.id, users.member2!.id, roleOf.lower);
  membershipOf.personel = await addMembership(tenant.id, users.personel!.id, roleOf.lower);

  const [ownerBMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenantB.id} and user_id = ${users.ownerB!.id}`;
  membershipOf.ownerB = ownerBMembership!.id;

  for (const label of ["s1", "s2", "s3", "s4"]) staffOf[label] = (await createStaffMember(tenant.id, `Personel ${label}`)).id;
  staffOf.sB = (await createStaffMember(tenantB.id, "Personel B")).id;
  staffOf.deleted = (await createStaffMember(tenant.id, "Silinmiş Personel")).id;
  await testDb`update staff_members set deleted_at = now() where id = ${staffOf.deleted!}`;

  ownerClient = await signInAs(users.owner!);
  managerClient = await signInAs(users.manager!);
}, 150000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 90000);

describe("link_staff_membership / unlink_staff_membership", () => {
  it("link works (real signed-in client) and the link change is audited exactly once", async () => {
    const before = (await auditRows(tenant.id, "staff_member.updated", staffOf.s1!)).length;

    const { error } = await ownerClient.rpc("link_staff_membership", {
      p_tenant_id: tenant.id,
      p_staff_member_id: staffOf.s1!,
      p_membership_id: membershipOf.member1!,
    });
    expect(error).toBeNull();
    expect(await linkOf(staffOf.s1!)).toBe(membershipOf.member1);

    const audit = await auditRows(tenant.id, "staff_member.updated", staffOf.s1!);
    expect(audit).toHaveLength(before + 1);
    const last = audit[audit.length - 1]!;
    expect(last.actor_user_id).toBe(users.owner!.id);
    expect((last.before as { tenant_membership_id: string | null }).tenant_membership_id).toBeNull();
    expect((last.after as { tenant_membership_id: string | null }).tenant_membership_id).toBe(membershipOf.member1);
  });

  it("unlink works (real signed-in client) and is audited exactly once", async () => {
    const before = (await auditRows(tenant.id, "staff_member.updated", staffOf.s1!)).length;

    const { error } = await ownerClient.rpc("unlink_staff_membership", { p_tenant_id: tenant.id, p_staff_member_id: staffOf.s1! });
    expect(error).toBeNull();
    expect(await linkOf(staffOf.s1!)).toBeNull();
    expect((await auditRows(tenant.id, "staff_member.updated", staffOf.s1!)).length).toBe(before + 1);
  });

  it("never overwrites, never duplicates, never lets a login be taken over", async () => {
    expect(await link(users.owner!.id, staffOf.s1!, membershipOf.member1!)).toEqual({ ok: true });
    const auditAfterLink = (await auditRows(tenant.id, "staff_member.updated", staffOf.s1!)).length;

    // Same link again, and a different login for the same staff row: both refused.
    expect(await link(users.owner!.id, staffOf.s1!, membershipOf.member1!)).toMatchObject({ ok: false, message: "staff_already_linked" });
    expect(await link(users.owner!.id, staffOf.s1!, membershipOf.member2!)).toMatchObject({ ok: false, message: "staff_already_linked" });
    // A login already attributed to one staff row cannot be attributed to a second.
    expect(await link(users.owner!.id, staffOf.s2!, membershipOf.member1!)).toMatchObject({ ok: false, message: "membership_already_linked" });

    expect(await linkOf(staffOf.s1!)).toBe(membershipOf.member1);
    expect(await linkOf(staffOf.s2!)).toBeNull();
    expect((await auditRows(tenant.id, "staff_member.updated", staffOf.s1!)).length).toBe(auditAfterLink);

    // unlinking something that is not linked is its own clear error
    expect(await unlink(users.owner!.id, staffOf.s3!)).toMatchObject({ ok: false, message: "staff_not_linked" });
    await setLink(staffOf.s1!, null);
  });

  it("a soft-deleted staff row can be neither linked nor unlinked", async () => {
    expect(await link(users.owner!.id, staffOf.deleted!, membershipOf.member1!)).toMatchObject({ ok: false, message: "staff_member_not_found" });
    expect(await unlink(users.owner!.id, staffOf.deleted!)).toMatchObject({ ok: false, message: "staff_member_not_found" });
  });

  it("rejects cross-tenant staff, cross-tenant memberships and forged tenant ids", async () => {
    expect(await link(users.owner!.id, staffOf.sB!, membershipOf.member1!)).toMatchObject({ ok: false, message: "staff_member_not_found" });
    expect(await link(users.owner!.id, staffOf.s1!, membershipOf.ownerB!)).toMatchObject({ ok: false, message: "membership_not_found" });
    // A caller who is not a member of the tenant they name learns nothing.
    expect(await link(users.owner!.id, staffOf.sB!, membershipOf.ownerB!, tenantB.id)).toMatchObject({ ok: false, message: "membership_not_found" });
    expect(await link(users.owner!.id, staffOf.s1!, membershipOf.member1!, randomUUID())).toMatchObject({ ok: false, message: "membership_not_found" });
    expect(await unlink(users.owner!.id, staffOf.sB!)).toMatchObject({ ok: false, message: "staff_member_not_found" });
    expect(await unlink(users.owner!.id, staffOf.s1!, tenantB.id)).toMatchObject({ ok: false, message: "staff_member_not_found" });
    expect(await linkOf(staffOf.s1!)).toBeNull();
    expect(await linkOf(staffOf.sB!)).toBeNull();
  });

  it("requires staff.manage", async () => {
    expect(await link(users.personel!.id, staffOf.s1!, membershipOf.member1!)).toMatchObject({ ok: false, message: "staff_manage_required" });
    expect(await unlink(users.personel!.id, staffOf.s1!)).toMatchObject({ ok: false, message: "staff_manage_required" });
    expect(await link(users.ownerB!.id, staffOf.s1!, membershipOf.member1!)).toMatchObject({ ok: false, message: "membership_not_found" });
  });

  it("applies target authority: a manager cannot attach or detach an Owner's login, but may handle a lower member and its own", async () => {
    // the owner may attribute their own login; a manager may not touch it
    expect(await link(users.owner!.id, staffOf.s2!, membershipOf.owner!)).toEqual({ ok: true });
    expect(await unlink(users.manager!.id, staffOf.s2!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    // authority is judged before anything else, so even an already-linked Owner login is "insufficient_authority" for a manager
    expect(await link(users.manager!.id, staffOf.s3!, membershipOf.owner!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await unlink(users.owner!.id, staffOf.s2!)).toEqual({ ok: true });
    expect(await link(users.manager!.id, staffOf.s3!, membershipOf.owner!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await linkOf(staffOf.s3!)).toBeNull();

    // lower member: fine; own login (self is allowed for link/unlink): fine
    expect(await link(users.manager!.id, staffOf.s3!, membershipOf.member2!)).toEqual({ ok: true });
    expect(await unlink(users.manager!.id, staffOf.s3!)).toEqual({ ok: true });
    expect(await link(users.manager!.id, staffOf.s4!, membershipOf.manager!)).toEqual({ ok: true });
    expect(await unlink(users.manager!.id, staffOf.s4!)).toEqual({ ok: true });
  });

  it("a link left pointing at a removed login can always be cleared by a staff.manage holder", async () => {
    await setLink(staffOf.s3!, membershipOf.member2!);
    await testDb`update tenant_memberships set deleted_at = now() where id = ${membershipOf.member2!}`;
    expect(await unlink(users.manager!.id, staffOf.s3!)).toEqual({ ok: true });
    expect(await linkOf(staffOf.s3!)).toBeNull();
    await testDb`update tenant_memberships set deleted_at = null where id = ${membershipOf.member2!}`;
  });
});

describe("direct writes to staff_members.tenant_membership_id cannot bypass the guard", () => {
  it("a real signed-in staff.manage holder's raw PATCH that CHANGES the link is refused (42501), for set and for clear", async () => {
    await setLink(staffOf.s1!, membershipOf.member1!);

    const set = await managerClient.from("staff_members").update({ tenant_membership_id: membershipOf.member2! }).eq("id", staffOf.s2!).select();
    expect(set.error?.code).toBe("42501");
    expect(set.error?.message).toMatch(/staff_membership_link_via_rpc_only/);
    expect(await linkOf(staffOf.s2!)).toBeNull();

    const clear = await managerClient.from("staff_members").update({ tenant_membership_id: null }).eq("id", staffOf.s1!).select();
    expect(clear.error?.code).toBe("42501");
    expect(await linkOf(staffOf.s1!)).toBe(membershipOf.member1);

    const takeover = await managerClient.from("staff_members").update({ tenant_membership_id: membershipOf.member1! }).eq("id", staffOf.s4!).select();
    expect(takeover.error?.code).toBe("42501");
    expect(await linkOf(staffOf.s4!)).toBeNull();
    await setLink(staffOf.s1!, null);
  });

  it("INSERT with a link, and an upsert that would change one, are refused too", async () => {
    const insert = await managerClient
      .from("staff_members")
      .insert({ tenant_id: tenant.id, full_name: "Bağlı Ekleme", tenant_membership_id: membershipOf.member2! })
      .select();
    expect(insert.error?.code).toBe("42501");

    const upsert = await managerClient
      .from("staff_members")
      .upsert({ id: staffOf.s2!, tenant_id: tenant.id, full_name: "Personel s2", tenant_membership_id: membershipOf.member2! })
      .select();
    expect(upsert.error?.code).toBe("42501");
    expect(await linkOf(staffOf.s2!)).toBeNull();

    const [row] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${tenant.id} and full_name = 'Bağlı Ekleme'`;
    expect(row!.n).toBe("0");
  });

  it("a client that sends spoofed 'trusted' headers gains nothing, and set_config is not an exposed route", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
    const { data: session } = await managerClient.auth.getSession();
    const spoofed = createSupabaseClient(url, key, {
      global: {
        headers: {
          Authorization: `Bearer ${session.session!.access_token}`,
          "x-salonos-trusted": "on",
          "x-staff-link-rpc": "on",
          "x-postgres-role": "postgres",
        },
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const patch = await spoofed.from("staff_members").update({ tenant_membership_id: membershipOf.member2! }).eq("id", staffOf.s2!).select();
    expect(patch.error?.code).toBe("42501");
    expect(await linkOf(staffOf.s2!)).toBeNull();

    const setConfig = await managerClient.rpc("set_config" as never, { setting_name: "role", new_value: "postgres", is_local: true } as never);
    expect(setConfig.error).not.toBeNull();
    const guard = await managerClient.rpc("guard_staff_membership_link" as never);
    expect(guard.error).not.toBeNull();
    expect(await linkOf(staffOf.s2!)).toBeNull();
  });

  it("writes that do NOT change the link keep working — which is what keeps the deployed Personnel forms alive", async () => {
    // other columns only
    const rename = await managerClient.from("staff_members").update({ full_name: "Yeni Ad" }).eq("id", staffOf.s4!).select();
    expect(rename.error).toBeNull();

    // resending the CURRENT value alongside other columns (what the existing form does)
    const resend = await managerClient
      .from("staff_members")
      .update({ full_name: "Yeni Ad 2", tenant_membership_id: null })
      .eq("id", staffOf.s4!)
      .select();
    expect(resend.error).toBeNull();

    await setLink(staffOf.s1!, membershipOf.member1!);
    const resendLinked = await managerClient
      .from("staff_members")
      .update({ phone: "+905550000000", tenant_membership_id: membershipOf.member1! })
      .eq("id", staffOf.s1!)
      .select();
    expect(resendLinked.error).toBeNull();
    expect(await linkOf(staffOf.s1!)).toBe(membershipOf.member1);
    await setLink(staffOf.s1!, null);

    // a brand new staff row without a link
    const insert = await managerClient.from("staff_members").insert({ tenant_id: tenant.id, full_name: "Bağsız Yeni" }).select("id");
    expect(insert.error).toBeNull();
    if (insert.data?.[0]) await testDb`delete from staff_members where id = ${insert.data[0].id}`;
  });

  it("the guard is trusted-by-role, not by any flag: authenticated is refused, the database owner is allowed", async () => {
    const asClient = await attemptAs(users.manager!.id, (sql) =>
      sql`update staff_members set tenant_membership_id = ${membershipOf.member2!} where id = ${staffOf.s2!}`);
    expect(asClient).toMatchObject({ ok: false, code: "42501" });
    expect((asClient as { message: string }).message).toMatch(/staff_membership_link_via_rpc_only/);

    // service_role and anon are not trusted writers of the link either (refused either by the guard or,
    // where the role holds no UPDATE privilege on the table at all, by the privilege check — never "allowed",
    // and never the unrelated "cannot switch to this role" failure).
    for (const role of ["service_role", "anon"] as const) {
      const outcome = await asDatabaseRole(role, users.manager!.id, (sql) =>
        sql`update staff_members set tenant_membership_id = ${membershipOf.member2!} where id = ${staffOf.s2!}`).then(
        () => ({ refused: false, message: "" }),
        (error: { message: string; code?: string }) => ({ refused: error.code === "42501", message: error.message }),
      );
      expect(outcome.refused, role).toBe(true);
      expect(outcome.message, role).toMatch(/permission denied for table staff_members|staff_membership_link_via_rpc_only/);
    }
    expect(await linkOf(staffOf.s2!)).toBeNull();

    // the owner of the schema (what every SECURITY DEFINER function runs as) may write it
    await setLink(staffOf.s2!, membershipOf.member2!);
    expect(await linkOf(staffOf.s2!)).toBe(membershipOf.member2);
    await setLink(staffOf.s2!, null);

    const [roles] = await testDb<{ auth: boolean; anon: boolean; service: boolean; owner: boolean; enabled: string }[]>`
      select pg_has_role('authenticated', 'postgres', 'member') as auth,
             pg_has_role('anon', 'postgres', 'member') as anon,
             pg_has_role('service_role', 'postgres', 'member') as service,
             pg_has_role('postgres', 'postgres', 'member') as owner,
             (select tgenabled::text from pg_trigger where tgname = 'staff_members_membership_link_guard' and not tgisinternal) as enabled
    `;
    expect(roles).toEqual({ auth: false, anon: false, service: false, owner: true, enabled: "O" });
  });

  it("only the four audited SECURITY DEFINER functions may write the link — a new writer must be reviewed", async () => {
    const writers = await testDb<{ fn: string }[]>`
      with candidates as materialized (
        select p.oid, n.nspname, p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prokind = 'f' and p.prosecdef and n.nspname in ('public', 'private')
      )
      select nspname || '.' || proname as fn
      from candidates
      where pg_get_functiondef(oid) ~* '(update|insert[[:space:]]+into)[[:space:]]+public[.]staff_members'
        and pg_get_functiondef(oid) ~* 'tenant_membership_id'
      order by 1
    `;
    expect(writers.map((w) => w.fn)).toEqual([
      "private.accept_team_invitation",
      "private.link_staff_membership",
      "private.remove_membership_access",
      "private.unlink_staff_membership",
    ]);
  });
});
