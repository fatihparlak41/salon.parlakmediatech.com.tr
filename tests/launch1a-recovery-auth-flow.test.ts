import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { admin, anonClient, cleanupUsers, createTestUser, testDb, type TestUser } from "./helpers";

/**
 * Faz LAUNCH.1A (acceptance) — the REAL reset-password finalization against a REAL Auth service, end to end: real
 * generateLink / verifyOtp / updateUser / signOut / password sign-in, the real service-role eligibility RPC and the real
 * resetPasswordAction. Only the Next request scope (cookies, redirect, after) is substituted. The backing Auth is
 * whatever TEST env points at (hosted DEV or a disposable branch in production use; a documented GoTrue MODEL in the
 * local rig) — the assertions are written against documented Auth behaviour only.
 *
 * The case that matters most: Supabase's recovery endpoint is PUBLIC, so a customer-only (passwordless, magic-link)
 * account can hold a perfectly valid recovery token without ever passing the forgot-password eligibility check. The
 * password-update boundary must still refuse to give such an account its first password.
 */

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { RedirectSignal, jar: new Map<string, string>(), afterTasks: [] as (() => Promise<unknown>)[] };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (name: string) => void h.jar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => Promise<unknown>) => void h.afterTasks.push(task) };
});
// The cookie-backed server client is replaced by a plain in-memory supabase-js client against the same Auth service.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () =>
    createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
}));

import { requestPasswordRecoveryAction, resetPasswordAction } from "@/lib/modules/auth/actions";
import { PASSWORD_RECOVERY_NEUTRAL_MESSAGE, RESET_INVALID_LINK_MESSAGE } from "@/lib/auth/password-recovery";

const COOKIE = "sb-pending-email-confirmation";
const NEW_PASSWORD = "Long-Passphrase-For-Reset-2026-ok";
const createdUserIds: string[] = [];

type Outcome = { kind: "returned"; value: Awaited<ReturnType<typeof resetPasswordAction>> } | { kind: "redirected"; url: string };
async function reset(password = NEW_PASSWORD): Promise<Outcome> {
  const form = new FormData();
  form.set("password", password);
  form.set("confirmPassword", password);
  try {
    return { kind: "returned", value: await resetPasswordAction(null, form) };
  } catch (error) {
    if (error instanceof h.RedirectSignal) return { kind: "redirected", url: error.url };
    throw error;
  }
}
/** What the e-mail link carries ({{ .TokenHash }}), minted by the Auth service itself — the same value an e-mail would hold. */
async function recoveryTokenHash(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed: ${error?.message}`);
  return data.properties.hashed_token;
}
const park = (tokenHash: string) => h.jar.set(COOKIE, JSON.stringify({ tokenHash, type: "recovery", next: "/" }));
const passwordColumn = async (id: string) =>
  (await testDb<{ has_password: boolean }[]>`select (coalesce(encrypted_password, '') <> '') as has_password from auth.users where id = ${id}`)[0]!.has_password;
const canSignIn = async (user: TestUser, password: string) => {
  const { error } = await anonClient().auth.signInWithPassword({ email: user.email, password });
  return !error;
};

async function passwordlessCustomer(): Promise<TestUser> {
  const email = `test-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}-l1a-customer@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email, password: "" };
}
async function staff(label: string): Promise<TestUser> {
  const user = await createTestUser(`l1a-rec-${label}`);
  createdUserIds.push(user.id);
  return user;
}

beforeEach(() => {
  h.jar.clear();
  h.afterTasks.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(async () => {
  await cleanupUsers(createdUserIds);
}, 120000);

describe("staff (password) account — the happy path against real Auth semantics", () => {
  it("token -> verifyOtp -> password update -> global sign-out: old password rejected, new (long) passphrase accepted, other sessions dead, token single-use", async () => {
    const user = await staff("happy");
    // a second, already-signed-in session that the reset must end
    const other = anonClient();
    const signedIn = await other.auth.signInWithPassword({ email: user.email, password: user.password });
    expect(signedIn.error).toBeNull();
    const oldRefresh = signedIn.data.session!.refresh_token;

    const tokenHash = await recoveryTokenHash(user.email);
    park(tokenHash);
    expect(await reset()).toEqual({ kind: "redirected", url: "/login?reset=success" });

    expect(h.jar.has(COOKIE)).toBe(false); // spent
    expect(await canSignIn(user, user.password)).toBe(false); // old password rejected
    expect(await canSignIn(user, NEW_PASSWORD)).toBe(true); // new accepted: a 33-character passphrase works
    const refreshed = await createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.refreshSession({ refresh_token: oldRefresh });
    expect(refreshed.error, "a session that existed before the reset must be revoked").not.toBeNull();

    // the same token cannot be used again
    park(tokenHash);
    const again = await reset("Another-Long-Passphrase-2026-xx");
    expect(again).toMatchObject({ kind: "returned", value: { success: false, error: { code: "UNAUTHENTICATED", message: RESET_INVALID_LINK_MESSAGE } } });
    expect(await canSignIn(user, "Another-Long-Passphrase-2026-xx")).toBe(false);
    expect(await canSignIn(user, NEW_PASSWORD)).toBe(true);
  }, 60000);

  it("a password of exactly 72 bytes is set; more than 72 bytes never reaches the Auth service", async () => {
    const user = await staff("limit");
    const at72 = "q".repeat(72);
    park(await recoveryTokenHash(user.email));
    expect(await reset(at72)).toEqual({ kind: "redirected", url: "/login?reset=success" });
    expect(await canSignIn(user, at72)).toBe(true);

    park(await recoveryTokenHash(user.email));
    const over = await reset("q".repeat(73));
    expect(over).toMatchObject({ kind: "returned", value: { success: false, error: { code: "VALIDATION" } } });
    expect(h.jar.has(COOKIE), "a rejected password must not burn the link").toBe(true);
  }, 60000);

  it("an unknown or garbage token is the neutral invalid-link answer and sets nothing", async () => {
    const user = await staff("garbage");
    park("0".repeat(64));
    expect(await reset()).toMatchObject({ kind: "returned", value: { success: false, error: { code: "UNAUTHENTICATED", message: RESET_INVALID_LINK_MESSAGE } } });
    expect(await canSignIn(user, NEW_PASSWORD)).toBe(false);
    expect(await canSignIn(user, user.password)).toBe(true);
  }, 60000);
});

describe("customer-only (passwordless, magic-link) account — must NOT become a password account", () => {
  it("DIRECT-PROVIDER BYPASS: a valid recovery token for a passwordless account is refused at the password-update boundary", async () => {
    const customer = await passwordlessCustomer();
    expect(await passwordColumn(customer.id)).toBe(false);

    // The provider issues the token regardless of whether the account has a password (this is the public /recover path)
    const tokenHash = await recoveryTokenHash(customer.email);
    park(tokenHash);
    const outcome = await reset();

    expect(outcome).toMatchObject({ kind: "returned", value: { success: false, error: { code: "UNAUTHENTICATED", message: RESET_INVALID_LINK_MESSAGE } } });
    expect(await passwordColumn(customer.id), "the account must still have NO password").toBe(false);
    expect(await canSignIn(customer, NEW_PASSWORD)).toBe(false);
    expect(h.jar.has(COOKIE)).toBe(false);
  }, 60000);

  it("the same refusal for an account that was passwordless, confirmed and later targeted twice; and the staff path for the SAME surface still works", async () => {
    const customer = await passwordlessCustomer();
    for (let i = 0; i < 2; i++) {
      park(await recoveryTokenHash(customer.email));
      expect(await reset(`${NEW_PASSWORD}-${i}`)).toMatchObject({ kind: "returned", value: { success: false } });
    }
    expect(await passwordColumn(customer.id)).toBe(false);
    const member = await staff("same-surface");
    park(await recoveryTokenHash(member.email));
    expect(await reset()).toEqual({ kind: "redirected", url: "/login?reset=success" });
  }, 90000);

  it("the forgot-password request path: a customer-only address gets the identical neutral answer and nothing is requested", async () => {
    const customer = await passwordlessCustomer();
    const member = await staff("req");
    const ask = async (email: string) => {
      const form = new FormData();
      form.set("email", email);
      const result = await requestPasswordRecoveryAction(null, form);
      await Promise.all(h.afterTasks.splice(0).map((task) => task()));
      return result;
    };
    const known = await ask(member.email);
    const passwordless = await ask(customer.email);
    const unknown = await ask(`nobody-${randomUUID().slice(0, 8)}@example.com`);
    expect(known).toEqual({ success: true, data: { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE } });
    expect(passwordless).toEqual(known);
    expect(unknown).toEqual(known);
    const malformed = await requestPasswordRecoveryAction(null, (() => { const f = new FormData(); f.set("email", "not-an-email"); return f; })());
    expect(malformed).toMatchObject({ success: false, error: { code: "VALIDATION" } });
  }, 60000);
});
