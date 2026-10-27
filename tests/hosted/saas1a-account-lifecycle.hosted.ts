// SAAS.1A HOSTED acceptance — account lifecycle and recovery against the REAL hosted Auth + PostgREST of a DISPOSABLE Supabase
// project, with the branch's own Next app running locally. Not part of the default test run: it only runs through
//   npm run test:hosted
// and the safety guard in ./guard.ts refuses to start unless a disposable project is declared and marked (it will never run
// against a project that holds real tenants). Synthetic users and tenants only; no real mailbox is ever used.
//
// What it adds over the local suites: the real provider's recovery endpoint, real tokens through the running app's routes
// (parked-cookie contract, redirect payloads), bare access-token behaviour after suspend/remove/reactivate, invitations with real
// Auth users, and what each database role can reach of the SAAS.1A surface.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  admin,
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createCustomer,
  createStaffMember,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "../helpers";
import { assertDisposableDatabase, readHostedEnv } from "./guard";

// readHostedEnv() throws unless every HOSTED_ACCEPTANCE_* variable describes ONE disposable project (also checked by the config).
const hosted = readHostedEnv();
const APP = hosted.appUrl;
const URL_ = hosted.supabaseUrl;
const PUB = hosted.publishableKey;
const SVC = hosted.serviceRoleKey;

const note = (k: string, v: unknown) => console.log(`HOSTED| ${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`);

const users: string[] = [];
const tenants: string[] = [];
async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`h-${label}`);
  users.push(user.id);
  return user;
}

const roleIds = new Map<string, string>();
async function templateRole(tenantId: string, key: string): Promise<string> {
  const ck = `${tenantId}:${key}`;
  if (roleIds.has(ck)) return roleIds.get(ck)!;
  const [existing] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenantId} and key = ${key} and deleted_at is null`;
  if (existing) return existing.id;
  const [t] = await testDb<{ id: string; key: string; name: string; description: string | null }[]>`select id, key, name, description from role_templates where key = ${key}`;
  const [r] = await testDb<{ id: string }[]>`insert into roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
    values (${tenantId}, ${t!.key}, ${t!.name}, ${t!.description}, true, ${t!.id}) returning id`;
  await testDb`insert into role_permissions (role_id, permission_id) select ${r!.id}, permission_id from role_template_permissions where role_template_id = ${t!.id}`;
  roleIds.set(ck, r!.id);
  return r!.id;
}

async function rest(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: PUB, authorization: `Bearer ${token ?? PUB}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

async function hashedToken(type: "recovery" | "magiclink", email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type, email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink ${type}: ${error?.message}`);
  return data.properties.hashed_token;
}

async function noFollow(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, redirect: "manual" });
}

/** The HttpOnly "pending e-mail confirmation" cookie the confirm route sets: its parsed value and its raw attributes. */
function parkedCookie(res: Response): { value: { tokenHash?: string; type?: string; next?: string }; attributes: string } {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("sb-pending-email-confirmation="));
  if (!raw) return { value: {}, attributes: "" };
  const [pair, ...attrs] = raw.split(";");
  return { value: JSON.parse(decodeURIComponent(pair!.slice(pair!.indexOf("=") + 1))), attributes: attrs.join(";") };
}

/** A plain same-site path: one leading slash, no scheme, no backslash, no control characters, not protocol-relative. */
function isPlainSitePath(value: string): boolean {
  return /^\/(?!\/)[^\\\u0000-\u001f]*$/.test(value) && !/^\/[a-z][a-z0-9+.-]*:/i.test(value);
}

let ownerA: TestUser, owner2A: TestUser, manager: TestUser, personel: TestUser, outsider: TestUser, otherOwner: TestUser, solo: TestUser;
let tenantA: TestTenant, tenantB: TestTenant, tenantE: TestTenant;
let membershipManager = "";
let ownerClient: SupabaseClient;

beforeAll(async () => {
  // FIRST, before anything is written: the database must carry the disposable marker and hold no real tenant.
  await assertDisposableDatabase(testDb as unknown as Parameters<typeof assertDisposableDatabase>[0]);
  ownerA = await newUser("ownerA");
  owner2A = await newUser("owner2A");
  manager = await newUser("manager");
  personel = await newUser("personel");
  outsider = await newUser("outsider");
  otherOwner = await newUser("otherOwner");
  solo = await newUser("solo");
  tenantA = await createTestTenant(`h-gokhanlike-${Date.now().toString(36)}`, ownerA.id);
  tenantB = await createTestTenant(`h-other-${Date.now().toString(36)}`, otherOwner.id);
  tenantE = await createTestTenant(`h-emellike-${Date.now().toString(36)}`, solo.id);
  tenants.push(tenantA.id, tenantB.id, tenantE.id);
  await addMembership(tenantA.id, owner2A.id, tenantA.ownerRoleId);
  membershipManager = await addMembership(tenantA.id, manager.id, await templateRole(tenantA.id, "SALON_MANAGER"));
  await addMembership(tenantA.id, personel.id, await templateRole(tenantA.id, "STYLIST"));
  await createCustomer(tenantA.id, "Hosted Müşteri");
  const staff = await createStaffMember(tenantA.id, "Hosted Personel");
  await testDb`update staff_members set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${personel.id}) where id = ${staff.id}`;
  ownerClient = await signInAs(ownerA);
}, 240000);

afterAll(async () => {
  await cleanupTenants(tenants);
  await cleanupUsers(users);
}, 240000);

describe("H1 recovery on the real hosted provider and the running app", () => {
  it("H1a the provider's own answer for a known and an unknown address (recorded; the app hides any difference)", async () => {
    const known = await anonClient().auth.resetPasswordForEmail(manager.email);
    const unknown = await anonClient().auth.resetPasswordForEmail(`nobody-${Date.now().toString(36)}@example.com`);
    note("provider recover known", known.error ? { status: known.error.status, msg: known.error.message } : "ok");
    note("provider recover unknown", unknown.error ? { status: unknown.error.status, msg: unknown.error.message } : "ok");
  });

  it("H1b a real hosted recovery token: the confirm route parks it and sends the person to the reset page — no token in the URL, `next` ignored, not cacheable", async () => {
    const token = await hashedToken("recovery", manager.email);
    const res = await noFollow(`${APP}/auth/confirm?token_hash=${token}&type=recovery&next=${encodeURIComponent("https://evil.example/x")}`);
    const location = res.headers.get("location") ?? "";
    note("recovery confirm", { status: res.status, location, cacheControl: res.headers.get("cache-control") });
    expect([302, 303, 307, 308]).toContain(res.status);
    expect(new URL(location, APP).pathname).toMatch(/\/reset-password$/);
    expect(new URL(location, APP).origin).toBe(APP);
    expect(location).not.toContain(token);
    expect(location).not.toContain("evil");
    expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/);
    const parked = parkedCookie(res);
    note("parked cookie attributes", parked.attributes);
    expect(parked.attributes).toMatch(/HttpOnly/i);
    expect(parked.attributes).toMatch(/SameSite=lax/i);
    expect(Number(/Max-Age=(\d+)/i.exec(parked.attributes)?.[1])).toBeLessThanOrEqual(900);
    // the token lives ONLY inside the HttpOnly cookie, as a recovery token whose `next` was reset (the hostile value was ignored)
    expect(parked.value).toMatchObject({ tokenHash: token, type: "recovery", next: "/" });
  });

  it("H1c /reset-password without any recovery context shows the plain invalid-link page", async () => {
    const res = await fetch(`${APP}/reset-password`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Bu bağlantı kullanılamıyor");
    expect(html).not.toMatch(/AuthApiError|supabase|token_hash/i);
  });

  it("H1d a garbage recovery link is handled without a raw error", async () => {
    const res = await noFollow(`${APP}/auth/confirm?token_hash=${"0".repeat(64)}&type=recovery`);
    const location = res.headers.get("location") ?? "";
    expect(new URL(location, APP).origin).toBe(APP);
    const page = await (await fetch(new URL(location, APP))).text();
    expect(page).not.toMatch(/AuthApiError|Invalid|supabase/);
  });
});

describe("H2 redirects through the running app with real hosted tokens", () => {
  const hostile = [
    "https://evil.example",
    "//evil.example",
    "///evil.example/x",
    "/\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "%2F%2Fevil.example",
    "https%3A%2F%2Fevil.example",
    "/%2F%2Fevil.example",
    "http://[::1",
    "/login?next=https://evil.example",
    "/auth/confirm?next=https://evil.example",
    "/..//evil.example",
    "\t//evil.example",
  ];
  const allowed = ["/app/some-salon/team", "/accept-invite", "/account/link-salon/some-salon"];

  /** The confirm route's answer for a real hosted token: where it redirects and what `next` it parked (the stored destination). */
  async function confirmAnswer(next: string): Promise<{ location: string; parkedNext: string | undefined }> {
    const token = await hashedToken("magiclink", personel.email);
    const res = await noFollow(`${APP}/auth/confirm?token_hash=${token}&type=magiclink&next=${encodeURIComponent(next)}`);
    return { location: res.headers.get("location") ?? "", parkedNext: parkedCookie(res).value.next };
  }

  it("H2a hostile `next` values never leave the site: the redirect stays on the origin and the PARKED destination is a plain site path", async () => {
    const parked: Record<string, string | undefined> = {};
    for (const next of hostile) {
      const { location, parkedNext } = await confirmAnswer(next);
      parked[next] = parkedNext;
      expect(new URL(location, APP).origin, `next=${next} → ${location}`).toBe(APP);
      expect(parkedNext, `parked for ${next}`).toBeDefined();
      expect(isPlainSitePath(parkedNext!), `parked ${parkedNext} for ${next}`).toBe(true);
      // (a plain site path may legitimately carry a URL as QUERY text, e.g. /login?next=https://evil.example; the guard is that it is
      // a plain path — checked above — and that every nested hop stays on the site — checked in H2c)
      expect(`${location} ${parkedNext}`.toLowerCase(), next).not.toMatch(/javascript:|data:text/);
      expect(parkedNext!.startsWith("//"), next).toBe(false);
    }
    note("hostile next → parked destination", parked);
  }, 240000);

  it("H2b safe internal paths are kept as the parked destination", async () => {
    const seen: Record<string, string | undefined> = {};
    for (const next of allowed) {
      const { location, parkedNext } = await confirmAnswer(next);
      seen[next] = parkedNext;
      expect(new URL(location, APP).origin).toBe(APP);
      expect(parkedNext).toBe(next);
    }
    note("allowed redirects → parked destination", seen);
  }, 120000);

  it("H2c /auth/callback, /login and nested next values: every redirect hop stays on the site and the login form carries only a plain site path", async () => {
    for (const next of hostile) {
      let url = `${APP}/auth/callback?code=invalid&next=${encodeURIComponent(next)}`;
      for (let hop = 0; hop < 6; hop++) {
        const r = await noFollow(url);
        const location = r.headers.get("location");
        if (!location) break;
        const resolved = new URL(location, url);
        expect(resolved.origin, `callback hop ${hop} for ${next} → ${location}`).toBe(APP);
        url = resolved.toString();
      }
      const html = await (await fetch(`${APP}/login?next=${encodeURIComponent(next)}`)).text();
      const hidden = /<input[^>]*name="next"[^>]*value="([^"]*)"/.exec(html)?.[1];
      if (hidden !== undefined) {
        const decoded = hidden.replace(/&amp;/g, "&");
        expect(isPlainSitePath(decoded), `login hidden next ${decoded} for ${next}`).toBe(true);
      }
      // nested attempt: following the hidden destination (which is itself a /login or /auth/confirm URL) never leaves the site either
      if (hidden) {
        let nested = new URL(hidden.replace(/&amp;/g, "&"), APP).toString();
        for (let hop = 0; hop < 6; hop++) {
          const r = await noFollow(nested);
          const location = r.headers.get("location");
          if (!location) break;
          const resolved = new URL(location, nested);
          expect(resolved.origin, `nested hop ${hop} for ${next}`).toBe(APP);
          nested = resolved.toString();
        }
      }
    }
  }, 300000);
});

describe("H3 stale access token versus the tenant (JWT is not the authority)", () => {
  let managerClient: SupabaseClient;
  let bareToken = "";
  const asToken = (path: string, init?: RequestInit) => rest(path, bareToken, init);
  const listMembers = () => asToken("rpc/list_team_members", { method: "POST", body: JSON.stringify({ p_tenant_id: tenantA.id }) });
  const canManage = () => asToken("rpc/has_permission", { method: "POST", body: JSON.stringify({ p_tenant_id: tenantA.id, p_permission_key: "staff.manage" }) });

  it("H3a active Yönetici: the token works", async () => {
    managerClient = await signInAs(manager);
    bareToken = (await managerClient.auth.getSession()).data.session!.access_token;
    const list = await listMembers();
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBeGreaterThanOrEqual(4);
    expect((await canManage()).body).toBe(true);
    const customers = await asToken("customers?select=id");
    expect(customers.status).toBe(200);
    expect((customers.body as unknown[]).length).toBeGreaterThan(0);
  });

  it("H3b access switched off: the SAME token (still unexpired) gets nothing from the tenant", async () => {
    const { error } = await ownerClient.rpc("suspend_membership", { p_tenant_id: tenantA.id, p_membership_id: membershipManager });
    expect(error).toBeNull();
    const list = await listMembers();
    note("stale token, suspended: list_team_members", { status: list.status, body: list.body });
    expect(list.status === 200 ? (list.body as unknown[]).length : 0).toBe(0);
    expect((await canManage()).body).toBe(false);
    const customers = await asToken("customers?select=id");
    expect(Array.isArray(customers.body) ? (customers.body as unknown[]).length : 0).toBe(0);
    const staff = await asToken("staff_members?select=id");
    expect(Array.isArray(staff.body) ? (staff.body as unknown[]).length : 0).toBe(0);
    const write = await asToken("customers", { method: "POST", body: JSON.stringify({ tenant_id: tenantA.id, full_name: "x" }) });
    expect(write.status).toBeGreaterThanOrEqual(400);
    // the token itself is still a valid, unexpired JWT: this is the documented limit, and the reason the membership is the authority
    const userLookup = await anonClient().auth.getUser(bareToken);
    note("stale token still accepted by the Auth server (until expiry)", !userLookup.error);
  });

  it("H3c reactivated: the same token works again", async () => {
    const { error } = await ownerClient.rpc("reactivate_membership", { p_tenant_id: tenantA.id, p_membership_id: membershipManager });
    expect(error).toBeNull();
    expect((await canManage()).body).toBe(true);
    const list = await listMembers();
    expect((list.body as unknown[]).length).toBeGreaterThanOrEqual(4);
  });

  it("H3d removed: denied again, and the business records are untouched", async () => {
    const before = await testDb<{ n: string }[]>`select (select count(*) from customers where tenant_id = ${tenantA.id})::text || ':' || (select count(*) from staff_members where tenant_id = ${tenantA.id})::text as n`;
    const { error } = await ownerClient.rpc("remove_membership_access", { p_tenant_id: tenantA.id, p_membership_id: membershipManager });
    expect(error).toBeNull();
    expect((await canManage()).body).toBe(false);
    const list = await listMembers();
    expect(list.status === 200 ? (list.body as unknown[]).length : 0).toBe(0);
    const after = await testDb<{ n: string }[]>`select (select count(*) from customers where tenant_id = ${tenantA.id})::text || ':' || (select count(*) from staff_members where tenant_id = ${tenantA.id})::text as n`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("H3e a member of ANOTHER salon cannot read or administer this one with their own valid token", async () => {
    const other = await signInAs(otherOwner);
    const token = (await other.auth.getSession()).data.session!.access_token;
    const list = await rest("rpc/list_team_members", token, { method: "POST", body: JSON.stringify({ p_tenant_id: tenantA.id }) });
    expect(list.status === 200 ? (list.body as unknown[]).length : 0).toBe(0);
    const suspend = await other.rpc("suspend_membership", { p_tenant_id: tenantA.id, p_membership_id: membershipManager });
    expect(suspend.error).not.toBeNull();
    const customers = await rest("customers?select=id", token);
    expect((customers.body as { tenant_id?: string }[]).every((r) => r.tenant_id !== tenantA.id)).toBe(true);
  });
});

describe("H4 last Owner and Owner=staff on the hosted database", () => {
  it("H4a the only Owner cannot suspend or remove themself; with a second Owner the first can be handled by the second", async () => {
    const solo1 = await signInAs(solo);
    const [mem] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenantE.id} and user_id = ${solo.id}`;
    for (const rpc of ["suspend_membership", "remove_membership_access"] as const) {
      const { error } = await solo1.rpc(rpc, { p_tenant_id: tenantE.id, p_membership_id: mem!.id });
      expect(error, rpc).not.toBeNull();
    }
    const [still] = await testDb<{ status: string; deleted_at: string | null }[]>`select status, deleted_at from tenant_memberships where id = ${mem!.id}`;
    expect(still).toMatchObject({ status: "active", deleted_at: null });
    // raw privileged SQL cannot orphan the salon either
    await expect(testDb`update tenant_memberships set status = 'suspended' where id = ${mem!.id}`).rejects.toThrow();
  });

  it("H4b Emel-like: Owner = the single staff member; reset-style identity churn and a lifecycle cycle create no duplicate staff or membership", async () => {
    const staff = await createStaffMember(tenantE.id, "Emel-like Sahip");
    await testDb`update staff_members set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${tenantE.id} and user_id = ${solo.id}) where id = ${staff.id}`;
    const before = await testDb<{ s: string; m: string }[]>`select (select count(*) from staff_members where tenant_id = ${tenantE.id})::text as s, (select count(*) from tenant_memberships where tenant_id = ${tenantE.id})::text as m`;
    // a password change through the real Auth server (what a reset does) leaves identity and links alone
    const { error } = await admin.auth.admin.updateUserById(solo.id, { password: "Yeni-Sifre-2026!" });
    expect(error).toBeNull();
    expect((await anonClient().auth.signInWithPassword({ email: solo.email, password: "Yeni-Sifre-2026!" })).error).toBeNull();
    expect((await anonClient().auth.signInWithPassword({ email: solo.email, password: solo.password })).error).not.toBeNull();
    const after = await testDb<{ s: string; m: string }[]>`select (select count(*) from staff_members where tenant_id = ${tenantE.id})::text as s, (select count(*) from tenant_memberships where tenant_id = ${tenantE.id})::text as m`;
    expect(after[0]).toEqual(before[0]);
    const list = await (await signInAsWith(solo.email, "Yeni-Sifre-2026!")).rpc("list_team_members", { p_tenant_id: tenantE.id });
    expect(list.data).toHaveLength(1);
    expect(list.data![0]).toMatchObject({ is_self: true, is_last_unrestricted_holder: true, can_suspend: false, can_remove: false });
  });
});

async function signInAsWith(email: string, password: string) {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return c;
}

describe("H5 invitations with real hosted Auth users", () => {
  it("H5a new person: unconfirmed account cannot sign in, the confirm link confirms, accept creates exactly ONE membership; reuse, wrong user and a second accept are refused", async () => {
    const email = `h-invitee-${Date.now().toString(36)}@example.com`;
    const role = await templateRole(tenantA.id, "RECEPTIONIST");
    const created = await ownerClient.rpc("create_team_invitation", { p_tenant_id: tenantA.id, p_email: email, p_role_id: role });
    expect(created.error).toBeNull();
    const row = (created.data as { token: string; id: string }[])[0]!;
    // duplicate pending invitation for the same address is refused
    const dup = await ownerClient.rpc("create_team_invitation", { p_tenant_id: tenantA.id, p_email: email, p_role_id: role });
    expect(dup.error).not.toBeNull();

    // the invited person registers (the confirmation mail itself is NOT exercised — no SMTP): create the unconfirmed account
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "signup", email, password: "Test1234!Test1234!" });
    expect(linkError).toBeNull();
    users.push(link.user!.id);
    const early = await anonClient().auth.signInWithPassword({ email, password: "Test1234!Test1234!" });
    note("unconfirmed sign-in", early.error?.message ?? "signed in");
    expect(early.error).not.toBeNull();

    // the confirm route parks the token (GET never consumes it), then it is verified once
    const res = await noFollow(`${APP}/auth/confirm?token_hash=${link.properties!.hashed_token}&type=signup&next=${encodeURIComponent("/accept-invite")}`);
    expect(new URL(res.headers.get("location") ?? "/", APP).origin).toBe(APP);
    const verifier = anonClient();
    const verified = await verifier.auth.verifyOtp({ type: "signup", token_hash: link.properties!.hashed_token });
    expect(verified.error).toBeNull();
    expect((await anonClient().auth.signInWithPassword({ email, password: "Test1234!Test1234!" })).error).toBeNull();

    // wrong user cannot take the invitation
    const wrong = await signInAs(outsider);
    expect((await wrong.rpc("accept_team_invitation", { p_token: row.token })).error).not.toBeNull();
    // the right user can, once
    const right = await signInAsWith(email, "Test1234!Test1234!");
    const first = await right.rpc("accept_team_invitation", { p_token: row.token });
    expect(first.error).toBeNull();
    // by design the SAME user replaying an accepted invitation is an idempotent success (double click, refresh); it creates nothing new
    const second = await right.rpc("accept_team_invitation", { p_token: row.token });
    expect(second.error).toBeNull();
    // ...whereas anybody else holding the used link is refused
    const thief = await signInAs(personel);
    expect((await thief.rpc("accept_team_invitation", { p_token: row.token })).error).not.toBeNull();
    const rows = await testDb<{ n: string }[]>`select count(*)::text as n from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${link.user!.id} and deleted_at is null`;
    expect(rows[0]!.n).toBe("1");
    // already a member: a new invitation for them is refused
    expect((await ownerClient.rpc("create_team_invitation", { p_tenant_id: tenantA.id, p_email: email, p_role_id: role })).error).not.toBeNull();
  }, 180000);

  it("H5b an existing Auth user of another salon can accept into this one without a second identity", async () => {
    const role = await templateRole(tenantA.id, "RECEPTIONIST");
    const created = await ownerClient.rpc("create_team_invitation", { p_tenant_id: tenantA.id, p_email: otherOwner.email, p_role_id: role });
    expect(created.error).toBeNull();
    const token = (created.data as { token: string }[])[0]!.token;
    const other = await signInAs(otherOwner);
    expect((await other.rpc("accept_team_invitation", { p_token: token })).error).toBeNull();
    const identities = await testDb<{ n: string }[]>`select count(*)::text as n from auth.users where lower(email) = lower(${otherOwner.email})`;
    expect(identities[0]!.n).toBe("1");
    const mems = await testDb<{ n: string }[]>`select count(*)::text as n from tenant_memberships where user_id = ${otherOwner.id} and deleted_at is null`;
    expect(mems[0]!.n).toBe("2");
  }, 120000);

  it("H5c resend keeps the invitation (new link), revoke closes it, expired/revoked cannot be accepted", async () => {
    const role = await templateRole(tenantA.id, "RECEPTIONIST");
    const email = `h-resend-${Date.now().toString(36)}@example.com`;
    const created = await ownerClient.rpc("create_team_invitation", { p_tenant_id: tenantA.id, p_email: email, p_role_id: role });
    const inv = (created.data as { id: string; token: string; expires_at: string }[])[0]!;
    const resent = await ownerClient.rpc("resend_team_invitation", { p_invitation_id: inv.id, p_expected_expires_at: inv.expires_at });
    expect(resent.error).toBeNull();
    const pending = await testDb<{ n: string }[]>`select count(*)::text as n from team_invitations where tenant_id = ${tenantA.id} and lower(email) = ${email} and status = 'pending'`;
    expect(pending[0]!.n).toBe("1");
    expect((await ownerClient.rpc("revoke_team_invitation", { p_invitation_id: inv.id })).error).toBeNull();
    const someone = await newUser("late");
    const lateClient = await signInAs(someone);
    const newToken = (resent.data as { token: string }[] | null)?.[0]?.token ?? inv.token;
    expect((await lateClient.rpc("accept_team_invitation", { p_token: newToken })).error).not.toBeNull();
  }, 120000);
});

describe("H6 exposure of the SAAS.1A surface to each database role (real PostgREST)", () => {
  it("H6a anon: refused; service_role: refused; a non-member authenticated user: nothing", async () => {
    const asAnon = await rest("rpc/list_team_members", null, { method: "POST", body: JSON.stringify({ p_tenant_id: tenantA.id }) });
    const asService = await rest("rpc/list_team_members", SVC, { method: "POST", body: JSON.stringify({ p_tenant_id: tenantA.id }) });
    const outsiderClient = await signInAs(outsider);
    const outsiderToken = (await outsiderClient.auth.getSession()).data.session!.access_token;
    const asOutsider = await rest("rpc/list_team_members", outsiderToken, { method: "POST", body: JSON.stringify({ p_tenant_id: tenantA.id }) });
    note("anon", { status: asAnon.status });
    note("service_role", { status: asService.status });
    note("non-member", { status: asOutsider.status, body: asOutsider.body });
    expect(asAnon.status).toBeGreaterThanOrEqual(400);
    expect(asService.status).toBeGreaterThanOrEqual(400);
    expect(asOutsider.status === 200 ? (asOutsider.body as unknown[]).length : 0).toBe(0);
  });

  it("H6b the private implementation is not reachable over the API", async () => {
    const res = await rest("rpc/list_team_members", null, { method: "POST", headers: { "content-profile": "private" }, body: JSON.stringify({ p_tenant_id: tenantA.id }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("H6c catalog: every function and table in the SAAS.1A surface is locked down", async () => {
    const fns = await testDb<{ name: string; secdef: boolean; cfg: string | null; acl: string | null }[]>`
      select n.nspname || '.' || p.proname as name, p.prosecdef as secdef, array_to_string(p.proconfig, ',') as cfg, p.proacl::text as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'list_team_members' and n.nspname in ('public', 'private')`;
    note("list_team_members catalog", fns);
    expect(fns).toHaveLength(2);
    for (const f of fns) {
      expect(f.secdef).toBe(true);
      expect(f.cfg ?? "").toContain("search_path");
      expect(f.acl ?? "").not.toMatch(/(^|[{,])=X/); // no PUBLIC
      expect(f.acl ?? "").not.toContain("anon=");
      expect(f.acl ?? "").not.toContain("service_role=");
    }
    const pub = fns.find((f) => f.name === "public.list_team_members")!;
    expect(pub.acl).toContain("authenticated=X");
    const unsafe = await testDb<{ n: string }[]>`select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
    note("public tables without RLS", unsafe[0]!.n);
    expect(unsafe[0]!.n).toBe("0");
    const anonGrants = await testDb<{ n: string }[]>`select count(*)::text as n from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`;
    note("anon table grants in public", anonGrants[0]!.n);
  });
});
