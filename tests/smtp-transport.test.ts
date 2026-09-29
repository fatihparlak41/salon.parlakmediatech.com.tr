import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import {
  classifySmtpFailure,
  isLoopbackSmtpHost,
  isSmtpHostAllowed,
  sendSmtpMail,
  type OutboundEmail,
  type SmtpTimeouts,
} from "@/lib/email/smtp-transport";
import { sendTeamInvitationEmail, type TeamInvitationEmailInput } from "@/lib/email/email-server";
import { startSmtpCatcher, type SmtpCatcher, type SmtpCatcherBehavior } from "./smtp-catcher";

/**
 * Faz NOTIF.1A — the generic SMTP transport: the fail-closed guard, the
 * RETRYABLE / PERMANENT / UNCERTAIN classification, and the invitation
 * path's unchanged contract.
 *
 * Every send here goes to a LOOPBACK catcher (tests/smtp-catcher.ts) or is
 * refused before any connection is opened. No test in this file can reach
 * a real mail server: the real credentials are stripped from the test
 * environment (vitest.config.ts), the transport refuses non-loopback hosts
 * outside a Vercel production deployment, and the assertions below pin both.
 */

const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_APP_PASSWORD", "EMAIL_FROM_ADDRESS", "VERCEL_ENV"] as const;

// Captured BEFORE any test mutates them: proves what the test process was born with.
const BORN_WITH = Object.fromEntries(SMTP_KEYS.map((key) => [key, process.env[key]]));

let saved: Record<string, string | undefined>;
let catcher: SmtpCatcher | null = null;

beforeEach(() => {
  saved = Object.fromEntries(SMTP_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  for (const key of SMTP_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
  if (catcher) {
    await catcher.close();
    catcher = null;
  }
});

function pointAt(host: string, port: number | string) {
  process.env.SMTP_HOST = host;
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_USER = "catcher-user";
  process.env.SMTP_APP_PASSWORD = "catcher-password-not-real";
  process.env.EMAIL_FROM_ADDRESS = "SalonOS Test <noreply@salonos.test>";
}

async function catcherWith(behavior: SmtpCatcherBehavior = {}): Promise<SmtpCatcher> {
  catcher = await startSmtpCatcher(behavior);
  pointAt(catcher.host, catcher.port);
  return catcher;
}

function message(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    to: "musteri@example.test",
    subject: "Randevunuz Onaylandı — Örnek Salon",
    html: "<p>Merhaba <b>Ayşe</b></p>",
    text: "Merhaba Ayşe",
    ...overrides,
  };
}

const FAST: SmtpTimeouts = { connectionTimeoutMs: 800, greetingTimeoutMs: 400, socketTimeoutMs: 600 };

async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("the test process never holds real SMTP credentials", () => {
  it("SMTP_* and EMAIL_FROM_ADDRESS were stripped from the environment this process was started with", () => {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_APP_PASSWORD", "EMAIL_FROM_ADDRESS"] as const) {
      expect(BORN_WITH[key], key).toBeUndefined();
    }
    expect(BORN_WITH.VERCEL_ENV).toBeUndefined();
  });

  it("vitest.config.ts is what strips them (and still forwards the rest of .env.local)", () => {
    const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain('"SMTP_APP_PASSWORD"');
    expect(config).toContain("env: testEnv");
    expect(config).not.toMatch(/env:\s*parsed/);
  });
});

describe("fail-closed guard: a real SMTP host is unreachable outside production", () => {
  it("recognises exactly the loopback hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST", " ::1 ", "[::1]"]) {
      expect(isLoopbackSmtpHost(host), host).toBe(true);
    }
    for (const host of ["smtp.gmail.com", "127.0.0.1.evil.example", "localhost.evil.example", "10.0.0.5", "0.0.0.0", "", "127.0.0.2"]) {
      expect(isLoopbackSmtpHost(host), host).toBe(false);
    }
  });

  it("allows a non-loopback host only when VERCEL_ENV is exactly 'production'", () => {
    expect(isSmtpHostAllowed("smtp.gmail.com", { VERCEL_ENV: "production" })).toBe(true);
    for (const env of [{}, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: "Production" }, { VERCEL_ENV: "" }]) {
      expect(isSmtpHostAllowed("smtp.gmail.com", env), JSON.stringify(env)).toBe(false);
    }
    expect(isSmtpHostAllowed("127.0.0.1", {})).toBe(true);
  });

  it("with the real Google host configured and no production flag, nothing is sent and no transport is even constructed", async () => {
    const createTransport = vi.spyOn(nodemailer, "createTransport");
    pointAt("smtp.gmail.com", 465);

    const result = await sendSmtpMail(message());

    expect(result).toEqual({
      outcome: "failed",
      provider: "google_workspace_smtp",
      errorClass: "not_configured",
      disposition: "permanent",
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("is blocked for every non-loopback host and every non-production environment, invitations included", async () => {
    const createTransport = vi.spyOn(nodemailer, "createTransport");
    for (const vercelEnv of [undefined, "preview", "development"]) {
      for (const host of ["smtp.gmail.com", "smtp-relay.gmail.com", "mail.example.com", "10.1.2.3"]) {
        pointAt(host, 587);
        if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = vercelEnv;

        const direct = await sendSmtpMail(message());
        expect(direct.outcome, `${host}/${vercelEnv}`).toBe("failed");

        const invitation = await sendTeamInvitationEmail(invitationInput());
        expect(invitation, `${host}/${vercelEnv}`).toEqual({
          outcome: "failed",
          provider: "google_workspace_smtp",
          errorClass: "not_configured",
        });
      }
    }
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("there is no override flag: nothing in the transport reads any variable but VERCEL_ENV to decide", () => {
    const source = readFileSync(join(process.cwd(), "lib/email/smtp-transport.ts"), "utf8");
    const decisionReads = [...source.matchAll(/env\.([A-Z_]+)|process\.env\.([A-Z_]+)/g)].map((m) => m[1] ?? m[2]);
    expect(new Set(decisionReads)).toEqual(
      new Set(["VERCEL_ENV", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_APP_PASSWORD", "EMAIL_FROM_ADDRESS"]),
    );
  });

  it("missing configuration is not_configured (retryable) and opens no connection", async () => {
    catcher = await startSmtpCatcher();
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_APP_PASSWORD", "EMAIL_FROM_ADDRESS"]) delete process.env[key];
    expect(await sendSmtpMail(message())).toEqual({
      outcome: "failed",
      provider: "google_workspace_smtp",
      errorClass: "not_configured",
      disposition: "retryable",
    });
    expect(catcher.connections()).toBe(0);
  });
});

describe("real nodemailer against the loopback catcher", () => {
  it("delivers exactly one message with the right envelope, headers and decoded body", async () => {
    const c = await catcherWith();

    const result = await sendSmtpMail(
      message({
        messageIdLocalPart: "confirmation.0f7c1e0a-1111-4222-8333-444455556666",
        headers: { "Auto-Submitted": "auto-generated" },
      }),
    );

    expect(result.outcome).toBe("sent");
    if (result.outcome !== "sent") return;
    expect(result.providerMessageId).toBe("<confirmation.0f7c1e0a-1111-4222-8333-444455556666@salonos.test>");

    expect(c.messages).toHaveLength(1);
    const received = c.messages[0]!;
    expect(received.envelopeTo).toEqual(["musteri@example.test"]);
    expect(received.envelopeFrom).toBe("noreply@salonos.test");
    expect(received.subject).toBe("Randevunuz Onaylandı — Örnek Salon");
    expect(received.text).toBe("Merhaba Ayşe");
    expect(received.html).toBe("<p>Merhaba <b>Ayşe</b></p>");
    expect(received.headers["message-id"]).toBe("<confirmation.0f7c1e0a-1111-4222-8333-444455556666@salonos.test>");
    expect(received.headers["auto-submitted"]).toBe("auto-generated");
    expect(received.headers["from"]).toContain("noreply@salonos.test");
    expect(received.headers["to"]).toBe("musteri@example.test");
    // exactly the one recipient: no Bcc/Cc leak
    expect(received.headers["bcc"]).toBeUndefined();
    expect(received.headers["cc"]).toBeUndefined();
  });

  it("an unusable Message-ID local part is ignored (nodemailer generates one); it is never interpolated blindly", async () => {
    const c = await catcherWith();
    await sendSmtpMail(message({ messageIdLocalPart: "bad id>\r\nBcc: x@y.test" }));
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.headers["bcc"]).toBeUndefined();
    expect(c.messages[0]!.headers["message-id"]).not.toContain("Bcc");
  });

  it("never logs a credential, an address or a body", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    await catcherWith();
    await sendSmtpMail(message());
    await catcher!.close();
    await sendSmtpMail(message());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("never throws, even if constructing the transport throws (and reports it as not-sent/retryable)", async () => {
    await catcherWith();
    vi.spyOn(nodemailer, "createTransport").mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(sendSmtpMail(message())).resolves.toEqual({
      outcome: "failed",
      provider: "google_workspace_smtp",
      errorClass: "unknown",
      disposition: "retryable",
    });
  });
});

type Expectation = { errorClass: string; disposition: "retryable" | "permanent" | "uncertain" };

describe("RETRYABLE / PERMANENT / UNCERTAIN — the real nodemailer against scripted SMTP failures", () => {
  const cases: Array<[string, SmtpCatcherBehavior, Expectation]> = [
    // -- the server answered: definitive
    ["AUTH refused (535)", { authFail: true }, { errorClass: "authentication_failed", disposition: "permanent" }],
    ["MAIL FROM 451 (temporary)", { mailFrom: "451 4.3.0 try later" }, { errorClass: "provider_unavailable", disposition: "retryable" }],
    ["MAIL FROM 550 (sender refused)", { mailFrom: "550 5.7.1 sender refused" }, { errorClass: "provider_rejected", disposition: "permanent" }],
    ["RCPT TO 550 (no such mailbox)", { rcpt: "550 5.1.1 no such user" }, { errorClass: "invalid_recipient", disposition: "permanent" }],
    ["RCPT TO 553 (bad address)", { rcpt: "553 5.1.3 bad address" }, { errorClass: "invalid_recipient", disposition: "permanent" }],
    ["RCPT TO 452 (mailbox busy, temporary)", { rcpt: "452 4.2.2 try later" }, { errorClass: "provider_unavailable", disposition: "retryable" }],
    ["RCPT TO 421 (service closing)", { rcpt: "421 4.7.0 try later" }, { errorClass: "provider_unavailable", disposition: "retryable" }],
    ["DATA command refused (554)", { dataCommand: "554 5.5.1 no" }, { errorClass: "provider_rejected", disposition: "permanent" }],
    ["message refused after the payload (451, temporary)", { dataFinal: "451 4.7.1 greylisted" }, { errorClass: "provider_unavailable", disposition: "retryable" }],
    ["message refused after the payload (554, permanent)", { dataFinal: "554 5.7.1 spam" }, { errorClass: "provider_rejected", disposition: "permanent" }],
    ["message refused after the payload (550)", { dataFinal: "550 5.7.1 rejected" }, { errorClass: "provider_rejected", disposition: "permanent" }],
    // -- no reply, provably before the payload
    ["greeting never arrives", { noGreeting: true }, { errorClass: "network_error", disposition: "retryable" }],
    // -- no reply, cannot be placed before the payload: uncertain
    ["connection dropped right after connect", { dropAfterConnect: true }, { errorClass: "network_error", disposition: "uncertain" }],
    ["connection dropped at EHLO", { dropAtEhlo: true }, { errorClass: "network_error", disposition: "uncertain" }],
    ["connection dropped AFTER the full payload, before any reply", { dropAfterData: true }, { errorClass: "network_error", disposition: "uncertain" }],
    ["no reply AFTER the full payload (socket timeout)", { hangAfterData: true }, { errorClass: "network_error", disposition: "uncertain" }],
  ];

  for (const [name, behavior, expected] of cases) {
    it(`${name} -> ${expected.disposition} (${expected.errorClass})`, async () => {
      const c = await catcherWith(behavior);
      const result = await sendSmtpMail(message(), { timeouts: FAST });
      expect(result).toEqual({ outcome: "failed", provider: "google_workspace_smtp", ...expected });
      // nothing was ever recorded as delivered
      expect(c.messages).toHaveLength(0);
    });
  }

  it("connection refused (nothing listening) -> retryable network_error", async () => {
    pointAt("127.0.0.1", await closedPort());
    expect(await sendSmtpMail(message(), { timeouts: FAST })).toEqual({
      outcome: "failed",
      provider: "google_workspace_smtp",
      errorClass: "network_error",
      disposition: "retryable",
    });
  });

  it("the uncertain cases really are the ones where the server HAD the whole payload", async () => {
    const c = await catcherWith({ dropAfterData: true });
    await sendSmtpMail(message(), { timeouts: FAST });
    expect(c.payloads()).toBe(1);

    await c.close();
    const c2 = await startSmtpCatcher({ dropAtEhlo: true });
    catcher = c2;
    pointAt(c2.host, c2.port);
    await sendSmtpMail(message(), { timeouts: FAST });
    // ... and the EHLO-stage drop, which is (conservatively) also uncertain, never got that far.
    expect(c2.payloads()).toBe(0);
  });
});

describe("classifySmtpFailure on the raw error shapes", () => {
  it("anything that is not an error object is uncertain, never 'safe to retry'", () => {
    for (const value of [null, undefined, "boom", 42]) {
      expect(classifySmtpFailure(value)).toEqual({ errorClass: "unknown", disposition: "uncertain" });
    }
    expect(classifySmtpFailure({})).toEqual({ errorClass: "unknown", disposition: "uncertain" });
    expect(classifySmtpFailure({ code: "SOME_FUTURE_CODE" })).toEqual({ errorClass: "unknown", disposition: "uncertain" });
  });

  it("a server verdict wins over the transport code", () => {
    expect(classifySmtpFailure({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 454 })).toEqual({
      errorClass: "rate_limited",
      disposition: "retryable",
    });
    expect(classifySmtpFailure({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 })).toEqual({
      errorClass: "invalid_recipient",
      disposition: "permanent",
    });
    expect(classifySmtpFailure({ code: "EENVELOPE", command: "RCPT TO", responseCode: 451 })).toEqual({
      errorClass: "provider_unavailable",
      disposition: "retryable",
    });
    expect(classifySmtpFailure({ code: "EMESSAGE", command: "DATA", responseCode: 552 })).toEqual({
      errorClass: "provider_rejected",
      disposition: "permanent",
    });
  });

  it("pre-payload transport failures are retryable; mid-session ones are not", () => {
    expect(classifySmtpFailure({ code: "EDNS", command: "CONN" }).disposition).toBe("retryable");
    expect(classifySmtpFailure({ code: "ETLS", command: "CONN" }).disposition).toBe("retryable");
    expect(classifySmtpFailure({ code: "ESOCKET", command: "CONN", syscall: "connect" }).disposition).toBe("retryable");
    expect(classifySmtpFailure({ code: "ESOCKET", command: "CONN", syscall: "read" }).disposition).toBe("uncertain");
    expect(classifySmtpFailure({ code: "ESOCKET", command: "CONN" }).disposition).toBe("uncertain");
    expect(classifySmtpFailure({ code: "ETIMEDOUT", message: "Connection timeout" }).disposition).toBe("retryable");
    expect(classifySmtpFailure({ code: "ETIMEDOUT", message: "Greeting never received" }).disposition).toBe("retryable");
    expect(classifySmtpFailure({ code: "ETIMEDOUT", message: "Timeout" }).disposition).toBe("uncertain");
    expect(classifySmtpFailure({ code: "ECONNECTION", message: "Connection closed unexpectedly" }).disposition).toBe("uncertain");
    expect(classifySmtpFailure({ message: "Unexpected socket close" })).toEqual({
      errorClass: "network_error",
      disposition: "uncertain",
    });
    expect(classifySmtpFailure({ code: "EPROTOCOL", message: "Invalid greeting. response=999" }).disposition).toBe("retryable");
    expect(classifySmtpFailure({ code: "EPROTOCOL", message: "Unexpected Response" }).disposition).toBe("uncertain");
  });

  it("errors nodemailer raises before any I/O: a bad recipient/credentials are permanent", () => {
    expect(classifySmtpFailure({ code: "EENVELOPE", command: "API", message: "Invalid recipient" })).toEqual({
      errorClass: "invalid_recipient",
      disposition: "permanent",
    });
    expect(classifySmtpFailure({ code: "EAUTH", command: "API", message: "Missing credentials" })).toEqual({
      errorClass: "authentication_failed",
      disposition: "permanent",
    });
  });
});

function invitationInput(overrides: Partial<TeamInvitationEmailInput> = {}): TeamInvitationEmailInput {
  return {
    to: "davetli@example.test",
    tenantName: "Örnek Salon",
    roleName: "Yönetici",
    inviterName: "Salon Sahibi",
    acceptUrl: "https://salon.example.test/accept-invite?token=abc123",
    expiresAt: new Date("2026-10-30T12:00:00.000Z"),
    tenantTimezone: "Europe/Istanbul",
    locale: "tr",
    ...overrides,
  };
}

describe("the team-invitation email is unchanged by the refactor", () => {
  it("still sends through the (loopback) transport, with the same outcome shape and no retry-disposition field", async () => {
    const c = await catcherWith();
    const result = await sendTeamInvitationEmail(invitationInput());

    expect(result.outcome).toBe("sent");
    expect(Object.keys(result).sort()).toEqual(["outcome", "provider", "providerMessageId"]);
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.envelopeTo).toEqual(["davetli@example.test"]);
    expect(c.messages[0]!.subject).toBe("Örnek Salon sizi SalonOS'a davet etti");
    expect(c.messages[0]!.html).toContain("Daveti Kabul Et");
    expect(c.messages[0]!.text).toContain("https://salon.example.test/accept-invite?token=abc123");
  });

  it("a rejected recipient is still reported as exactly { failed, invalid_recipient }", async () => {
    await catcherWith({ rcpt: "550 5.1.1 no such user" });
    expect(await sendTeamInvitationEmail(invitationInput())).toEqual({
      outcome: "failed",
      provider: "google_workspace_smtp",
      errorClass: "invalid_recipient",
    });
  });

  it("an injected transport still wins, exactly as before", async () => {
    const send = vi.fn(async () => ({ outcome: "sent" as const, provider: "google_workspace_smtp" as const, providerMessageId: "<x>" }));
    expect(await sendTeamInvitationEmail(invitationInput(), { send })).toEqual({
      outcome: "sent",
      provider: "google_workspace_smtp",
      providerMessageId: "<x>",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("there is exactly one nodemailer transport in the project", () => {
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "tests"]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("only lib/email/smtp-transport.ts imports nodemailer (or its lib/* entry points)", () => {
    const root = process.cwd();
    const importers = [...walk(join(root, "lib")), ...walk(join(root, "app")), ...walk(join(root, "components"))]
      .filter((file) => /from\s+["']nodemailer(\/[^"']*)?["']|require\(["']nodemailer/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1).replace(/\\/g, "/"));
    expect(importers).toEqual(["lib/email/smtp-transport.ts"]);
  });

  it("both email modules are server-only and never touch a Supabase client or an RPC", () => {
    for (const file of ["lib/email/smtp-transport.ts", "lib/email/email-server.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).toMatch(/^import ["']server-only["'];/m);
      expect(source, file).not.toContain("lib/supabase");
      expect(source, file).not.toContain(".rpc(");
      expect(source, file).not.toMatch(/NEXT_PUBLIC_/);
    }
  });
});
