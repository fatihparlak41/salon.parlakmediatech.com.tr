import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { PENDING_TEAM_INVITATION_COOKIE } from "@/lib/auth/team-invitation-token";
import { getSiteUrl } from "@/lib/site-url";
import { acceptTeamInvitationAction } from "@/lib/modules/team/accept-actions";
import { signInAction, signOutAction, signUpAction } from "@/lib/modules/auth/actions";
import {
  addMembership,
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  randomTokenHex,
  sha256Hex,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1D.2 — the Server Action layer: the accept action, and the
 * three auth actions whose behavior this phase touched (return path after
 * login, `emailRedirectTo` for an invited sign-up, sign-out that returns
 * to /accept-invite).
 *
 * Server Actions need Next's request scope (cookies(), redirect()), which
 * doesn't exist under Vitest. Following the narrow-mock precedent of
 * session-permission-contract.test.ts, exactly three modules are stubbed:
 * next/headers (an in-memory cookie jar that honors Max-Age=0 deletes),
 * next/navigation (redirect() throws, as the real one does), and
 * @/lib/supabase/server's createClient (returns whichever client the test
 * installed — a REAL signed-in client for the journeys that must prove
 * database truth, a fake for pure-wiring assertions). Everything else —
 * the actions themselves, getCurrentUser, the cookie helpers, the core
 * acceptance logic, the RPC — is the real code.
 *
 * No test here sends an email: invitations come from the
 * create_team_invitation RPC directly, sign-up is exercised against a
 * fake Supabase client, and no test calls the real signUp.
 */

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  type CookieWrite = { name: string; value: string; options: Record<string, unknown> | undefined };
  return {
    RedirectSignal,
    jar: new Map<string, string>(),
    writes: [] as CookieWrite[],
    client: null as unknown,
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    has: (name: string) => h.jar.has(name),
    getAll: () => [...h.jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      h.writes.push({ name, value, options });
      // Same as a browser: an empty value or Max-Age=0 removes the cookie.
      if (value === "" || options?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
    delete: (name: string) => {
      h.writes.push({ name, value: "", options: { deleted: true } });
      h.jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
}));

type Outcome<T> = { kind: "returned"; value: T } | { kind: "redirected"; url: string };

async function run<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { kind: "returned", value: await fn() };
  } catch (error) {
    if (error instanceof h.RedirectSignal) return { kind: "redirected", url: error.url };
    throw error;
  }
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function park(token: string) {
  h.jar.set(PENDING_TEAM_INVITATION_COOKIE, token);
}

function pendingClearWrites() {
  return h.writes.filter((w) => w.name === PENDING_TEAM_INVITATION_COOKIE && (w.value === "" || w.options?.maxAge === 0));
}

/** A client with no network behind it: `auth.getUser` yields a user (or none) and `rpc` is a spy. */
function fakeAuthed(user: { id: string } | null) {
  const rpc = vi.fn();
  const client = {
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) },
    rpc,
    from: vi.fn(),
  } as unknown as SupabaseClient<Database>;
  return { client, rpc };
}

beforeEach(() => {
  h.jar.clear();
  h.writes.length = 0;
  h.client = null;
});

// ---------------------------------------------------------------------------
// Real-database fixtures for the journeys that must prove ground truth.
// ---------------------------------------------------------------------------

let owner: TestUser;
let ownerClient: SupabaseClient<Database>;
let tenant: TestTenant;
let roleId: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

beforeAll(async () => {
  owner = await createTestUser("aia-owner");
  createdUserIds.push(owner.id);
  tenant = await createTestTenant(`test-tenant-aia-${Date.now().toString(36)}`, owner.id);
  createdTenantIds.push(tenant.id);
  roleId = await createRoleForTenant(tenant.id, "Davet Rolü", ["appointments.view"]);
  ownerClient = await signInAs(owner);
}, 60000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 90000);

async function newUser(label: string): Promise<{ user: TestUser; client: SupabaseClient<Database> }> {
  const user = await createTestUser(label);
  createdUserIds.push(user.id);
  return { user, client: await signInAs(user) };
}

async function invite(email: string): Promise<{ id: string; token: string }> {
  // The RPC directly — never createTeamInvitationCore — so no email is sent.
  const { data, error } = await ownerClient.rpc("create_team_invitation", {
    p_tenant_id: tenant.id,
    p_email: email,
    p_role_id: roleId,
  });
  if (error || !data) throw new Error(`invitation setup failed: ${error?.message}`);
  return (data as { id: string; token: string }[])[0]!;
}

async function state(invitationId: string, userId: string) {
  const [row] = await testDb<{ status: string; accepted_by: string | null }[]>`
    select status, accepted_by from team_invitations where id = ${invitationId}
  `;
  const [members] = await testDb<{ n: number }[]>`
    select count(*)::int as n from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${userId}
  `;
  return { status: row!.status, acceptedBy: row!.accepted_by, memberships: members!.n };
}

// ---------------------------------------------------------------------------

describe("acceptTeamInvitationAction", () => {
  it("takes no token argument at all: the only parameter is React's previous-state slot", () => {
    expect(acceptTeamInvitationAction.length).toBe(1);
  });

  it("without a signed-in user: unauthenticated, the database is never called, the parked token is kept", async () => {
    const { client, rpc } = fakeAuthed(null);
    h.client = client;
    park("ab".repeat(32));

    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome.kind).toBe("returned");
    if (outcome.kind === "returned" && !outcome.value.success) {
      expect(outcome.value.error.reason).toBe("unauthenticated");
    } else {
      throw new Error("expected a failure result");
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(true);
  });

  it("signed in but nothing parked (cookie missing/expired): missing_token, the database is never called", async () => {
    const { client, rpc } = fakeAuthed({ id: "user-1" });
    h.client = client;

    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome.kind).toBe("returned");
    if (outcome.kind === "returned" && !outcome.value.success) {
      expect(outcome.value.error.reason).toBe("missing_token");
      expect(outcome.value.error.message).toContain("e-postanızdaki davet bağlantısına tekrar tıklayın");
    } else {
      throw new Error("expected a failure result");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a tampered cookie (wrong shape) is treated as no cookie — client-supplied data is re-validated on every read", async () => {
    const { client, rpc } = fakeAuthed({ id: "user-1" });
    h.client = client;
    park("' or 1=1 --");

    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome.kind).toBe("returned");
    if (outcome.kind === "returned" && !outcome.value.success) {
      expect(outcome.value.error.reason).toBe("missing_token");
    } else {
      throw new Error("expected a failure result");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("matching user: accepts, clears the parked token (same path/attributes it was set with), and redirects into the salon", async () => {
    const { user, client } = await newUser("aia-match");
    const invitation = await invite(user.email);
    h.client = client;
    park(invitation.token);

    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome).toEqual({ kind: "redirected", url: `/app/${tenant.slug}` });
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(false);

    const clear = pendingClearWrites().at(-1);
    expect(clear).toBeDefined();
    expect(clear!.value).toBe("");
    expect(clear!.options).toMatchObject({ maxAge: 0, path: "/", httpOnly: true, sameSite: "lax" });

    expect(await state(invitation.id, user.id)).toEqual({ status: "accepted", acceptedBy: user.id, memberships: 1 });
  });

  it("wrong user: refused, the parked token is KEPT (so the switch-account button works), nothing is created — then the right user succeeds", async () => {
    const invited = await newUser("aia-invited");
    const wrong = await newUser("aia-wrong");
    const invitation = await invite(invited.user.email);
    park(invitation.token);

    h.client = wrong.client;
    const refused = await run(() => acceptTeamInvitationAction(null));

    expect(refused.kind).toBe("returned");
    if (refused.kind === "returned" && !refused.value.success) {
      expect(refused.value.error.reason).toBe("email_mismatch");
      expect(refused.value.error.message).not.toContain(invited.user.email);
      const json = JSON.stringify(refused.value);
      expect(json).not.toContain(invitation.token);
      expect(json).not.toContain(sha256Hex(invitation.token));
    } else {
      throw new Error("expected a failure result");
    }
    expect(h.jar.get(PENDING_TEAM_INVITATION_COOKIE)).toBe(invitation.token);
    expect(pendingClearWrites()).toHaveLength(0);
    expect(await state(invitation.id, wrong.user.id)).toMatchObject({ status: "pending", memberships: 0 });

    // "Çıkış Yap ve Farklı Hesapla Giriş Yap" → the right account, same cookie.
    h.client = invited.client;
    const accepted = await run(() => acceptTeamInvitationAction(null));
    expect(accepted).toEqual({ kind: "redirected", url: `/app/${tenant.slug}` });
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(false);
  });

  it("expired invitation: refused with the expiry message and the dead token is cleared", async () => {
    const { user, client } = await newUser("aia-expired");
    const rawToken = randomTokenHex();
    await testDb`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenant.id}, ${user.email}, ${roleId}, ${owner.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
    `;
    h.client = client;
    park(rawToken);

    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome.kind).toBe("returned");
    if (outcome.kind === "returned" && !outcome.value.success) {
      expect(outcome.value.error.reason).toBe("expired");
      expect(outcome.value.error.message).toBe("Bu davetin süresi dolmuş.");
    } else {
      throw new Error("expected a failure result");
    }
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(false);
    expect((await testDb`select 1 from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${user.id}`).length).toBe(0);
  });

  it("revoked invitation: refused with the revocation message and the dead token is cleared", async () => {
    const { user, client } = await newUser("aia-revoked");
    const invitation = await invite(user.email);
    expect((await ownerClient.rpc("revoke_team_invitation", { p_invitation_id: invitation.id })).error).toBeNull();
    h.client = client;
    park(invitation.token);

    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome.kind).toBe("returned");
    if (outcome.kind === "returned" && !outcome.value.success) {
      expect(outcome.value.error.reason).toBe("revoked");
      expect(outcome.value.error.message).toBe("Bu davet iptal edilmiş.");
    } else {
      throw new Error("expected a failure result");
    }
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(false);
    expect((await state(invitation.id, user.id)).memberships).toBe(0);
  });

  it("an unknown (well-formed) token: not_found and cleared", async () => {
    const { client } = await newUser("aia-unknown");
    h.client = client;
    park(randomTokenHex());

    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome.kind).toBe("returned");
    if (outcome.kind === "returned" && !outcome.value.success) {
      expect(outcome.value.error.reason).toBe("not_found");
    } else {
      throw new Error("expected a failure result");
    }
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(false);
  });

  it("suspended member: refused, the token is kept (reinstatement could make it valid), the membership stays suspended", async () => {
    const { user, client } = await newUser("aia-suspended");
    const invitation = await invite(user.email);
    const membershipId = await addMembership(tenant.id, user.id, roleId);
    await testDb`update tenant_memberships set status = 'suspended' where id = ${membershipId}`;
    h.client = client;
    park(invitation.token);

    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome.kind).toBe("returned");
    if (outcome.kind === "returned" && !outcome.value.success) {
      expect(outcome.value.error.reason).toBe("membership_suspended");
    } else {
      throw new Error("expected a failure result");
    }
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(true);
    const [membership] = await testDb<{ status: string }[]>`select status from tenant_memberships where id = ${membershipId}`;
    expect(membership!.status).toBe("suspended");
  });

  it("re-clicking an already-accepted invitation email as the same user is a success, not an error (idempotent replay)", async () => {
    const { user, client } = await newUser("aia-replay");
    const invitation = await invite(user.email);
    h.client = client;

    park(invitation.token);
    const first = await run(() => acceptTeamInvitationAction(null));
    park(invitation.token); // the person clicks the same email link again
    const second = await run(() => acceptTeamInvitationAction(null));

    expect(first).toEqual({ kind: "redirected", url: `/app/${tenant.slug}` });
    expect(second).toEqual({ kind: "redirected", url: `/app/${tenant.slug}` });
    expect((await state(invitation.id, user.id)).memberships).toBe(1);
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(false);
  });
});

describe("signInAction — login only navigates, it never accepts", () => {
  it("REAL login with a pending invitation for this very user and a parked token: redirects to /accept-invite, accepts NOTHING, keeps the token", async () => {
    const { user } = await newUser("aia-login");
    const invitation = await invite(user.email);
    park(invitation.token);
    h.client = anonClient(); // the action signs in on it, exactly like a real request's fresh client

    const outcome = await run(() =>
      signInAction(null, form({ email: user.email, password: user.password, next: "/accept-invite" })),
    );

    expect(outcome).toEqual({ kind: "redirected", url: "/accept-invite" });
    // The point of the whole design: the person is now signed in AND holds a
    // valid, matching invitation — and still nothing has been accepted.
    expect(await state(invitation.id, user.id)).toEqual({ status: "pending", acceptedBy: null, memberships: 0 });
    expect(h.jar.get(PENDING_TEAM_INVITATION_COOKIE)).toBe(invitation.token);
    expect(h.writes).toHaveLength(0);
  });

  function fakeSignIn(error: { message: string } | null = null) {
    const signInWithPassword = vi.fn(async () => ({ data: {}, error }));
    h.client = { auth: { signInWithPassword } };
    return signInWithPassword;
  }

  const creds = { email: "someone@example.com", password: "whatever-password" };

  it("redirects to / when no return path was carried (unchanged default)", async () => {
    fakeSignIn();
    expect(await run(() => signInAction(null, form(creds)))).toEqual({ kind: "redirected", url: "/" });
  });

  it.each(["/accept-invite", "/app", "/app/some-salon", "/app/some-salon/team"])(
    "honors the same-origin return path %s",
    async (next) => {
      fakeSignIn();
      expect(await run(() => signInAction(null, form({ ...creds, next })))).toEqual({ kind: "redirected", url: next });
    },
  );

  it.each([
    "//evil.com",
    "//evil.com/accept-invite",
    "/\\evil.com",
    "https://evil.example/steal",
    "http://evil.example",
    "javascript:alert(1)",
    "data:text/html,x",
    "http://[::1",
  ])("never redirects off-site: hostile return path %j falls back to /", async (next) => {
    fakeSignIn();
    expect(await run(() => signInAction(null, form({ ...creds, next })))).toEqual({ kind: "redirected", url: "/" });
  });

  it("an empty `next` field behaves as absent", async () => {
    fakeSignIn();
    expect(await run(() => signInAction(null, form({ ...creds, next: "" })))).toEqual({ kind: "redirected", url: "/" });
  });

  it("a failed login returns the generic error, does not redirect, and does not touch the parked token", async () => {
    fakeSignIn({ message: "Invalid login credentials" });
    park("cd".repeat(32));

    const outcome = await run(() => signInAction(null, form({ ...creds, next: "/accept-invite" })));

    expect(outcome.kind).toBe("returned");
    if (outcome.kind === "returned") {
      expect(outcome.value).toEqual({ success: false, error: { code: "UNAUTHENTICATED", message: "E-posta veya şifre hatalı" } });
    }
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(true);
    expect(h.writes).toHaveLength(0);
  });
});

describe("signUpAction — an invited sign-up returns to /accept-invite through the existing confirmation flow", () => {
  const fields = { fullName: "Yeni Kullanıcı", email: "new.person@example.com", password: "Test1234!Test1234!" };

  function fakeSignUp(error: { code?: string; status?: number; message?: string } | null = null) {
    const signUp = vi.fn(async () => ({ data: {}, error }));
    h.client = { auth: { signUp } };
    return signUp;
  }

  function redirectTo(signUp: ReturnType<typeof fakeSignUp>): unknown {
    const call = signUp.mock.calls[0] as unknown as [{ options: { emailRedirectTo: string } }];
    return call[0].options.emailRedirectTo;
  }

  it("carries /accept-invite in emailRedirectTo when the form came from the invitation continuation screen", async () => {
    const signUp = fakeSignUp();
    const outcome = await run(() => signUpAction(null, form({ ...fields, next: "/accept-invite" })));

    expect(outcome).toEqual({ kind: "returned", value: { success: true, data: { email: fields.email } } });
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(redirectTo(signUp)).toBe(`${getSiteUrl()}/accept-invite`);
  });

  it("never puts the invitation token in the confirmation URL, even with one parked", async () => {
    const token = "ef".repeat(32);
    park(token);
    const signUp = fakeSignUp();

    await run(() => signUpAction(null, form({ ...fields, next: "/accept-invite" })));

    expect(JSON.stringify(signUp.mock.calls)).not.toContain(token);
    expect(String(redirectTo(signUp))).not.toContain("token");
    // …and the parked cookie is neither read into the request nor cleared by signing up.
    expect(h.jar.get(PENDING_TEAM_INVITATION_COOKIE)).toBe(token);
    expect(h.writes).toHaveLength(0);
  });

  it("is unchanged for an ordinary sign-up: no `next` → the bare site URL", async () => {
    const signUp = fakeSignUp();
    await run(() => signUpAction(null, form(fields)));
    expect(redirectTo(signUp)).toBe(getSiteUrl());
  });

  it("a bare / is not appended (still the bare site URL)", async () => {
    const signUp = fakeSignUp();
    await run(() => signUpAction(null, form({ ...fields, next: "/" })));
    expect(redirectTo(signUp)).toBe(getSiteUrl());
  });

  it.each(["//evil.com", "https://evil.example/x", "javascript:alert(1)", "/\\evil.com"])(
    "a hostile return path %j is discarded — emailRedirectTo stays on this site's own URL",
    async (next) => {
      const signUp = fakeSignUp();
      await run(() => signUpAction(null, form({ ...fields, next })));
      expect(redirectTo(signUp)).toBe(getSiteUrl());
    },
  );

  it("an existing address still maps to the CONFLICT message; other failures stay generic and don't echo the address", async () => {
    fakeSignUp({ code: "user_already_exists", status: 422 });
    const dupe = await run(() => signUpAction(null, form({ ...fields, next: "/accept-invite" })));
    expect(dupe).toEqual({
      kind: "returned",
      value: { success: false, error: { code: "CONFLICT", message: "Bu e-posta adresiyle zaten bir hesap var" } },
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeSignUp({ code: "email_address_invalid", status: 400, message: `Email address "${fields.email}" is invalid` });
    const other = await run(() => signUpAction(null, form(fields)));
    expect(other.kind).toBe("returned");
    if (other.kind === "returned") {
      expect(other.value).toEqual({
        success: false,
        error: { code: "UNEXPECTED", message: "Kayıt oluşturulamadı, lütfen tekrar deneyin" },
      });
    }
    expect(JSON.stringify(spy.mock.calls)).not.toContain(fields.email);
    spy.mockRestore();
  });

  it("invalid input never reaches Supabase", async () => {
    const signUp = fakeSignUp();
    const outcome = await run(() => signUpAction(null, form({ ...fields, password: "short", next: "/accept-invite" })));
    expect(outcome.kind).toBe("returned");
    expect(signUp).not.toHaveBeenCalled();
  });
});

describe("signOutAction — switch-account returns to /accept-invite with the parked token intact", () => {
  function fakeSignOut() {
    const signOut = vi.fn(async () => ({ error: null }));
    h.client = { auth: { signOut } };
    return signOut;
  }

  it("with next=/accept-invite: signs out, redirects there, and leaves the pending token alone", async () => {
    const signOut = fakeSignOut();
    const token = "12".repeat(32);
    park(token);

    const outcome = await run(() => signOutAction(form({ next: "/accept-invite" })));

    expect(outcome).toEqual({ kind: "redirected", url: "/accept-invite" });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(h.jar.get(PENDING_TEAM_INVITATION_COOKIE)).toBe(token);
    expect(h.writes).toHaveLength(0);
  });

  it("the sidebar's sign-out (a form with no `next`, or no form at all) still lands on / — unchanged", async () => {
    fakeSignOut();
    expect(await run(() => signOutAction(form({})))).toEqual({ kind: "redirected", url: "/" });
    expect(await run(() => signOutAction())).toEqual({ kind: "redirected", url: "/" });
  });

  it.each(["//evil.com", "https://evil.example", "javascript:alert(1)", "/\\evil.com"])(
    "a hostile return path %j falls back to /",
    async (next) => {
      fakeSignOut();
      expect(await run(() => signOutAction(form({ next })))).toEqual({ kind: "redirected", url: "/" });
    },
  );
});
