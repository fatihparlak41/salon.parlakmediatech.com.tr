import { beforeEach, describe, expect, it, vi } from "vitest";
import trMessages from "@/messages/tr.json";
import {
  PASSWORD_RECOVERY_NEUTRAL_MESSAGE,
  RESET_FAILED_MESSAGE,
  RESET_INVALID_LINK_MESSAGE,
  RESET_SAME_PASSWORD_MESSAGE,
  RESET_WEAK_PASSWORD_MESSAGE,
  completePasswordReset,
  performPasswordRecoveryRequest,
} from "@/lib/auth/password-recovery";
import { PASSWORD_MAX_BYTES, forgotPasswordSchema, resetPasswordSchema } from "@/lib/modules/auth/schemas";
import {
  confirmEmailAction,
  requestPasswordRecoveryAction,
  resendConfirmationAction,
  resetPasswordAction,
  signInAction,
} from "@/lib/modules/auth/actions";

/**
 * Faz SAAS.1A — password recovery and the login states around it. IDs PW1-PW9.
 *
 * No network and no database: the Next seams (redirect, cookies, after) and the Supabase clients are
 * replaced by recording fakes, so the exact call sequence and every failure branch can be asserted.
 */

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return {
    RedirectSignal,
    jar: new Map<string, string>(),
    client: null as unknown,
    anon: null as unknown,
    afters: [] as Array<() => unknown>,
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
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (value === "" || options?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
    delete: (name: string) => {
      h.jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    h.afters.push(callback);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("@/lib/supabase/anon-stateless", () => ({ createStatelessAnonClient: () => h.anon }));

const PENDING = "sb-pending-email-confirmation";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

type Ran<T> = { kind: "returned"; value: T } | { kind: "redirected"; url: string };
async function run<T>(fn: () => Promise<T>): Promise<Ran<T>> {
  try {
    return { kind: "returned", value: await fn() };
  } catch (error) {
    if (error instanceof h.RedirectSignal) return { kind: "redirected", url: error.url };
    throw error;
  }
}

function park(type: string, tokenHash = "hash-1", next = "/") {
  h.jar.set(PENDING, JSON.stringify({ tokenHash, type, next }));
}

beforeEach(() => {
  h.jar.clear();
  h.afters.length = 0;
  h.client = null;
  h.anon = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------
describe("PW1 forgot-password request: one neutral answer for everyone", () => {
  const provider = (impl: (email: string) => Promise<unknown>) => {
    const reset = vi.fn(impl);
    h.anon = { auth: { resetPasswordForEmail: reset } };
    return reset;
  };

  it("known, unknown, unconfirmed and rate-limited addresses get byte-identical responses", async () => {
    const outcomes: Array<Promise<unknown>> = [
      Promise.resolve({ data: {}, error: null }), // known
      Promise.resolve({ data: {}, error: null }), // unknown (GoTrue answers 200 as well)
      Promise.resolve({ data: null, error: { code: "email_not_confirmed", status: 400 } }), // unconfirmed
      Promise.resolve({ data: null, error: { code: "over_email_send_rate_limit", status: 429 } }), // limited
      Promise.reject(new Error("smtp down")), // provider blew up
    ];
    const responses: string[] = [];
    for (const outcome of outcomes) {
      provider(() => outcome);
      h.afters.length = 0;
      const ran = await run(() => requestPasswordRecoveryAction(null, form({ email: "kisi@example.com" })));
      responses.push(JSON.stringify(ran));
      // The work happens only after the response has been produced, and never throws.
      await expect(Promise.resolve(h.afters[0]!())).resolves.toBeUndefined();
    }
    expect(new Set(responses).size).toBe(1);
    expect(JSON.parse(responses[0]!)).toEqual({ kind: "returned", value: { success: true, data: { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE } } });
  });

  it("the neutral text is exactly the product wording and the catalog agrees", () => {
    expect(PASSWORD_RECOVERY_NEUTRAL_MESSAGE).toBe("Eğer bu e-posta ile kayıtlı bir hesabınız varsa, şifre yenileme bağlantısı gönderildi.");
    expect(trMessages.Auth.forgotPassword.successDescription).toBe(PASSWORD_RECOVERY_NEUTRAL_MESSAGE);
  });

  it("the provider is NOT called before the response and is called exactly once, with the trimmed address, afterwards", async () => {
    const reset = provider(async () => ({ data: {}, error: null }));
    const ran = await run(() => requestPasswordRecoveryAction(null, form({ email: "  Kisi@Example.com  " })));
    expect(ran.kind).toBe("returned");
    expect(reset).not.toHaveBeenCalled();
    expect(h.afters).toHaveLength(1);
    await h.afters[0]!();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith("Kisi@Example.com");
  });

  it("a provider that never answers cannot hold the response back (no timing signal)", async () => {
    provider(() => new Promise(() => {}));
    const started = Date.now();
    const ran = await run(() => requestPasswordRecoveryAction(null, form({ email: "kisi@example.com" })));
    expect(ran.kind).toBe("returned");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it.each(["", "abc", "a@", "@b.c", "a b@c.de", "a@b", `${"x".repeat(300)}@example.com`, "<script>@x.co"])(
    "a malformed address (%j) is the only visible error, says nothing about accounts and calls nobody",
    async (email) => {
      const reset = provider(async () => ({ data: {}, error: null }));
      const ran = await run(() => requestPasswordRecoveryAction(null, form({ email })));
      expect(ran).toEqual({ kind: "returned", value: { success: false, error: { code: "VALIDATION", message: expect.any(String) } } });
      expect(h.afters).toHaveLength(0);
      expect(reset).not.toHaveBeenCalled();
      const message = (ran as { value: { error: { message: string } } }).value.error.message;
      expect(message).not.toMatch(/hesap|kayıtlı|bulunamadı|mevcut/i);
    },
  );

  it("repeated requests are each answered neutrally and each handed to the provider, which owns the rate limit", async () => {
    const reset = provider(async () => ({ data: {}, error: null }));
    for (let i = 0; i < 5; i++) {
      const ran = await run(() => requestPasswordRecoveryAction(null, form({ email: "kisi@example.com" })));
      expect(ran).toEqual({ kind: "returned", value: { success: true, data: { message: PASSWORD_RECOVERY_NEUTRAL_MESSAGE } } });
    }
    expect(h.afters).toHaveLength(5);
    for (const callback of h.afters) await callback();
    expect(reset).toHaveBeenCalledTimes(5);
  });

  it("it reads no `next`, redirects nowhere and writes no cookie, whatever the form carries", async () => {
    provider(async () => ({ data: {}, error: null }));
    const ran = await run(() =>
      requestPasswordRecoveryAction(null, form({ email: "kisi@example.com", next: "https://evil.example", redirectTo: "https://evil.example" })),
    );
    expect(ran.kind).toBe("returned");
    expect(h.jar.size).toBe(0);
  });

  it("a failing provider is logged with safe fields only (never the address, never the provider text)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    provider(async () => ({ data: null, error: { code: "over_email_send_rate_limit", status: 429, message: "email rate limit exceeded for kisi@example.com" } }));
    await run(() => requestPasswordRecoveryAction(null, form({ email: "kisi@example.com" })));
    await h.afters[0]!();
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("over_email_send_rate_limit");
    expect(logged).not.toContain("kisi@example.com");
    expect(logged).not.toContain("rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("PW2 recovery orchestration, branch by branch", () => {
  it("performPasswordRecoveryRequest never throws and never reports the account", async () => {
    const log = vi.fn();
    await expect(performPasswordRecoveryRequest("a@b.co", { sendRecoveryEmail: async () => ({}), log })).resolves.toBeUndefined();
    await expect(performPasswordRecoveryRequest("a@b.co", { sendRecoveryEmail: async () => { throw new Error("boom a@b.co"); }, log })).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain("a@b.co");
  });

  function deps(overrides: Partial<Parameters<typeof completePasswordReset>[1]> = {}) {
    const calls: string[] = [];
    const base = {
      verifyRecoveryToken: vi.fn(async () => {
        calls.push("verify");
        return { ok: true as const };
      }),
      updatePassword: vi.fn(async () => {
        calls.push("update");
        return { ok: true as const };
      }),
      signOutEverywhere: vi.fn(async () => {
        calls.push("signout");
      }),
      clearPending: vi.fn(async () => {
        calls.push("clear");
      }),
      log: vi.fn(),
    };
    return { calls, d: { ...base, ...overrides } };
  }
  const recovery = { tokenHash: "t1", type: "recovery" as const, next: "/" };

  it("success: verify, then clear the parked token, then update, then revoke every session — in that order", async () => {
    const { calls, d } = deps();
    expect(await completePasswordReset({ pending: recovery, password: "yeni-sifre-1" }, d)).toEqual({ kind: "success" });
    expect(calls).toEqual(["verify", "clear", "update", "signout"]);
    expect(d.verifyRecoveryToken).toHaveBeenCalledWith("t1");
    expect(d.updatePassword).toHaveBeenCalledWith("yeni-sifre-1");
  });

  it.each([
    ["no parked token", null],
    ["a signup token", { tokenHash: "t", type: "signup" as const, next: "/" }],
    ["a magic-link token", { tokenHash: "t", type: "magiclink" as const, next: "/" }],
    ["an invite token", { tokenHash: "t", type: "invite" as const, next: "/" }],
  ])("%s is not a recovery link: nothing is verified, updated, cleared or signed out", async (_label, pending) => {
    const { calls, d } = deps();
    expect(await completePasswordReset({ pending, password: "yeni-sifre-1" }, d)).toEqual({ kind: "invalid_link" });
    expect(calls).toEqual([]);
  });

  it("a rejected token (expired / already used) is invalid_link, is cleared, and never reaches update or sign-out", async () => {
    const { calls, d } = deps({ verifyRecoveryToken: vi.fn(async () => { calls.push("verify"); return { ok: false as const, error: { code: "otp_expired", status: 403 } }; }) });
    expect(await completePasswordReset({ pending: recovery, password: "yeni-sifre-1" }, d)).toEqual({ kind: "invalid_link" });
    expect(calls).toEqual(["verify", "clear"]);
  });

  it.each([
    ["same_password", { kind: "password_rejected", reason: "same_password" }],
    ["weak_password", { kind: "password_rejected", reason: "weak_password" }],
    ["unexpected_failure", { kind: "failed" }],
  ])("a provider refusal (%s) still revokes the sessions the verification created", async (code, expected) => {
    const { calls, d } = deps({ updatePassword: vi.fn(async () => { calls.push("update"); return { ok: false as const, error: { code, status: 422 } }; }) });
    expect(await completePasswordReset({ pending: recovery, password: "yeni-sifre-1" }, d)).toEqual(expected);
    expect(calls).toEqual(["verify", "clear", "update", "signout"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("PW3 reset-password action", () => {
  type AuthFake = {
    verifyOtp: ReturnType<typeof vi.fn>;
    updateUser: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  };
  function install(overrides: Partial<AuthFake> = {}): AuthFake {
    const auth: AuthFake = {
      verifyOtp: vi.fn(async () => ({ data: { user: { id: "u1" }, session: {} }, error: null })),
      updateUser: vi.fn(async () => ({ data: {}, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      ...overrides,
    };
    h.client = { auth };
    return auth;
  }
  const submit = (password: string, confirmPassword = password, extra: Record<string, string> = {}) =>
    run(() => resetPasswordAction(null, form({ password, confirmPassword, ...extra })));

  it("success lands on the fixed login URL, spends the parked token, updates once and revokes every session", async () => {
    const auth = install();
    park("recovery", "tok-9");
    expect(await submit("yepyeni-sifre")).toEqual({ kind: "redirected", url: "/login?reset=success" });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "tok-9" });
    expect(auth.updateUser).toHaveBeenCalledTimes(1);
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "yepyeni-sifre" });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(h.jar.has(PENDING)).toBe(false);
  });

  it.each([
    ["a mismatch", "yepyeni-sifre", "baska-sifre-00", "Şifreler eşleşmiyor"],
    ["too short", "kisa", "kisa", "Şifre en az 8 karakter olmalı"],
    ["over the 72-byte limit", "a".repeat(PASSWORD_MAX_BYTES + 1), "a".repeat(PASSWORD_MAX_BYTES + 1), `Şifre en fazla ${PASSWORD_MAX_BYTES} bayt uzunluğunda olabilir`],
    ["only spaces", "        ", "        ", "Şifre yalnızca boşluklardan oluşamaz"],
  ])("%s is refused BEFORE the token is touched, so it cannot burn the link", async (_label, password, confirm, message) => {
    const auth = install();
    park("recovery", "tok-9");
    const ran = await submit(password, confirm);
    expect(ran).toEqual({ kind: "returned", value: { success: false, error: { code: "VALIDATION", message } } });
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(h.jar.has(PENDING)).toBe(true);
  });

  it("multi-byte passwords count BYTES: 25 Turkish characters of 2 bytes each is over the limit", async () => {
    const auth = install();
    park("recovery");
    const password = "ş".repeat(37); // 74 bytes
    expect((await submit(password)).kind).toBe("returned");
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    const ok = "ş".repeat(36); // 72 bytes
    expect(await submit(ok)).toEqual({ kind: "redirected", url: "/login?reset=success" });
  });

  it("without a parked recovery token: the neutral invalid-link answer, nothing verified", async () => {
    const auth = install();
    expect(await submit("yepyeni-sifre")).toEqual({
      kind: "returned",
      value: { success: false, error: { code: "UNAUTHENTICATED", message: RESET_INVALID_LINK_MESSAGE } },
    });
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("a parked token of another kind is left alone", async () => {
    const auth = install();
    park("signup");
    const before = h.jar.get(PENDING);
    expect((await submit("yepyeni-sifre")).kind).toBe("returned");
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(h.jar.get(PENDING)).toBe(before);
  });

  it("an expired or already-used link is reported plainly and the parked token is gone", async () => {
    const auth = install({ verifyOtp: vi.fn(async () => ({ data: { user: null, session: null }, error: { code: "otp_expired", status: 403, message: "Email link is invalid or has expired" } })) });
    park("recovery");
    const ran = await submit("yepyeni-sifre");
    expect(ran).toEqual({ kind: "returned", value: { success: false, error: { code: "UNAUTHENTICATED", message: RESET_INVALID_LINK_MESSAGE } } });
    expect(JSON.stringify(ran)).not.toMatch(/Email link|otp_expired|supabase|jwt|token/i);
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(h.jar.has(PENDING)).toBe(false);
  });

  it("the provider's own refusals become plain Turkish sentences, never raw errors", async () => {
    for (const [code, message] of [
      ["same_password", RESET_SAME_PASSWORD_MESSAGE],
      ["weak_password", RESET_WEAK_PASSWORD_MESSAGE],
      ["something_else", RESET_FAILED_MESSAGE],
    ] as const) {
      const auth = install({ updateUser: vi.fn(async () => ({ data: {}, error: { code, status: 422, message: `raw ${code}` } })) });
      park("recovery");
      const ran = await submit("yepyeni-sifre");
      expect((ran as { value: { error: { message: string } } }).value.error.message).toBe(message);
      expect(JSON.stringify(ran)).not.toContain("raw ");
      expect(auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    }
  });

  it("a failing sign-out is swallowed and the reset still succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    install({ signOut: vi.fn(async () => ({ error: { code: "x", status: 500 } })) });
    park("recovery");
    expect(await submit("yepyeni-sifre")).toEqual({ kind: "redirected", url: "/login?reset=success" });
  });

  it("only the two password fields are read: a forged token, email or next in the form changes nothing", async () => {
    const auth = install();
    park("recovery", "parked-token");
    const ran = await submit("yepyeni-sifre", "yepyeni-sifre", { token_hash: "forged", email: "victim@example.com", next: "https://evil.example", type: "signup" });
    expect(ran).toEqual({ kind: "redirected", url: "/login?reset=success" });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "parked-token" });
  });

  it("a second use of the same link fails: the first spend cleared the cookie", async () => {
    install();
    park("recovery", "once");
    expect(await submit("yepyeni-sifre")).toEqual({ kind: "redirected", url: "/login?reset=success" });
    const second = await submit("baska-yeni-sifre");
    expect((second as { value: { error: { message: string } } }).value.error.message).toBe(RESET_INVALID_LINK_MESSAGE);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("PW4 the confirm button never consumes a recovery link", () => {
  it("a parked recovery token sends the person to the reset form: nothing verified, token kept", async () => {
    const verifyOtp = vi.fn();
    h.client = { auth: { verifyOtp } };
    park("recovery", "keep-me");
    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/reset-password" });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(JSON.parse(h.jar.get(PENDING)!).tokenHash).toBe("keep-me");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("PW5 password schemas", () => {
  it("the new-password rules", () => {
    const ok = resetPasswordSchema.safeParse({ password: "12345678", confirmPassword: "12345678" });
    expect(ok.success).toBe(true);
    expect(resetPasswordSchema.safeParse({ password: "1234567", confirmPassword: "1234567" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ password: "12345678", confirmPassword: "12345679" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ password: "a".repeat(PASSWORD_MAX_BYTES), confirmPassword: "a".repeat(PASSWORD_MAX_BYTES) }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ password: "a".repeat(PASSWORD_MAX_BYTES + 1), confirmPassword: "a".repeat(PASSWORD_MAX_BYTES + 1) }).success).toBe(false);
    // a MINIMUM, never a cap below the byte limit: a long passphrase is fine
    expect(resetPasswordSchema.safeParse({ password: "uzun bir parola cümlesi 2026!", confirmPassword: "uzun bir parola cümlesi 2026!" }).success).toBe(true);
  });

  it("the e-mail schema trims and refuses nonsense", () => {
    expect(forgotPasswordSchema.parse({ email: "  a@b.co " }).email).toBe("a@b.co");
    expect(forgotPasswordSchema.safeParse({ email: "nope" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("PW6 sign-in states", () => {
  const signIn = (error: unknown) => {
    h.client = { auth: { signInWithPassword: vi.fn(async () => (error ? { data: {}, error } : { data: { user: { id: "u" } }, error: null })) } };
    return run(() => signInAction(null, form({ email: "kisi@example.com", password: "sifre-123" })));
  };

  it("unknown address and wrong password are byte-identical (the generic message)", async () => {
    const unknown = await signIn({ code: "invalid_credentials", status: 400, message: "Invalid login credentials" });
    const wrong = await signIn({ code: "invalid_credentials", status: 400, message: "Invalid login credentials" });
    expect(JSON.stringify(unknown)).toBe(JSON.stringify(wrong));
    expect(unknown).toEqual({ kind: "returned", value: { success: false, error: { code: "UNAUTHENTICATED", message: "E-posta veya şifre hatalı" } } });
  });

  it.each(["user_banned", "over_request_rate_limit", "unexpected_failure", "user_not_found", "email_address_invalid"])(
    "%s keeps the generic message (nothing about the account leaks)",
    async (code) => {
      const ran = await signIn({ code, status: 400, message: "provider text" });
      expect(ran).toEqual({ kind: "returned", value: { success: false, error: { code: "UNAUTHENTICATED", message: "E-posta veya şifre hatalı" } } });
    },
  );

  it("only email_not_confirmed (which the provider sends only after a CORRECT password) gets its own useful state", async () => {
    const ran = await signIn({ code: "email_not_confirmed", status: 400, message: "Email not confirmed" });
    expect(ran).toEqual({
      kind: "returned",
      value: { success: false, error: { code: "EMAIL_NOT_CONFIRMED", message: expect.stringContaining("doğrulanmamış") } },
    });
    expect(JSON.stringify(ran)).not.toMatch(/supabase|jwt|token|Email not confirmed/i);
  });

  it("a successful sign-in redirects to the sanitized next and ignores a hostile one", async () => {
    h.client = { auth: { signInWithPassword: vi.fn(async () => ({ data: {}, error: null })) } };
    expect(await run(() => signInAction(null, form({ email: "a@b.co", password: "x", next: "/accept-invite" })))).toEqual({ kind: "redirected", url: "/accept-invite" });
    expect(await run(() => signInAction(null, form({ email: "a@b.co", password: "x", next: "//evil.example" })))).toEqual({ kind: "redirected", url: "/" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("PW7 resend confirmation stays neutral", () => {
  it.each([null, { code: "user_not_found", status: 400 }, { code: "over_email_send_rate_limit", status: 429 }, { code: "email_exists", status: 422 }])(
    "provider outcome %j -> the same success",
    async (error) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      h.client = { auth: { resend: vi.fn(async () => ({ data: {}, error })) } };
      expect(await run(() => resendConfirmationAction(null, form({ email: "kisi@example.com" })))).toEqual({
        kind: "returned",
        value: { success: true, data: null },
      });
    },
  );

  it("a malformed address is the only visible error", async () => {
    h.client = { auth: { resend: vi.fn() } };
    const ran = await run(() => resendConfirmationAction(null, form({ email: "nope" })));
    expect(ran).toMatchObject({ kind: "returned", value: { success: false, error: { code: "VALIDATION" } } });
  });
});
