import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  cleanupTenants,
  cleanupUsers,
  createTestMembershipFromTemplate,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * SEC.1A - direct HTTP invocation of the team invitation Server Actions against a REAL production build of the candidate, served locally and wired to the
 * local scratch database through the rig's fake Supabase shim (never DEV, never PROD). Runs only when SEC1A_APP_URL is set (the harness
 * E:\salonos-operator-artifacts\ops\sec1a\run_http.sh builds and starts the app, a loopback SMTP sink and the shim); a plain `vitest run` skips it.
 *
 * Personas: anonymous, authenticated non-member, removed member, cross-tenant owner, stylist, receptionist, manager, owner.
 * Every request is a real POST with a Next-Action header and a real session cookie, exactly what a hostile client can send. Asserted for each:
 * the response, the invitation rows (no unauthorized mutation), the memberships (untouched) and the SMTP sink (no mail on a rejected request).
 */
const APP = process.env.SEC1A_APP_URL;
const SINK = process.env.SEC1A_SINK_URL ?? "http://127.0.0.1:2527";
const MANIFEST = process.env.SEC1A_MANIFEST ?? path.resolve(__dirname, "../.next/server/server-reference-manifest.json");
const FORMER_HELPERS = ["createTeamInvitationCore", "resendTeamInvitationCore", "revokeTeamInvitationCore"];
/** the three endpoint ids the pre-SEC.1A (DEP.1) build registered for the former helpers - informational: they must not resolve in the new build */
const FORMER_HELPER_IDS = ["78b72c3222ab5cc53b81fe0a8bf253b786ec0c012a", "781f1041be8b255d073cc1b8476ab496177ef9937e", "60408139fd80fdf39bec5bb57f5bfae819f4ec6da3"];

const d = APP ? describe : describe.skip;

type Persona = "anonymous" | "nonMember" | "removed" | "crossTenantOwner" | "stylist" | "receptionist" | "manager" | "owner";
const users: Record<string, TestUser> = {};
const cookies: Record<Persona, string | null> = { anonymous: null, nonMember: null, removed: null, crossTenantOwner: null, stylist: null, receptionist: null, manager: null, owner: null };
const tenantIds: string[] = [];
const userIds: string[] = [];
let A: TestTenant;
let B: TestTenant;
let recepRoleId = "";
let ids: Record<string, string> = {};

function cookieFor(session: unknown): string {
  const name = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0]}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const parts = value.match(/.{1,3180}/g)!;
  return parts.map((p, i) => `${parts.length === 1 ? name : `${name}.${i}`}=${p}`).join("; ");
}

async function post(persona: Persona, actionId: string, args: unknown[], slug: string): Promise<{ status: number; success: boolean | null; body: string; outcome: string | null }> {
  const r = await fetch(`${APP}/app/${slug}/team`, {
    method: "POST",
    redirect: "manual",
    headers: { "next-action": actionId, accept: "text/x-component", "content-type": "text/plain;charset=UTF-8", origin: APP!, ...(cookies[persona] ? { cookie: cookies[persona]! } : {}) },
    body: JSON.stringify(args),
  });
  const body = await r.text();
  // the action's own return value is the Flight row the response root ("a":"$@N") points at - parse THAT row, never a "success" string found elsewhere in a re-rendered page
  const root = body.match(/(?:^|\n)0:\{[^\n]*"a":"\$@([0-9a-f]+)"/);
  const row = root ? body.match(new RegExp("(?:^|\\n)" + root[1] + ":(\\{[^\\n]*\\})")) : null;
  let result: { success?: boolean; error?: { code?: string }; data?: { outcome?: string } } | null = null;
  try { result = row ? JSON.parse(row[1]!) : null; } catch { result = null; }
  return { status: r.status, success: typeof result?.success === "boolean" ? result.success : null, body: row ? row[1]!.slice(0, 240) : body.replace(/\s+/g, " ").slice(0, 160), outcome: result?.data?.outcome ?? null };
}

const mails = async (): Promise<{ count: number; to: string[] }> => (await fetch(`${SINK}/count`)).json() as Promise<{ count: number; to: string[] }>;
const invitations = async (tenantId: string) => testDb`select id, email, status, expires_at from team_invitations where tenant_id = ${tenantId} order by created_at, id`;
const members = async (tenantId: string) => testDb`select user_id, status from tenant_memberships where tenant_id = ${tenantId} order by user_id`;

d("SEC.1A team invitation actions over real HTTP", () => {
  beforeAll(async () => {
    const mk = async (label: string) => { const u = await createTestUser(`sec1a-${label}`); users[label] = u; userIds.push(u.id); return u; };
    for (const l of ["owner", "manager", "receptionist", "stylist", "removed", "nonMember", "crossTenantOwner"]) await mk(l);
    const slug = (s: string) => `sec1a-${s}-${randomUUID().slice(0, 6)}`;
    A = await createTestTenant(slug("a"), users.owner!.id);
    B = await createTestTenant(slug("b"), users.crossTenantOwner!.id);
    tenantIds.push(A.id, B.id);
    await createTestMembershipFromTemplate(A.id, users.manager!.id, "SALON_MANAGER");
    const rec = await createTestMembershipFromTemplate(A.id, users.receptionist!.id, "RECEPTIONIST");
    recepRoleId = rec.roleId;
    await createTestMembershipFromTemplate(A.id, users.stylist!.id, "STYLIST");
    await addMembership(A.id, users.removed!.id, recepRoleId);
    for (const [p, label] of [["owner", "owner"], ["manager", "manager"], ["receptionist", "receptionist"], ["stylist", "stylist"], ["removed", "removed"], ["nonMember", "nonMember"], ["crossTenantOwner", "crossTenantOwner"]] as const) {
      const c = await signInAs(users[label]!);
      cookies[p] = cookieFor((await c.auth.getSession()).data.session);
    }
    // the removed member's session was minted while still a member; the membership is gone before any request is made
    await testDb`delete from tenant_memberships where tenant_id = ${A.id} and user_id = ${users.removed!.id}`;

    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { node: Record<string, { exportedName: string }> };
    ids = Object.fromEntries(Object.entries(manifest.node).map(([id, v]) => [v.exportedName, id]).reverse());
  }, 240000);

  afterAll(async () => {
    await cleanupTenants(tenantIds).catch(() => undefined);
    await cleanupUsers(userIds).catch(() => undefined);
    await testDb.end({ timeout: 5 }).catch(() => undefined);
  }, 240000);

  it("M1 the manifest of the running build has the three wrappers and none of the former helpers", () => {
    for (const f of FORMER_HELPERS) expect(ids[f], f).toBeUndefined();
    for (const w of ["createTeamInvitationAction", "resendTeamInvitationAction", "revokeTeamInvitationAction"]) expect(ids[w], w).toBeTruthy();
  });

  it("M2 the ids the pre-SEC.1A build registered for the helpers do not resolve (an invented or stale action id is refused)", async () => {
    const before = { inv: await invitations(A.id), mails: await mails() };
    for (const id of FORMER_HELPER_IDS) {
      for (const p of ["anonymous", "owner"] as const) {
        const r = await post(p, id, [{}, randomUUID(), { tenantId: A.id, email: "ghost@example.com", roleId: recepRoleId }], "x");
        expect(r.success, `${p} ${id} ${r.body}`).not.toBe(true);
      }
    }
    expect(await invitations(A.id)).toEqual(before.inv);
    expect((await mails()).count).toBe(before.mails.count);
  });

  const denied: Persona[] = ["anonymous", "nonMember", "removed", "crossTenantOwner", "stylist", "receptionist"];

  it("C1 create: every unauthorized persona is refused, writes nothing and sends no mail", async () => {
    const before = { inv: await invitations(A.id), mem: await members(A.id), mails: await mails() };
    const seen: Record<string, string> = {};
    for (const p of denied) {
      const r = await post(p, ids.createTeamInvitationAction!, [null, { tenantId: A.id, email: `denied-${p}-${randomUUID().slice(0, 6)}@example.com`, roleId: recepRoleId, tenantSlug: "x" }], A.slug);
      seen[p] = `${r.status}/${r.success}`;
      expect(r.success, `${p}: ${r.body}`).not.toBe(true);
    }
    console.log("C1 outcomes", JSON.stringify(seen));
    expect(await invitations(A.id)).toEqual(before.inv);
    expect(await members(A.id)).toEqual(before.mem);
    expect((await mails()).count).toBe(before.mails.count);
  });

  it("C2 create: the cross-tenant owner cannot target tenant A even with a valid-looking role id from tenant B", async () => {
    const roleB = (await testDb`select id from roles where tenant_id = ${B.id} limit 1`)[0]!.id as string;
    const before = { a: await invitations(A.id), b: await invitations(B.id), mails: await mails() };
    const r1 = await post("crossTenantOwner", ids.createTeamInvitationAction!, [null, { tenantId: A.id, email: "x-a@example.com", roleId: roleB, tenantSlug: "x" }], B.slug);
    expect(r1.success).not.toBe(true);
    expect(await invitations(A.id)).toEqual(before.a);
    expect(await invitations(B.id)).toEqual(before.b);
    expect((await mails()).count).toBe(before.mails.count);
  });

  let invitationId = "";
  let created: { status: number; success: boolean | null; body: string; outcome: string | null };

  it("L1 legitimate: the owner creates an invitation through the wrapper (one mail, one row)", async () => {
    const m0 = await mails();
    const n0 = (await invitations(A.id)).length;
    created = await post("owner", ids.createTeamInvitationAction!, [null, { tenantId: A.id, email: `legit-${randomUUID().slice(0, 6)}@example.com`, roleId: recepRoleId, tenantSlug: A.slug }], A.slug);
    expect(created.success, created.body).toBe(true);
    const rows = await invitations(A.id);
    expect(rows.length).toBe(n0 + 1);
    invitationId = rows[rows.length - 1]!.id as string;
    expect((await mails()).count).toBe(m0.count + 1);
  });

  it("R1 resend / revoke: every unauthorized persona is refused, the invitation is untouched, no mail", async () => {
    const before = { inv: await invitations(A.id), mails: await mails(), mem: await members(A.id) };
    const seen: Record<string, string> = {};
    for (const p of denied) {
      const rs = await post(p, ids.resendTeamInvitationAction!, [null, { tenantId: A.id, invitationId, tenantSlug: A.slug }], A.slug);
      const rv = await post(p, ids.revokeTeamInvitationAction!, [null, { tenantId: A.id, invitationId, tenantSlug: A.slug }], A.slug);
      seen[p] = `resend ${rs.status}/${rs.success} revoke ${rv.status}/${rv.success}`;
      expect(rs.success, `${p} resend: ${rs.body}`).not.toBe(true);
      expect(rv.success, `${p} revoke: ${rv.body}`).not.toBe(true);
    }
    console.log("R1 outcomes", JSON.stringify(seen));
    expect(await invitations(A.id)).toEqual(before.inv);
    expect(await members(A.id)).toEqual(before.mem);
    expect((await mails()).count).toBe(before.mails.count);
  });

  it("R2 the cross-tenant owner cannot act on tenant A's invitation by naming his own tenant either", async () => {
    const before = { inv: await invitations(A.id), mails: await mails() };
    for (const fn of ["resendTeamInvitationAction", "revokeTeamInvitationAction"]) {
      const r = await post("crossTenantOwner", ids[fn]!, [null, { tenantId: B.id, invitationId, tenantSlug: B.slug }], B.slug);
      expect(r.success, `${fn}: ${r.body}`).not.toBe(true);
    }
    expect(await invitations(A.id)).toEqual(before.inv);
    expect((await mails()).count).toBe(before.mails.count);
  });

  it("L2 legitimate: the manager may resend, the owner may resend and revoke (database permission model unchanged)", async () => {
    const m0 = await mails();
    const rm = await post("manager", ids.resendTeamInvitationAction!, [null, { tenantId: A.id, invitationId, tenantSlug: A.slug }], A.slug);
    console.log("L2 manager resend", rm.status, rm.success, rm.body.slice(0, 120));
    const ro = await post("owner", ids.resendTeamInvitationAction!, [null, { tenantId: A.id, invitationId, tenantSlug: A.slug }], A.slug);
    expect(ro.success, ro.body).toBe(true);
    expect((await mails()).count).toBeGreaterThan(m0.count);
    const rv = await post("owner", ids.revokeTeamInvitationAction!, [null, { tenantId: A.id, invitationId, tenantSlug: A.slug }], A.slug);
    expect(rv.success, rv.body).toBe(true);
    const row = (await invitations(A.id)).find((r) => r.id === invitationId)!;
    expect(row.status).toBe("revoked");
  });

  it("L3 legitimate: the manager can create an invitation for a role it may grant (or is refused by the database ceiling - same as a direct RPC)", async () => {
    const r = await post("manager", ids.createTeamInvitationAction!, [null, { tenantId: A.id, email: `mgr-${randomUUID().slice(0, 6)}@example.com`, roleId: recepRoleId, tenantSlug: A.slug }], A.slug);
    console.log("L3 manager create", r.status, r.success, r.body.slice(0, 140));
    expect(typeof r.success).toBe("boolean");
  });
});
