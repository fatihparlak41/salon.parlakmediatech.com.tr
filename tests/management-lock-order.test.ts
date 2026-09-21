import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  addMembership,
  asAuthenticatedUser,
  cleanupTenants,
  cleanupUsers,
  createCustomRole,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.0 (part 4) — the management RPCs authorize BEFORE they touch
 * the tenant lock, and they all take locks in ONE order.
 *
 * Part 1 proves the gate with a real lock: another connection holds the
 * tenants row FOR UPDATE (the very lock every management RPC takes) while a
 * caller who has no business managing the tenant calls each RPC with a short
 * lock_timeout. Such a caller must be refused IMMEDIATELY with the RPC's own
 * denial message — never wait for, or time out on, the lock. A properly
 * authorized caller in the same situation DOES wait and times out (55P03),
 * which proves the lock is real and the gate does not merely skip it.
 *
 * Part 2 is a deadlock hunt: rounds of genuinely concurrent management,
 * invitation-management and invitation-acceptance calls on one tenant and on
 * overlapping rows (membership, staff row, role, invitation). No call may
 * fail with a deadlock, serialization failure or lock timeout, and the
 * audit trail must contain exactly one row per successful mutation.
 */

const MANAGER_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update", "customers.link_account",
  "reports.basic", "reports.staff", "schedules.view", "schedules.manage",
  "services.view", "services.manage", "staff.view", "staff.manage",
];
const RECEPTION_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update", "schedules.view", "services.view",
];
const PERSONEL_KEYS = ["appointments.view", "customers.view", "schedules.view", "services.view"];

let tenantA: TestTenant;
let tenantB: TestTenant;

const users: Record<string, TestUser> = {};
const roleOf: Record<string, string> = {};
const membershipOf: Record<string, string> = {};
const staffOf: Record<string, string> = {};

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`mlo-${label}`);
  createdUserIds.push(user.id);
  users[label] = user;
  return user;
}

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

type CallOutcome = { ok: true; ms: number } | { ok: false; message: string; code: string | undefined; ms: number };

/** One RPC, as `userId`, in one transaction, with a lock_timeout so a caller
 * that (wrongly) waits for the tenant lock fails loudly instead of hanging. */
async function callWithLockTimeout(
  userId: string,
  lockTimeoutMs: number,
  run: (sql: postgres.TransactionSql) => Promise<unknown>,
): Promise<CallOutcome> {
  const started = Date.now();
  try {
    await asAuthenticatedUser(userId, async (sql) => {
      await sql.unsafe(`set local lock_timeout = '${lockTimeoutMs}ms'`);
      return run(sql);
    });
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    const e = error as { message?: string; code?: string };
    return { ok: false, message: e.message ?? String(error), code: e.code, ms: Date.now() - started };
  }
}

beforeAll(async () => {
  for (const label of [
    "owner", "manager", "plain", "stranger", "outsider", "suspended", "removed", "target", "linkee",
    "m1", "m2", "m3", "m4", "invitee",
  ]) {
    await newUser(label);
  }

  tenantA = await createTestTenant("test-tenant-mlo-a", users.owner!.id);
  tenantB = await createTestTenant("test-tenant-mlo-b", users.outsider!.id);
  createdTenantIds.push(tenantA.id, tenantB.id);

  roleOf.owner = tenantA.ownerRoleId;
  roleOf.manager = await createCustomRole(tenantA.id, "Yönetici", MANAGER_KEYS);
  roleOf.lowA = await createCustomRole(tenantA.id, "Resepsiyon", RECEPTION_KEYS);
  roleOf.lowB = await createCustomRole(tenantA.id, "Personel", PERSONEL_KEYS);

  const [ownerMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${users.owner!.id}`;
  membershipOf.owner = ownerMembership!.id;
  membershipOf.manager = await addMembership(tenantA.id, users.manager!.id, roleOf.manager);
  membershipOf.plain = await addMembership(tenantA.id, users.plain!.id, roleOf.lowB);
  membershipOf.suspended = await addMembership(tenantA.id, users.suspended!.id, roleOf.manager);
  await testDb`update tenant_memberships set status = 'suspended' where id = ${membershipOf.suspended}`;
  membershipOf.removed = await addMembership(tenantA.id, users.removed!.id, roleOf.manager);
  await testDb`update tenant_memberships set deleted_at = now() where id = ${membershipOf.removed}`;
  membershipOf.target = await addMembership(tenantA.id, users.target!.id, roleOf.lowA);
  membershipOf.linkee = await addMembership(tenantA.id, users.linkee!.id, roleOf.lowA);

  const [staff] = await testDb<{ id: string }[]>`
    insert into staff_members (tenant_id, full_name) values (${tenantA.id}, 'MLO Staff') returning id`;
  staffOf.free = staff!.id;
}, 240000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 180000);

// ---------------------------------------------------------------------------
// Part 1 — authorize before locking
// ---------------------------------------------------------------------------

type RpcCase = {
  name: string;
  notMember: string;
  noPermission: string;
  call: (sql: postgres.TransactionSql) => Promise<unknown>;
};

function rpcCases(): RpcCase[] {
  const t = tenantA.id;
  return [
    {
      name: "update_membership_role",
      notMember: "membership not found",
      noPermission: "staff.manage required",
      call: (sql) => sql`select public.update_membership_role(${membershipOf.target}::uuid, ${roleOf.lowB}::uuid)`,
    },
    {
      name: "update_role_permissions",
      notMember: "role not found",
      noPermission: "staff.manage required",
      call: (sql) => sql`select public.update_role_permissions(${roleOf.lowB}::uuid, ${sql.array(PERSONEL_KEYS, 1009)}::text[])`,
    },
    {
      name: "suspend_membership",
      notMember: "membership_not_found",
      noPermission: "staff_manage_required",
      call: (sql) => sql`select public.suspend_membership(${t}::uuid, ${membershipOf.target}::uuid)`,
    },
    {
      name: "reactivate_membership",
      notMember: "membership_not_found",
      noPermission: "staff_manage_required",
      call: (sql) => sql`select public.reactivate_membership(${t}::uuid, ${membershipOf.target}::uuid)`,
    },
    {
      name: "remove_membership_access",
      notMember: "membership_not_found",
      noPermission: "staff_manage_required",
      call: (sql) => sql`select public.remove_membership_access(${t}::uuid, ${membershipOf.target}::uuid)`,
    },
    {
      name: "link_staff_membership",
      notMember: "membership_not_found",
      noPermission: "staff_manage_required",
      call: (sql) => sql`select public.link_staff_membership(${t}::uuid, ${staffOf.free}::uuid, ${membershipOf.linkee}::uuid)`,
    },
    {
      name: "unlink_staff_membership",
      notMember: "staff_member_not_found",
      noPermission: "staff_manage_required",
      call: (sql) => sql`select public.unlink_staff_membership(${t}::uuid, ${staffOf.free}::uuid)`,
    },
  ];
}

describe("authorize before lock — the tenant row lock is only ever contended for by an authorized caller", () => {
  const LOCK_TIMEOUT_MS = 1500;
  let holder: postgres.ReservedSql;

  beforeAll(async () => {
    holder = await testDb.reserve();
    await holder`begin`;
    await holder`select 1 from tenants where id = ${tenantA.id} for update`;
  }, 60000);

  afterAll(async () => {
    await holder`rollback`;
    holder.release();
  }, 60000);

  it("sanity: the held lock really blocks an AUTHORIZED manager (lock_timeout, SQLSTATE 55P03) for every RPC", async () => {
    for (const c of rpcCases()) {
      const outcome = await callWithLockTimeout(users.manager!.id, 600, c.call);
      expect(outcome.ok, c.name).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code, `${c.name}: ${outcome.message}`).toBe("55P03");
      expect(outcome.ms, c.name).toBeGreaterThanOrEqual(500); // it genuinely waited
    }
  }, 60000);

  for (const [label, who] of [
    ["a stranger with no membership anywhere", "stranger"],
    ["the Owner of a DIFFERENT tenant", "outsider"],
    ["a SUSPENDED manager", "suspended"],
    ["a REMOVED manager", "removed"],
  ] as const) {
    it(`${label} is refused immediately with the RPC's not-a-member message and never waits for the lock`, async () => {
      for (const c of rpcCases()) {
        const outcome = await callWithLockTimeout(users[who]!.id, LOCK_TIMEOUT_MS, c.call);
        expect(outcome.ok, c.name).toBe(false);
        if (outcome.ok) continue;
        // A caller that waited on the held lock would fail with 55P03 "lock timeout" instead of this message.
        expect(outcome.message, c.name).toBe(c.notMember);
      }
    }, 90000);
  }

  it("a member WITHOUT staff.manage is refused immediately with the RPC's no-permission message and never waits for the lock", async () => {
    for (const c of rpcCases()) {
      const outcome = await callWithLockTimeout(users.plain!.id, LOCK_TIMEOUT_MS, c.call);
      expect(outcome.ok, c.name).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.message, c.name).toBe(c.noPermission);
    }
  }, 90000);
});

describe("the lock helper and the RPC surface", () => {
  it("the gate helper is executable by no client role and not by PUBLIC; the old one-argument form is gone", async () => {
    const rows = await testDb<
      { args: string; public_grant: boolean; anon: boolean; authenticated: boolean; service_role: boolean; secdef: boolean; config: string[] | null }[]
    >`
      select pg_get_function_identity_arguments(p.oid) as args,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_grant,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role,
             p.prosecdef as secdef, p.proconfig as config
      from pg_proc p
      where p.pronamespace = 'private'::regnamespace and p.proname = 'lock_tenant_for_management'`;
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.args).toBe("p_tenant_id uuid, p_not_member_message text, p_no_permission_message text");
    expect(r.secdef).toBe(true);
    expect(r.config).toContain('search_path=""');
    expect(r.public_grant).toBe(false);
    expect(r.anon).toBe(false);
    expect(r.authenticated).toBe(false);
    expect(r.service_role).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — lock order / deadlock hunt
// ---------------------------------------------------------------------------

type OpResult = { op: string; ok: boolean; message?: string; code?: string };

/** Domain refusals that are a legitimate outcome of a race (the loser of a
 * concurrent pair), as opposed to infrastructure failures. */
const ALLOWED_REFUSALS = new Set([
  "membership_not_active",
  "membership_not_suspended",
  "membership_not_found",
  "staff_already_linked",
  "membership_already_linked",
  "staff_not_linked",
  "staff_member_not_found",
  "invitation_not_pending",
  "invitation_changed",
  "invitation_not_found",
  "invitation_revoked",
  "invitation_expired",
  "invitation_already_accepted",
  "pending_invitation_exists",
  "already_member",
  "insufficient_authority",
  "role_not_found",
  "cannot_manage_self",
]);

describe("lock order — concurrent management, invitation management and acceptance on one tenant", () => {
  const ROUNDS = Number(process.env.MLO_ROUNDS ?? 10);
  let pool: postgres.Sql;

  beforeAll(async () => {
    pool = postgres(process.env.TEST_DATABASE_URL!, { ssl: "require", max: 8 });
  });

  afterAll(async () => {
    await pool.end({ timeout: 5 });
  });

  async function asUser<T>(userId: string, fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return (await pool.begin(async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true),
                       set_config('request.jwt.claim.sub', ${userId}, true)`;
      await sql`set local role authenticated`;
      return fn(sql);
    })) as T;
  }

  async function op(name: string, userId: string, fn: (sql: postgres.TransactionSql) => Promise<unknown>): Promise<OpResult> {
    try {
      await asUser(userId, fn);
      return { op: name, ok: true };
    } catch (error) {
      const e = error as { message?: string; code?: string };
      return { op: name, ok: false, message: e.message, code: e.code };
    }
  }

  it(`${ROUNDS} rounds of concurrent operations: no deadlock, no serialization failure, no lock timeout; one audit row per successful mutation`, async () => {
    const t = tenantA.id;
    // A dedicated invitation target and the rows the operations fight over.
    const [stx] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${t}, 'MLO Stress Staff') returning id`;
    const stressStaff = stx!.id; // linked by accept_team_invitation AND targeted by link/unlink

    const membershipIds = {
      m1: await addMembership(t, users.m1!.id, roleOf.lowA!),
      m2: await addMembership(t, users.m2!.id, roleOf.lowA!),
      m3: await addMembership(t, users.m3!.id, roleOf.lowA!),
    };

    const audit = async (action: string) =>
      (await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${t} and action = ${action}`)[0]!.n;
    const auditActions = [
      "membership.suspended", "membership.reactivated", "membership.removed", "membership.role_changed",
      "team_invitation.resent", "team_invitation.revoked", "team_invitation.accepted", "team_invitation.created",
      "role.permissions_updated",
    ];
    const baseline: Record<string, number> = {};
    for (const action of auditActions) baseline[action] = await audit(action);

    const results: OpResult[] = [];
    let m4Membership = await addMembership(t, users.m4!.id, roleOf.lowA!);
    let inviteeMembership: string | null = null;
    const counts = { suspended: 0, reactivated: 0, removed: 0, roleChanged: 0, resent: 0, revoked: 0, accepted: 0, created: 0, permissions: 0 };

    // Reference values to restore between rounds (the permissions toggle changes lowA).
    for (let round = 0; round < ROUNDS; round += 1) {
      // Fresh per-round state, written through the privileged connection.
      await testDb`update staff_members set tenant_membership_id = null where id = ${stressStaff}`;
      await testDb`update team_invitations set status = 'revoked' where tenant_id = ${t} and email = ${users.invitee!.email.toLowerCase()} and status = 'pending'`;
      if (inviteeMembership) {
        await testDb`update tenant_memberships set deleted_at = now() where id = ${inviteeMembership}`;
        inviteeMembership = null;
      }
      const token = randomBytes(32).toString("hex");
      const [inv] = await testDb<{ id: string; expires_at: string }[]>`
        insert into team_invitations (tenant_id, email, role_id, staff_member_id, invited_by, status, token_hash, expires_at)
        values (${t}, ${users.invitee!.email.toLowerCase()}, ${roleOf.lowB}, ${stressStaff}, ${users.owner!.id}, 'pending', ${sha256(token)}, now() + interval '3 days')
        returning id, expires_at::text as expires_at`;
      const [m1Row] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where id = ${membershipIds.m1}`;
      const newRole = m1Row!.role_id === roleOf.lowA ? roleOf.lowB! : roleOf.lowA!; // always a real change, never a no-op
      const permissionKeys = round % 2 === 0 ? [...RECEPTION_KEYS, "reports.basic"] : RECEPTION_KEYS;

      const batch = await Promise.all([
        // invitation acceptance vs invitation management on the SAME invitation row
        op("accept", users.invitee!.id, (sql) => sql`select * from public.accept_team_invitation(${token}::text)`),
        op("resend", users.manager!.id, (sql) =>
          sql`select * from public.resend_team_invitation(${inv!.id}::uuid, ${inv!.expires_at}::text::timestamptz)`),
        op("revoke", users.owner!.id, (sql) => sql`select * from public.revoke_team_invitation(${inv!.id}::uuid)`),
        // member management (tenant lock first) vs each other and vs the staff row accept links
        op("role_change", users.owner!.id, (sql) => sql`select public.update_membership_role(${membershipIds.m1}::uuid, ${newRole}::uuid)`),
        op("suspend", users.manager!.id, (sql) => sql`select public.suspend_membership(${t}::uuid, ${membershipIds.m2}::uuid)`),
        op("reactivate", users.owner!.id, (sql) => sql`select public.reactivate_membership(${t}::uuid, ${membershipIds.m2}::uuid)`),
        op("link", users.owner!.id, (sql) => sql`select public.link_staff_membership(${t}::uuid, ${stressStaff}::uuid, ${membershipIds.m3}::uuid)`),
        op("unlink", users.manager!.id, (sql) => sql`select public.unlink_staff_membership(${t}::uuid, ${stressStaff}::uuid)`),
        op("remove", users.owner!.id, (sql) => sql`select public.remove_membership_access(${t}::uuid, ${m4Membership}::uuid)`),
        op("role_permissions", users.owner!.id, (sql) =>
          sql`select public.update_role_permissions(${roleOf.lowA}::uuid, ${sql.array(permissionKeys, 1009)}::text[])`),
        op("create_invitation", users.manager!.id, (sql) =>
          sql`select * from public.create_team_invitation(${t}::uuid, ${`mlo-r${round}-${randomUUID().slice(0, 6)}@example.com`}::text, ${roleOf.lowB}::uuid, null::uuid)`),
      ]);
      results.push(...batch);

      for (const r of batch) {
        if (!r.ok) continue;
        if (r.op === "suspend") counts.suspended += 1;
        if (r.op === "reactivate") counts.reactivated += 1;
        if (r.op === "remove") counts.removed += 1;
        if (r.op === "role_change") counts.roleChanged += 1;
        if (r.op === "resend") counts.resent += 1;
        if (r.op === "revoke") counts.revoked += 1;
        if (r.op === "accept") counts.accepted += 1;
        if (r.op === "create_invitation") counts.created += 1;
        if (r.op === "role_permissions") counts.permissions += 1;
      }

      // Restore what the round consumed.
      const [m2] = await testDb<{ status: string }[]>`select status from tenant_memberships where id = ${membershipIds.m2}`;
      if (m2!.status === "suspended") await testDb`update tenant_memberships set status = 'active' where id = ${membershipIds.m2}`;
      const [accepted] = await testDb<{ id: string }[]>`
        select id from tenant_memberships where tenant_id = ${t} and user_id = ${users.invitee!.id} and deleted_at is null`;
      inviteeMembership = accepted?.id ?? null;
      m4Membership = (await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${t} and user_id = ${users.m4!.id} and deleted_at is null`)[0]?.id
        ?? (await addMembership(t, users.m4!.id, roleOf.lowA!));
    }

    // 1. No infrastructure failure of any kind.
    const infrastructure = results.filter(
      (r) => !r.ok && (["40P01", "40001", "55P03", "57014"].includes(r.code ?? "") || /deadlock|could not serialize|lock timeout|canceling statement/i.test(r.message ?? "")),
    );
    expect(infrastructure).toEqual([]);

    // 2. Every failure is a recognized domain refusal (the loser of a legitimate race).
    const unexpected = results.filter((r) => !r.ok && !ALLOWED_REFUSALS.has(r.message ?? ""));
    expect(unexpected).toEqual([]);

    // 3. Each operation kind actually succeeded at least once across the rounds
    //    (the hunt was not vacuous: something genuinely ran concurrently).
    for (const kind of ["role_change", "suspend", "link", "unlink", "remove", "role_permissions", "create_invitation", "accept"] as const) {
      expect(results.filter((r) => r.op === kind && r.ok).length, kind).toBeGreaterThan(0);
    }

    // 4. Exactly one audit row per successful mutation (deltas over the baseline taken before the rounds).
    const delta = async (action: string) => (await audit(action)) - baseline[action]!;
    expect(await delta("membership.suspended")).toBe(counts.suspended);
    expect(await delta("membership.reactivated")).toBe(counts.reactivated);
    expect(await delta("membership.removed")).toBe(counts.removed);
    expect(await delta("membership.role_changed")).toBe(counts.roleChanged);
    expect(await delta("team_invitation.resent")).toBe(counts.resent);
    expect(await delta("team_invitation.revoked")).toBe(counts.revoked);
    expect(await delta("team_invitation.accepted")).toBe(counts.accepted);
    expect(await delta("team_invitation.created")).toBe(counts.created);
    expect(await delta("role.permissions_updated")).toBe(counts.permissions);

    // 5. The tenant still has its unrestricted holder and the owner is untouched.
    const [holder] = await testDb<{ ok: boolean }[]>`select private.tenant_has_active_unrestricted_holder(${t}::uuid) as ok`;
    expect(holder!.ok).toBe(true);
    const [ownerRow] = await testDb<{ status: string; deleted_at: string | null }[]>`
      select status, deleted_at::text as deleted_at from tenant_memberships where id = ${membershipOf.owner}`;
    expect(ownerRow).toEqual({ status: "active", deleted_at: null });
  }, 600000);

  it("two management calls on the same tenant serialize on the lock: while one holds it the other waits and then decides on the committed result", async () => {
    // A real interleaving: connection 1 takes the lock through a management call that is paused
    // (held open in a transaction); the second management call must wait for it, then succeed.
    const conn1 = await testDb.reserve();
    try {
      await conn1`begin`;
      await conn1`select set_config('request.jwt.claims', ${JSON.stringify({ sub: users.owner!.id, role: "authenticated" })}, true),
                         set_config('request.jwt.claim.sub', ${users.owner!.id}, true)`;
      await conn1`set local role authenticated`;
      await conn1`select public.update_membership_role(${membershipOf.target}::uuid, ${roleOf.lowB}::uuid)`; // holds the tenant lock

      const second = callWithLockTimeout(users.manager!.id, 15000, (sql) =>
        sql`select public.update_membership_role(${membershipOf.target}::uuid, ${roleOf.lowA}::uuid)`);
      await new Promise((resolve) => setTimeout(resolve, 1500)); // the second call is now parked on the lock
      await conn1`commit`;

      const outcome = await second;
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (outcome.ok) expect(outcome.ms).toBeGreaterThanOrEqual(1200); // it really waited
      const [row] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where id = ${membershipOf.target}`;
      expect(row!.role_id).toBe(roleOf.lowA); // the later call won, on top of the first one's committed state
    } finally {
      await conn1`rollback`.catch(() => undefined);
      conn1.release();
    }
  }, 60000);
});
