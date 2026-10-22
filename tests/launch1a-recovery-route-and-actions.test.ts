import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Faz LAUNCH.1A — password recovery wiring, with NO database and NO network:
 *   - GET /auth/confirm (the e-mail link) for type=recovery
 *   - confirmEmailAction's recovery guard
 *   - requestPasswordRecoveryAction (the non-enumerating request)
 *   - resetPasswordAction (the only place a recovery token is verified)
 *   - the login / forgot / reset pages' own logic
 *
 * Substituted: the Next request scope (an in-memory cookie jar, a redirect() that
 * throws, the same narrow seams auth-confirm-continuity.test.ts uses) and the three
 * Supabase clients (cookie-backed server client, service-role client, stateless
 * publishable-key client) — every call they receive is recorded and asserted.
 * REAL: the route handler, the actions, password-recovery.ts, the schemas, the
 * pending-confirmation cookie module, resolveSafeNext, the pages and the Turkish
 * messages.
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
    order: [] as string[],
    verifyOtp: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
    adminRpc: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    createServerClientCalls: { count: 0 },
    afterTasks: [] as (() => Promise<unknown>)[],
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
      if (value === "" || options?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
    delete: (name: string) => {
      h.order.push("cookie.delete");
      h.writes.push({ name, value: "", options: { deleted: true } });
      h.jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    h.createServerClientCalls.count += 1;
    return { auth: { verifyOtp: h.verifyOtp, updateUser: h.updateUser, signOut: h.signOut } };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.adminRpc }) }));
// after(): the platform runs these once the response has gone out; the test runs them on demand.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => Promise<unknown>) => void h.afterTasks.push(task) };
});
vi.mock("@/lib/supabase/anon-stateless", () => ({ createStatelessAnonClient: () => ({ auth: { resetPasswordForEmail: h.resetPasswordForEmail } }) }));

vi.mock("next-intl/server", async () => {
  const { default: messages } = await import("@/messages/tr.json");
  return {
    getTranslations: async (namespace: string) => (key: string) => {
      const value = `${namespace}.${key}`.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
      return typeof value === "string" ? value : `${namespace}.${key}`;
    },
  };
});
vi.mock("@/lib/i18n/navigation", async () => {
  const { createElement: ce } = await import("react");
  return { Link: ({ href, children }: { href: string; children?: React.ReactNode }) => ce("a", { href }, children) };
});
// The client forms are exercised by the browser acceptance plan; here they are markers.
vi.mock("@/components/auth/login-form", async () => {
  const { createElement: ce } = await import("react");
  return { LoginForm: ({ next }: { next?: string }) => ce("div", { "data-marker": "login-form", "data-next": next ?? "" }) };
});
vi.mock("@/components/auth/reset-password-form", async () => {
  const { createElement: ce } = await import("react");
  return { ResetPasswordForm: () => ce("div", { "data-marker": "reset-password-form" }) };
});
vi.mock("@/components/auth/forgot-password-form", async () => {
  const { createElement: ce } = await import("react");
  return { ForgotPasswordForm: () => ce("div", { "data-marker": "forgot-password-form" }) };
});

import messages from "@/messages/tr.json";
import { GET as authConfirmGet } from "@/app/auth/confirm/route";
import { confirmEmailAction, requestPasswordRecoveryAction, resetPasswordAction } from "@/lib/modules/auth/actions";
import {
  PASSWORD_RECOVERY_NEUTRAL_MESSAGE,
  RESET_FAILED_MESSAGE,
  RESET_INVALID_LINK_MESSAGE,
  RESET_SAME_PASSWORD_MESSAGE,
  RESET_WEAK_PASSWORD_MESSAGE,
} from "@/lib/auth/password-recovery";
import { RECOVERY_TTL_SECONDS } from "@/lib/auth/pending-confirmation";
import { getSiteUrl } from "@/lib/site-url";
import LoginPage from "@/app/[locale]/(auth)/login/page";
import ResetPasswordPage from "@/app/[locale]/(auth)/reset-password/page";
import ForgotPasswordPage from "@/app/[locale]/(auth)/forgot-password/page";
import ConfirmEmailPage from "@/app/[locale]/(auth)/confirm-email/page";

const ORIGIN = "https://salon.example.test";
const COOKIE = "sb-pending-email-confirmation";
const TOKEN = "recovery_hash_0123456789abcdef";
const NEW_PASSWORD = "Yeni-Sifre-2026!";
const EMAIL = "yonetici@example.com";

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
function park(value: { tokenHash: string; type: string; next: string }) {
  h.jar.set(COOKIE, JSON.stringify(value));
}
const confirmUrl = (query: string) => new Request(`${ORIGIN}/auth/confirm?${query}`);
const parked = () => (h.jar.has(COOKIE) ? (JSON.parse(h.jar.get(COOKIE)!) as { tokenHash: string; type: string; next: string }) : null);

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.jar.clear();
  h.writes.length = 0;
  h.order.length = 0;
  h.createServerClientCalls.count = 0;
  h.afterTasks.length = 0;
  for (const fn of [h.verifyOtp, h.updateUser, h.signOut, h.adminRpc, h.resetPasswordForEmail]) fn.mockReset();
  h.verifyOtp.mockImplementation(async () => {
    h.order.push("verifyOtp");
    return { data: { user: { id: "u", email: EMAIL, user_metadata: {} } }, error: null };
  });
  h.updateUser.mockImplementation(async () => {
    h.order.push("updateUser");
    return { data: {}, error: null };
  });
  h.signOut.mockImplementation(async () => {
    h.order.push("signOut");
    return { error: null };
  });
  h.adminRpc.mockResolvedValue({ data: true, error: null });
  h.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  consoleError.mockRestore();
});

// ---------------------------------------------------------------------------------------------------------------------
describe("GET /auth/confirm — the recovery e-mail link", () => {
  it("parks the token in an HttpOnly cookie and redirects to /reset-password with NO token in the URL, no-store", async () => {
    const response = await authConfirmGet(confirmUrl(`token_hash=${TOKEN}&type=recovery`));
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const location = response.headers.get("location")!;
    expect(location).toBe(`${ORIGIN}/reset-password`);
    expect(location).not.toContain(TOKEN);
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      name: COOKIE,
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: RECOVERY_TTL_SECONDS },
    });
    expect(parked()).toEqual({ tokenHash: TOKEN, type: "recovery", next: "/" });
    expect(RECOVERY_TTL_SECONDS).toBe(15 * 60);
  });

  it("PREFETCH-SAFE: the GET never touches the auth service — no verifyOtp, not even a client", async () => {
    await authConfirmGet(confirmUrl(`token_hash=${TOKEN}&type=recovery`));
    await authConfirmGet(confirmUrl(`token_hash=${TOKEN}&type=recovery`));
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.createServerClientCalls.count).toBe(0);
  });

  it.each([
    "https://evil.example/steal",
    "//evil.example",
    "/\\evil.example",
    "/account/dashboard",
    "javascript:alert(1)",
  ])("a crafted next=%s is IGNORED: the person still lands on /reset-password and the stored next is '/'", async (next) => {
    const response = await authConfirmGet(confirmUrl(`token_hash=${TOKEN}&type=recovery&next=${encodeURIComponent(next)}`));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
    expect(parked()).toEqual({ tokenHash: TOKEN, type: "recovery", next: "/" });
  });

  it("a recovery link without a token still goes to /reset-password (which renders the expired state) and stores nothing", async () => {
    const response = await authConfirmGet(confirmUrl("type=recovery"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
    expect(h.writes).toHaveLength(0);
  });

  it("UNCHANGED for the other flows: signup / magic-link links still go to /confirm-email with the short TTL and a sanitized next", async () => {
    const signup = await authConfirmGet(confirmUrl(`token_hash=${TOKEN}&type=signup&next=${encodeURIComponent("/accept-invite")}`));
    expect(signup.headers.get("location")).toBe(`${ORIGIN}/confirm-email`);
    expect(parked()).toEqual({ tokenHash: TOKEN, type: "signup", next: "/accept-invite" });
    expect(h.writes[0]!.options).toMatchObject({ maxAge: 5 * 60 });

    h.jar.clear();
    h.writes.length = 0;
    const magic = await authConfirmGet(confirmUrl(`token_hash=${TOKEN}&type=magiclink&next=${encodeURIComponent("https://evil.example/x")}`));
    expect(magic.headers.get("location")).toBe(`${ORIGIN}/confirm-email`);
    expect(parked()).toEqual({ tokenHash: TOKEN, type: "magiclink", next: "/" });
    expect(h.writes[0]!.options).toMatchObject({ maxAge: 5 * 60 });
  });

  it("an unknown type parks nothing and goes to /confirm-email", async () => {
    const response = await authConfirmGet(confirmUrl(`token_hash=${TOKEN}&type=anything_else`));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/confirm-email`);
    expect(h.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("confirmEmailAction — the recovery guard", () => {
  it("a parked RECOVERY token is NOT consumed by the confirm button: redirect to /reset-password, nothing verified, cookie kept", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    const outcome = await run(() => confirmEmailAction());
    expect(outcome).toEqual({ kind: "redirected", url: "/reset-password" });
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.createServerClientCalls.count).toBe(0);
    expect(parked()).toEqual({ tokenHash: TOKEN, type: "recovery", next: "/" });
  });

  it("REGRESSION: a parked signup token is still verified exactly as before (verifyOtp with its own type) and the cookie is spent", async () => {
    park({ tokenHash: TOKEN, type: "signup", next: "/" });
    const outcome = await run(() => confirmEmailAction());
    expect(outcome).toMatchObject({ kind: "redirected" });
    expect(h.verifyOtp).toHaveBeenCalledTimes(1);
    expect(h.verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: TOKEN });
    expect(parked()).toBeNull();
  });

  it("nothing parked: back to /confirm-email, no verification", async () => {
    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/confirm-email" });
    expect(h.verifyOtp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("requestPasswordRecoveryAction — the non-enumerating request", () => {
  async function request(email: string | null) {
    return requestPasswordRecoveryAction(null, email === null ? new FormData() : form({ email }));
  }

  /** What the platform does once the response has gone out: run everything that was handed to after(). */
  async function runDeferredWork() {
    const tasks = h.afterTasks.splice(0);
    await Promise.all(tasks.map((task) => task()));
  }

  it("the response is produced BEFORE any lookup or e-mail — nothing about the address has been touched when it returns", async () => {
    const result = await request(EMAIL);
    expect(result).toEqual({ success: true, data: { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE } });
    expect(h.adminRpc).not.toHaveBeenCalled();
    expect(h.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(h.afterTasks).toHaveLength(1);
  });

  it("an eligible account: after the response, ONE recovery e-mail is requested for that address, redirecting to /auth/confirm", async () => {
    await request(EMAIL);
    await runDeferredWork();
    expect(h.adminRpc).toHaveBeenCalledTimes(1);
    expect(h.adminRpc).toHaveBeenCalledWith("password_recovery_allowed", { p_email: EMAIL });
    expect(h.resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect(h.resetPasswordForEmail).toHaveBeenCalledWith(EMAIL, { redirectTo: `${getSiteUrl()}/auth/confirm` });
  });

  it("an unknown / customer-only / unconfirmed address: NO e-mail — and the IDENTICAL answer", async () => {
    const eligible = await request(EMAIL);
    await runDeferredWork();
    h.adminRpc.mockResolvedValue({ data: false, error: null });
    h.resetPasswordForEmail.mockClear();
    const ineligible = await request("nobody@example.com");
    await runDeferredWork();
    expect(h.adminRpc).toHaveBeenLastCalledWith("password_recovery_allowed", { p_email: "nobody@example.com" });
    expect(h.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(ineligible).toEqual(eligible);
  });

  it("an eligibility-check failure fails closed (no e-mail) with the identical answer, and logs by code only", async () => {
    const baseline = await request(EMAIL);
    await runDeferredWork();
    h.resetPasswordForEmail.mockClear();
    h.adminRpc.mockResolvedValue({ data: null, error: { code: "PGRST301", status: 500, message: `permission problem for ${EMAIL}` } });
    const failed = await request(EMAIL);
    await runDeferredWork();
    expect(h.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(failed).toEqual(baseline);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(EMAIL);
  });

  it("a provider error or a throw from the e-mail step (rate limit, SMTP down) is never surfaced: the identical answer, and the deferred work never rejects", async () => {
    const baseline = await request(EMAIL);
    await runDeferredWork();
    h.resetPasswordForEmail.mockResolvedValue({ data: null, error: { code: "over_email_send_rate_limit", status: 429, message: `slow down ${EMAIL}` } });
    expect(await request(EMAIL)).toEqual(baseline);
    await expect(runDeferredWork()).resolves.toBeUndefined();
    h.resetPasswordForEmail.mockRejectedValue(new Error(`network down while sending to ${EMAIL}`));
    expect(await request(EMAIL)).toEqual(baseline);
    await expect(runDeferredWork()).resolves.toBeUndefined();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(EMAIL);
  });

  it("TIMING: the answer never waits for the work — even if the lookup and the e-mail hang forever, the action still returns", async () => {
    h.adminRpc.mockReturnValue(new Promise(() => {}));
    h.resetPasswordForEmail.mockReturnValue(new Promise(() => {}));
    const outcome = await Promise.race([
      request(EMAIL).then((result) => ({ settled: true as const, result })),
      new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 750)),
    ]);
    expect(outcome.settled, "the action waited for the lookup / the e-mail").toBe(true);
  });

  it("a malformed address is a validation error before ANY service call and schedules nothing (this reveals nothing about accounts)", async () => {
    for (const email of ["", "not-an-email", "a@", "a b@c.com"]) {
      const result = await requestPasswordRecoveryAction(null, form({ email }));
      expect(result, email).toMatchObject({ success: false, error: { code: "VALIDATION" } });
    }
    expect(await requestPasswordRecoveryAction(null, new FormData())).toMatchObject({ success: false, error: { code: "VALIDATION" } });
    expect(h.afterTasks).toHaveLength(0);
    await runDeferredWork();
    expect(h.adminRpc).not.toHaveBeenCalled();
    expect(h.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("the request never creates a cookie-backed client and never sets a cookie (a recovery request is not a session)", async () => {
    await request(EMAIL);
    await runDeferredWork();
    expect(h.createServerClientCalls.count).toBe(0);
    expect(h.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("resetPasswordAction — the only place a recovery token is verified", () => {
  const fields = (password = NEW_PASSWORD, confirmPassword = NEW_PASSWORD) => form({ password, confirmPassword });

  it("HAPPY PATH: verify the parked token as 'recovery', set the password, revoke every session, spend the cookie, land on /login?reset=success", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    const outcome = await run(() => resetPasswordAction(null, fields()));
    expect(outcome).toEqual({ kind: "redirected", url: "/login?reset=success" });
    expect(h.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: TOKEN });
    expect(h.updateUser).toHaveBeenCalledWith({ password: NEW_PASSWORD });
    expect(h.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(h.order).toEqual(["verifyOtp", "cookie.delete", "updateUser", "signOut"]);
    expect(parked()).toBeNull();
  });

  it("FORGED FORM FIELDS change nothing: the token comes from the cookie only, there is no `next`, the destination is fixed", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    const data = fields();
    data.set("token_hash", "attacker_supplied_hash");
    data.set("type", "magiclink");
    data.set("next", "https://evil.example/phish");
    data.set("email", "victim@example.com");
    const outcome = await run(() => resetPasswordAction(null, data));
    expect(outcome).toEqual({ kind: "redirected", url: "/login?reset=success" });
    expect(h.verifyOtp).toHaveBeenCalledTimes(1);
    expect(h.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: TOKEN });
  });

  it("a mismatch or a short password is rejected BEFORE the token is touched — the link is not burned by a typo", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    for (const data of [fields(NEW_PASSWORD, `${NEW_PASSWORD}x`), fields("short", "short"), fields("", ""), new FormData()]) {
      const outcome = await run(() => resetPasswordAction(null, data));
      expect(outcome).toMatchObject({ kind: "returned", value: { success: false, error: { code: "VALIDATION" } } });
    }
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.createServerClientCalls.count).toBe(0);
    expect(parked()).toEqual({ tokenHash: TOKEN, type: "recovery", next: "/" });
  });

  it("no parked token (never clicked a link, expired, or already used): the neutral invalid-link answer; nothing verified or changed", async () => {
    const outcome = await run(() => resetPasswordAction(null, fields()));
    expect(outcome).toEqual({
      kind: "returned",
      value: { success: false, error: { code: "UNAUTHENTICATED", message: RESET_INVALID_LINK_MESSAGE } },
    });
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it.each(["signup", "magiclink", "invite", "email_change", "email"])(
    "CUSTOMER / OTHER-FLOW SEPARATION: a parked %s token cannot be used to set a password here — and is left alone",
    async (type) => {
      park({ tokenHash: TOKEN, type, next: "/account" });
      const outcome = await run(() => resetPasswordAction(null, fields()));
      expect(outcome).toMatchObject({ kind: "returned", value: { success: false, error: { code: "UNAUTHENTICATED" } } });
      expect(h.verifyOtp).not.toHaveBeenCalled();
      expect(h.updateUser).not.toHaveBeenCalled();
      expect(parked()).toEqual({ tokenHash: TOKEN, type, next: "/account" });
    },
  );

  it("an expired / already-used recovery token: invalid-link answer, cookie spent, password NOT set", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    h.verifyOtp.mockResolvedValue({ data: { user: null }, error: { code: "otp_expired", status: 403, message: `Email link is invalid or has expired: ${TOKEN}` } });
    const outcome = await run(() => resetPasswordAction(null, fields()));
    expect(outcome).toEqual({
      kind: "returned",
      value: { success: false, error: { code: "UNAUTHENTICATED", message: RESET_INVALID_LINK_MESSAGE } },
    });
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(parked()).toBeNull();
  });

  it("DIRECT-PROVIDER BYPASS: a passwordless (customer) account holding a valid recovery token cannot set a first password through this surface", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    h.adminRpc.mockResolvedValue({ data: false, error: null });
    const outcome = await run(() => resetPasswordAction(null, fields()));
    expect(outcome).toEqual({
      kind: "returned",
      value: { success: false, error: { code: "UNAUTHENTICATED", message: RESET_INVALID_LINK_MESSAGE } },
    });
    expect(h.adminRpc).toHaveBeenCalledWith("password_recovery_allowed", { p_email: EMAIL });
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.signOut).toHaveBeenCalledWith({ scope: "local" }); // only the session this attempt created
    expect(parked()).toBeNull();
  });

  it("an eligibility-check failure at the boundary fails closed (no password is set)", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    h.adminRpc.mockResolvedValue({ data: null, error: { code: "PGRST301", status: 500, message: "boom" } });
    const outcome = await run(() => resetPasswordAction(null, fields()));
    expect(outcome).toMatchObject({ kind: "returned", value: { success: false, error: { code: "UNAUTHENTICATED" } } });
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it.each([
    ["same_password", RESET_SAME_PASSWORD_MESSAGE, "VALIDATION"],
    ["weak_password", RESET_WEAK_PASSWORD_MESSAGE, "VALIDATION"],
    ["unexpected_failure", RESET_FAILED_MESSAGE, "UNEXPECTED"],
  ] as const)("the auth service answers %s on the update: the right message, and every session is STILL revoked", async (code, message, errorCode) => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    h.updateUser.mockResolvedValue({ data: {}, error: { code, status: 422, message: `details about ${NEW_PASSWORD}` } });
    const outcome = await run(() => resetPasswordAction(null, fields()));
    expect(outcome).toEqual({ kind: "returned", value: { success: false, error: { code: errorCode, message } } });
    expect(h.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(parked()).toBeNull();
  });

  it("a failing global sign-out never blocks a successful reset (it is logged by code only)", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    h.signOut.mockResolvedValue({ error: { code: "session_not_found", status: 403, message: "details" } });
    expect(await run(() => resetPasswordAction(null, fields()))).toEqual({ kind: "redirected", url: "/login?reset=success" });
  });

  it("the token and the new password never appear in logs, results or messages on any path", async () => {
    const seen: string[] = [];
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    seen.push(JSON.stringify(await run(() => resetPasswordAction(null, fields()))));
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    h.verifyOtp.mockResolvedValue({ data: { user: null }, error: { code: "otp_expired", message: TOKEN } });
    seen.push(JSON.stringify(await run(() => resetPasswordAction(null, fields()))));
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    h.verifyOtp.mockResolvedValue({ data: { user: { email: EMAIL } }, error: null });
    h.updateUser.mockResolvedValue({ data: {}, error: { code: "weak_password", message: NEW_PASSWORD } });
    seen.push(JSON.stringify(await run(() => resetPasswordAction(null, fields()))));
    seen.push(JSON.stringify(consoleError.mock.calls));
    const text = seen.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(NEW_PASSWORD);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the pages", () => {
  const render = async (node: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await node);
  const loginPage = (query: Record<string, string | string[] | undefined>) =>
    render(LoginPage({ searchParams: Promise.resolve(query) } as never));

  it("login: ?reset=success shows the success banner; any other value or none shows nothing", async () => {
    const banner = messages.Auth.login.resetSuccess;
    expect(await loginPage({ reset: "success" })).toContain(banner);
    expect(await loginPage({ reset: ["success", "x"] })).toContain(banner);
    for (const reset of [undefined, "", "1", "true", "SUCCESS", "success ", "https://evil.example", "<script>"]) {
      expect(await loginPage({ reset }), String(reset)).not.toContain(banner);
    }
  });

  it("login: links to /forgot-password and still offers the sign-up link; `next` is still sanitized", async () => {
    const html = await loginPage({ next: "https://evil.example/x" });
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain(messages.Auth.login.forgotPasswordLink);
    expect(html).toContain('href="/sign-up"');
    expect(html).toContain('data-next=""');
  });

  it("reset-password: the form is rendered ONLY for a parked recovery token", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    const withToken = await render(ResetPasswordPage());
    expect(withToken).toContain('data-marker="reset-password-form"');
    expect(withToken).not.toContain(TOKEN);

    for (const parkedValue of [null, { tokenHash: TOKEN, type: "signup", next: "/" }, { tokenHash: TOKEN, type: "magiclink", next: "/" }]) {
      h.jar.clear();
      if (parkedValue) park(parkedValue);
      const html = await render(ResetPasswordPage());
      expect(html).not.toContain('data-marker="reset-password-form"');
      expect(html).toContain(messages.Auth.resetPassword.invalidTitle);
      expect(html).toContain('href="/forgot-password"');
      expect(html).not.toContain(TOKEN);
    }
  });

  it("forgot-password: the form, a way back to the staff login, and a pointer for CUSTOMERS to their own sign-in (no `next` anywhere)", async () => {
    const html = await render(ForgotPasswordPage());
    expect(html).toContain('data-marker="forgot-password-form"');
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/account/login"');
    expect(html).not.toContain("next=");
  });

  it("confirm-email: a parked recovery token redirects to /reset-password instead of rendering the confirm button", async () => {
    park({ tokenHash: TOKEN, type: "recovery", next: "/" });
    const outcome = await run(() => ConfirmEmailPage());
    expect(outcome).toEqual({ kind: "redirected", url: "/reset-password" });
  });
});
