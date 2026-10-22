import { describe, expect, it, vi } from "vitest";
import {
  PASSWORD_RECOVERY_NEUTRAL_MESSAGE,
  completePasswordReset,
  performPasswordRecoveryRequest,
  type ResetPasswordDeps,
} from "@/lib/auth/password-recovery";
import type { PendingConfirmation } from "@/lib/auth/pending-confirmation";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, forgotPasswordSchema, resetPasswordSchema } from "@/lib/modules/auth/schemas";

/**
 * Faz LAUNCH.1A — staff password recovery, the part that has no database in it:
 * the request side (non-enumeration, no leak through logs; the action-level
 * guarantee that the response never waits for this work is in
 * launch1a-recovery-route-and-actions.test.ts),
 * the reset side (which pending token is accepted, single use, session
 * revocation, how a rejected password is reported) and the form schemas.
 * Pure functions with injected fakes — the exact call sequence is the contract.
 */

const EMAIL = "someone.private@example.com";
const TOKEN = "tok_hash_0123456789abcdef";
const NEW_PASSWORD = "Yeni-Sifre-2026!";

// ---------------------------------------------------------------------------------------------------------------------
describe("performPasswordRecoveryRequest — non-enumerating", () => {
  function harness(overrides: Partial<Parameters<typeof performPasswordRecoveryRequest>[1]> = {}) {
    const logged: unknown[][] = [];
    const deps = {
      isEligible: vi.fn(async () => true),
      sendRecoveryEmail: vi.fn(async () => ({ error: null as unknown })),
      log: (...args: unknown[]) => {
        logged.push(args);
      },
      ...overrides,
    };
    return { deps, logged };
  }

  it("an eligible account: the recovery e-mail is requested exactly once, for exactly that address", async () => {
    const { deps } = harness();
    await performPasswordRecoveryRequest(EMAIL, deps);
    expect(deps.isEligible).toHaveBeenCalledTimes(1);
    expect(deps.isEligible).toHaveBeenCalledWith(EMAIL);
    expect(deps.sendRecoveryEmail).toHaveBeenCalledTimes(1);
    expect(deps.sendRecoveryEmail).toHaveBeenCalledWith(EMAIL);
  });

  it("an unknown / customer-only / unconfirmed address: NOTHING is sent", async () => {
    const { deps } = harness({ isEligible: vi.fn(async () => false) });
    await performPasswordRecoveryRequest(EMAIL, deps);
    expect(deps.sendRecoveryEmail).not.toHaveBeenCalled();
  });

  it("the caller learns nothing: the promise resolves to undefined for sent, not sent and every failure", async () => {
    const cases = [
      harness().deps,
      harness({ isEligible: vi.fn(async () => false) }).deps,
      harness({ isEligible: vi.fn(async () => { throw new Error("rpc down"); }) }).deps,
      harness({ sendRecoveryEmail: vi.fn(async () => ({ error: { code: "over_email_send_rate_limit", status: 429 } })) }).deps,
      harness({ sendRecoveryEmail: vi.fn(async () => { throw new Error("smtp exploded"); }) }).deps,
    ];
    for (const deps of cases) {
      await expect(performPasswordRecoveryRequest(EMAIL, deps)).resolves.toBeUndefined();
    }
  });

  it("an eligibility-check failure fails CLOSED (no e-mail) and is logged with safe fields only", async () => {
    const { deps, logged } = harness({ isEligible: vi.fn(async () => { throw Object.assign(new Error(`lookup failed for ${EMAIL}`), { code: "XX000", status: 500 }); }) });
    await performPasswordRecoveryRequest(EMAIL, deps);
    expect(deps.sendRecoveryEmail).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toEqual({ code: "XX000", status: 500 });
  });

  it("a rate-limit / provider error from the e-mail step is logged (code + status only) and never surfaced", async () => {
    const { deps, logged } = harness({
      sendRecoveryEmail: vi.fn(async () => ({ error: { code: "over_email_send_rate_limit", status: 429, message: `rate limit for ${EMAIL}` } })),
    });
    await expect(performPasswordRecoveryRequest(EMAIL, deps)).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toEqual({ code: "over_email_send_rate_limit", status: 429 });
  });

  it("nothing the logger receives contains the address or any error text (only { code, status })", async () => {
    const { deps, logged } = harness({
      isEligible: vi.fn(async () => true),
      sendRecoveryEmail: vi.fn(async () => ({ error: { code: "x", status: 400, message: `bad address ${EMAIL}` } })),
    });
    await performPasswordRecoveryRequest(EMAIL, deps);
    const second = harness({ isEligible: vi.fn(async () => { throw new Error(`boom ${EMAIL}`); }) });
    await performPasswordRecoveryRequest(EMAIL, second.deps);
    const everything = JSON.stringify([...logged, ...second.logged]);
    expect(everything).not.toContain(EMAIL);
    expect(everything).not.toContain("example.com");
  });

  it("the work is strictly sequential: the e-mail is requested only AFTER the eligibility answer, and never when it is no", async () => {
    const order: string[] = [];
    const { deps } = harness({
      isEligible: vi.fn(async () => {
        order.push("isEligible");
        return true;
      }),
      sendRecoveryEmail: vi.fn(async () => {
        order.push("send");
        return { error: null };
      }),
    });
    await performPasswordRecoveryRequest(EMAIL, deps);
    expect(order).toEqual(["isEligible", "send"]);
  });

  it("the neutral message is the exact wording the Owner specified", () => {
    expect(PASSWORD_RECOVERY_NEUTRAL_MESSAGE).toBe("Eğer bu e-posta ile eşleşen bir hesap varsa şifre yenileme bağlantısı gönderildi.");
    // it must not hint at the outcome
    expect(PASSWORD_RECOVERY_NEUTRAL_MESSAGE).not.toMatch(/bulunamadı|kayıtlı değil|hesap yok/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("completePasswordReset — which token, single use, no lingering session", () => {
  const recovery: PendingConfirmation = { tokenHash: TOKEN, type: "recovery", next: "/" };

  function harness(overrides: Partial<ResetPasswordDeps> = {}) {
    const calls: string[] = [];
    const logged: unknown[][] = [];
    const deps: ResetPasswordDeps = {
      verifyRecoveryToken: vi.fn(async (hash: string) => {
        calls.push(`verify:${hash}`);
        return { ok: true as const };
      }),
      updatePassword: vi.fn(async (password: string) => {
        calls.push(`update:${password}`);
        return { ok: true as const };
      }),
      signOutEverywhere: vi.fn(async () => {
        calls.push("signOutEverywhere");
      }),
      clearPending: vi.fn(async () => {
        calls.push("clearPending");
      }),
      log: (...args: unknown[]) => {
        logged.push(args);
      },
      ...overrides,
    };
    return { deps, calls, logged };
  }

  it("happy path: verify the parked token, clear it, set the new password, then revoke EVERY session — in that order", async () => {
    const { deps, calls } = harness();
    await expect(completePasswordReset({ pending: recovery, password: NEW_PASSWORD }, deps)).resolves.toEqual({ kind: "success" });
    expect(calls).toEqual([`verify:${TOKEN}`, "clearPending", `update:${NEW_PASSWORD}`, "signOutEverywhere"]);
  });

  it("nothing parked: invalid link, and no service is called at all", async () => {
    const { deps, calls } = harness();
    await expect(completePasswordReset({ pending: null, password: NEW_PASSWORD }, deps)).resolves.toEqual({ kind: "invalid_link" });
    expect(calls).toEqual([]);
  });

  it.each(["signup", "magiclink", "invite", "email_change", "email"] as const)(
    "a parked %s token is NOT a recovery link: invalid link, not verified, not cleared, no password set",
    async (type) => {
      const { deps, calls } = harness();
      const result = await completePasswordReset({ pending: { tokenHash: TOKEN, type, next: "/account" }, password: NEW_PASSWORD }, deps);
      expect(result).toEqual({ kind: "invalid_link" });
      // the token belongs to another flow (e.g. a customer's magic link or an invitation): left alone
      expect(calls).toEqual([]);
    },
  );

  it("an expired / used / rejected recovery token: invalid link; the cookie is still cleared; no password is set; the failure is logged by code only", async () => {
    const { deps, calls, logged } = harness({
      verifyRecoveryToken: vi.fn(async (hash: string) => {
        calls.push(`verify:${hash}`);
        return { ok: false as const, error: { code: "otp_expired", status: 403, message: `Email link is invalid or has expired (${TOKEN})` } };
      }),
    });
    await expect(completePasswordReset({ pending: recovery, password: NEW_PASSWORD }, deps)).resolves.toEqual({ kind: "invalid_link" });
    expect(calls).toEqual([`verify:${TOKEN}`, "clearPending"]);
    expect(deps.updatePassword).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toEqual({ code: "otp_expired", status: 403 });
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  it.each([
    ["same_password", { kind: "password_rejected", reason: "same_password" }],
    ["weak_password", { kind: "password_rejected", reason: "weak_password" }],
    ["unexpected_failure", { kind: "failed" }],
  ] as const)("the auth service rejects the new password with %s: reported as %j — and every session is STILL revoked", async (code, expected) => {
    const { deps, calls, logged } = harness({
      updatePassword: vi.fn(async (password: string) => {
        calls.push(`update:${password}`);
        return { ok: false as const, error: { code, status: 422, message: `secret detail about ${NEW_PASSWORD}` } };
      }),
    });
    await expect(completePasswordReset({ pending: recovery, password: NEW_PASSWORD }, deps)).resolves.toEqual(expected);
    expect(calls).toEqual([`verify:${TOKEN}`, "clearPending", `update:${NEW_PASSWORD}`, "signOutEverywhere"]);
    const loggedText = JSON.stringify(logged);
    expect(loggedText).not.toContain(NEW_PASSWORD);
    expect(loggedText).not.toContain(TOKEN);
  });

  it("the new password and the token never reach the logger on any path", async () => {
    const sink: unknown[][] = [];
    const log = (...args: unknown[]) => {
      sink.push(args);
    };
    await completePasswordReset({ pending: recovery, password: NEW_PASSWORD }, harness({ log }).deps);
    await completePasswordReset(
      { pending: recovery, password: NEW_PASSWORD },
      harness({ log, verifyRecoveryToken: vi.fn(async () => ({ ok: false as const, error: { code: "bad", message: TOKEN } })) }).deps,
    );
    await completePasswordReset(
      { pending: recovery, password: NEW_PASSWORD },
      harness({ log, updatePassword: vi.fn(async () => ({ ok: false as const, error: { code: "bad", message: NEW_PASSWORD } })) }).deps,
    );
    expect(JSON.stringify(sink)).not.toContain(TOKEN);
    expect(JSON.stringify(sink)).not.toContain(NEW_PASSWORD);
  });

  it("single use: a second attempt with the same (now cleared) cookie state finds nothing parked", async () => {
    let parked: PendingConfirmation | null = recovery;
    const { deps } = harness({
      clearPending: vi.fn(async () => {
        parked = null;
      }),
    });
    await expect(completePasswordReset({ pending: parked, password: NEW_PASSWORD }, deps)).resolves.toEqual({ kind: "success" });
    await expect(completePasswordReset({ pending: parked, password: NEW_PASSWORD }, deps)).resolves.toEqual({ kind: "invalid_link" });
    expect(deps.verifyRecoveryToken).toHaveBeenCalledTimes(1);
    expect(deps.updatePassword).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("forgot / reset form schemas", () => {
  it("forgot: a valid e-mail passes (trimmed); anything else is the e-mail message, nothing about accounts", () => {
    expect(forgotPasswordSchema.parse({ email: `  ${EMAIL}  ` })).toEqual({ email: EMAIL });
    for (const email of ["", "not-an-email", "a@", "@b.com", "a b@c.com", null, undefined, 42]) {
      const parsed = forgotPasswordSchema.safeParse({ email });
      expect(parsed.success, String(email)).toBe(false);
    }
    const bad = forgotPasswordSchema.safeParse({ email: "nope" });
    expect(!bad.success && bad.error.issues[0]!.message).toBe("Geçerli bir e-posta adresi girin");
  });

  it(`reset: the password must be at least ${PASSWORD_MIN_LENGTH} characters`, () => {
    const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    const rejected = resetPasswordSchema.safeParse({ password: short, confirmPassword: short });
    expect(rejected.success).toBe(false);
    const exactly = "a".repeat(PASSWORD_MIN_LENGTH);
    expect(resetPasswordSchema.safeParse({ password: exactly, confirmPassword: exactly }).success).toBe(true);
  });

  it(`reset: the limit is ${PASSWORD_MAX_BYTES} BYTES, not characters — multi-byte characters count by their UTF-8 size`, () => {
    const atLimit = "a".repeat(PASSWORD_MAX_BYTES);
    expect(resetPasswordSchema.safeParse({ password: atLimit, confirmPassword: atLimit }).success).toBe(true);
    const overByOne = "a".repeat(PASSWORD_MAX_BYTES + 1);
    expect(resetPasswordSchema.safeParse({ password: overByOne, confirmPassword: overByOne }).success).toBe(false);
    // 37 x "ş" (2 bytes each) is only 37 characters but 74 bytes
    const multibyte = "ş".repeat(37);
    expect([...multibyte].length).toBeLessThan(PASSWORD_MAX_BYTES);
    expect(resetPasswordSchema.safeParse({ password: multibyte, confirmPassword: multibyte }).success).toBe(false);
  });

  it("reset: mismatched confirmation is rejected on the confirmation field, before any token is touched", () => {
    const parsed = resetPasswordSchema.safeParse({ password: NEW_PASSWORD, confirmPassword: `${NEW_PASSWORD}x` });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]!.path).toEqual(["confirmPassword"]);
      expect(parsed.error.issues[0]!.message).toBe("Şifreler eşleşmiyor");
    }
  });

  it("reset: missing fields (a forged form) fail validation instead of reaching the auth service", () => {
    expect(resetPasswordSchema.safeParse({}).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ password: NEW_PASSWORD }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ password: null, confirmPassword: null }).success).toBe(false);
  });
});
