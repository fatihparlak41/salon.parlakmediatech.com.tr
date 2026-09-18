import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  classifySmtpError,
  classifyThrownEmailError,
  sendTeamInvitationEmail,
  type EmailSendOutcome,
  type SendEmailTransport,
  type TeamInvitationEmailInput,
} from "@/lib/email/email-server";

/**
 * Faz SAAS.1C.2A (foundation) / SAAS.1C.2D (Google Workspace SMTP
 * transport swap). No orchestration, no template, no invitation RPC
 * anywhere near this module — see lib/email/email-server.ts's own
 * header. Every test here uses either the injected fake transport or
 * the not_configured (missing/malformed env var) path; none requires
 * network access, a real mailbox, or a real App Password, matching this
 * phase's own required invariant.
 */

const EMAIL_ENV_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_APP_PASSWORD", "EMAIL_FROM_ADDRESS"] as const;
let savedEnv: Record<string, string | undefined>;

function setFullValidConfig() {
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_PORT = "465";
  process.env.SMTP_USER = "noreply@parlakmediatech.com.tr";
  process.env.SMTP_APP_PASSWORD = "placeholder-not-a-real-app-password";
  process.env.EMAIL_FROM_ADDRESS = "SalonOS <noreply@parlakmediatech.com.tr>";
}

beforeEach(() => {
  savedEnv = Object.fromEntries(EMAIL_ENV_VARS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const key of EMAIL_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function baseInput(overrides: Partial<TeamInvitationEmailInput> = {}): TeamInvitationEmailInput {
  return {
    to: "owner@example.com",
    tenantName: "Test Salon",
    roleName: "Sınırlı Rol",
    inviterName: "Test Inviter",
    acceptUrl: "https://salon.parlakmediatech.com.tr/accept-invite?token=abc123",
    expiresAt: new Date("2026-09-25T00:00:00.000Z"),
    tenantTimezone: "Europe/Istanbul",
    locale: "tr",
    ...overrides,
  };
}

function fakeTransport(outcome: EmailSendOutcome): SendEmailTransport {
  return async () => outcome;
}

describe("1. server-only module guard", () => {
  it("lib/email/email-server.ts imports server-only", () => {
    const source = readFileSync(join(process.cwd(), "lib/email/email-server.ts"), "utf8");
    expect(source).toMatch(/^import ["']server-only["'];/m);
  });
});

describe("configuration behavior — every required var is actually checked (2-7)", () => {
  it("2. missing SMTP_HOST -> not_configured", async () => {
    setFullValidConfig();
    delete process.env.SMTP_HOST;
    const result = await sendTeamInvitationEmail(baseInput());
    expect(result).toEqual({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "not_configured" });
  });

  it("3. missing SMTP_PORT -> not_configured", async () => {
    setFullValidConfig();
    delete process.env.SMTP_PORT;
    const result = await sendTeamInvitationEmail(baseInput());
    expect(result).toEqual({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "not_configured" });
  });

  it("4. missing SMTP_USER -> not_configured", async () => {
    setFullValidConfig();
    delete process.env.SMTP_USER;
    const result = await sendTeamInvitationEmail(baseInput());
    expect(result).toEqual({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "not_configured" });
  });

  it("5. missing SMTP_APP_PASSWORD -> not_configured", async () => {
    setFullValidConfig();
    delete process.env.SMTP_APP_PASSWORD;
    const result = await sendTeamInvitationEmail(baseInput());
    expect(result).toEqual({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "not_configured" });
  });

  it("6. missing EMAIL_FROM_ADDRESS -> not_configured", async () => {
    setFullValidConfig();
    delete process.env.EMAIL_FROM_ADDRESS;
    const result = await sendTeamInvitationEmail(baseInput());
    expect(result).toEqual({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "not_configured" });
  });

  it("7. non-numeric SMTP_PORT -> not_configured (malformed, not just missing)", async () => {
    setFullValidConfig();
    process.env.SMTP_PORT = "not-a-port";
    const result = await sendTeamInvitationEmail(baseInput());
    expect(result).toEqual({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "not_configured" });
  });
});

describe("successful send via injected fake transport (8-9)", () => {
  it("8. successful fake transport -> sent", async () => {
    const send = fakeTransport({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_abc" });
    const result = await sendTeamInvitationEmail(baseInput(), { send });
    expect(result.outcome).toBe("sent");
  });

  it("9. providerMessageId (nodemailer's messageId) propagated safely", async () => {
    const send = fakeTransport({
      outcome: "sent",
      provider: "google_workspace_smtp",
      providerMessageId: "<msg_xyz_789@parlakmediatech.com.tr>",
    });
    const result = await sendTeamInvitationEmail(baseInput(), { send });
    expect(result).toEqual({
      outcome: "sent",
      provider: "google_workspace_smtp",
      providerMessageId: "<msg_xyz_789@parlakmediatech.com.tr>",
    });
  });
});

describe("error classification — real nodemailer runtime error shape (10-17)", () => {
  it("10. authentication failure classification — EAUTH code and 535 response", () => {
    expect(classifySmtpError({ code: "EAUTH" })).toBe("authentication_failed");
    expect(classifySmtpError({ responseCode: 535 })).toBe("authentication_failed");
  });

  it("11. invalid-recipient classification — EENVELOPE code and 550 response", () => {
    expect(classifySmtpError({ code: "EENVELOPE" })).toBe("invalid_recipient");
    expect(classifySmtpError({ responseCode: 550 })).toBe("invalid_recipient");
  });

  it("12. network failure classification — connection-level codes", () => {
    expect(classifySmtpError({ code: "ECONNECTION" })).toBe("network_error");
    expect(classifySmtpError({ code: "ETIMEDOUT" })).toBe("network_error");
    expect(classifySmtpError({ code: "ESOCKET" })).toBe("network_error");
    expect(classifySmtpError({ code: "EDNS" })).toBe("network_error");
  });

  it("13. rate-limited classification — RFC 4954's 454 temporary-authentication-failure response", () => {
    expect(classifySmtpError({ responseCode: 454 })).toBe("rate_limited");
  });

  it("14. provider unavailable classification — generic 4xx temporary-failure responses", () => {
    expect(classifySmtpError({ responseCode: 421 })).toBe("provider_unavailable");
    expect(classifySmtpError({ responseCode: 450 })).toBe("provider_unavailable");
    expect(classifySmtpError({ responseCode: 451 })).toBe("provider_unavailable");
    expect(classifySmtpError({ responseCode: 452 })).toBe("provider_unavailable");
  });

  it("15. provider rejected classification — 55x permanent rejections other than 550", () => {
    expect(classifySmtpError({ responseCode: 551 })).toBe("provider_rejected");
    expect(classifySmtpError({ responseCode: 553 })).toBe("provider_rejected");
    expect(classifySmtpError({ responseCode: 554 })).toBe("provider_rejected");
  });

  it("16. unknown failure classification — an unshaped or unrecognized error", () => {
    expect(classifySmtpError({ code: "SOME_FUTURE_CODE_NOT_YET_MAPPED" })).toBe("unknown");
    expect(classifySmtpError({ responseCode: 999 })).toBe("unknown");
    expect(classifySmtpError("not even an object")).toBe("unknown");
    expect(classifySmtpError(null)).toBe("unknown");
  });

  it("17. classifyThrownEmailError — uniformly network_error for anything the transport itself throws outside the classifier", () => {
    expect(classifyThrownEmailError(new Error("ECONNRESET"))).toBe("network_error");
    expect(classifyThrownEmailError(new TypeError("boom"))).toBe("network_error");
    expect(classifyThrownEmailError("not even an Error instance")).toBe("network_error");
  });
});

describe("robustness (18-20)", () => {
  it("18. sendTeamInvitationEmail never throws, even when the injected transport itself throws", async () => {
    const send: SendEmailTransport = async () => {
      throw new Error("simulated transport crash");
    };
    await expect(sendTeamInvitationEmail(baseInput(), { send })).resolves.toEqual({
      outcome: "failed",
      provider: "google_workspace_smtp",
      errorClass: "network_error",
    });
  });

  it("19. raw provider error text is never returned to the caller", async () => {
    const distinctiveSecretLookingMessage = "SMTP said: DO-NOT-LEAK-ME-abcdef123456";
    const send: SendEmailTransport = async () => {
      throw new Error(distinctiveSecretLookingMessage);
    };
    const result = await sendTeamInvitationEmail(baseInput(), { send });
    expect(JSON.stringify(result)).not.toContain(distinctiveSecretLookingMessage);
    expect(JSON.stringify(result)).not.toContain("DO-NOT-LEAK-ME");
  });

  it("20. input object is not mutated", async () => {
    const input = baseInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    const send = fakeTransport({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    await sendTeamInvitationEmail(input, { send });
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});

describe("test-environment invariants (21-22)", () => {
  it("21. no real network call is required — the fake transport path never touches a real SMTP server", async () => {
    const send = fakeTransport({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_fast" });
    const start = Date.now();
    await sendTeamInvitationEmail(baseInput(), { send });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("22. no real secret is required — not_configured path never reads a real App Password", async () => {
    for (const key of EMAIL_ENV_VARS) delete process.env[key];
    const result = await sendTeamInvitationEmail(baseInput());
    expect(result).toEqual({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "not_configured" });
  });
});

describe("repo-wide safety checks (23-24)", () => {
  const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, out);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry) || entry === ".env.example") {
        out.push(full);
      }
    }
    return out;
  }

  it("23. no NEXT_PUBLIC_-prefixed SMTP credential appears anywhere in the repo", () => {
    const root = process.cwd();
    const files = [
      ...walk(join(root, "lib")),
      ...walk(join(root, "app")),
      ...walk(join(root, "components")),
      join(root, ".env.example"),
    ];
    const forbidden = [
      "NEXT_PUBLIC_SMTP_HOST",
      "NEXT_PUBLIC_SMTP_PORT",
      "NEXT_PUBLIC_SMTP_USER",
      "NEXT_PUBLIC_SMTP_APP_PASSWORD",
      "NEXT_PUBLIC_EMAIL_FROM_ADDRESS",
    ];
    for (const token of forbidden) {
      const offenders = files.filter((f) => readFileSync(f, "utf8").includes(token));
      expect(offenders).toEqual([]);
    }
  });

  it("24. the adapter never references any invitation RPC or Supabase client", () => {
    const source = readFileSync(join(process.cwd(), "lib/email/email-server.ts"), "utf8");
    const forbidden = [
      "create_team_invitation",
      "resend_team_invitation",
      "accept_team_invitation",
      "revoke_team_invitation",
      "list_team_invitations",
      "lib/supabase/server",
      "lib/supabase/admin",
      ".rpc(",
    ];
    for (const token of forbidden) {
      expect(source).not.toContain(token);
    }
  });
});

describe("logging safety (25)", () => {
  it("25. no console output at all — success and failure paths both stay silent, including credentials", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      await sendTeamInvitationEmail(baseInput({ to: "sensitive-recipient@example.com" }), {
        send: fakeTransport({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" }),
      });
      await sendTeamInvitationEmail(baseInput({ to: "sensitive-recipient-2@example.com" }), {
        send: async () => {
          throw new Error("boom");
        },
      });
      setFullValidConfig();
      delete process.env.SMTP_APP_PASSWORD;
      await sendTeamInvitationEmail(baseInput({ to: "sensitive-recipient-3@example.com" }));

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
