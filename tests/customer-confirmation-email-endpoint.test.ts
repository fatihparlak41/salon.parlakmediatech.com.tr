import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signInAs, testDb } from "./helpers";
import {
  activateConfirmationEmail,
  appointmentStatus,
  bookPublicly,
  confirmAs,
  createConfirmationFixture,
  jobsForAppointment,
  teardownFixtures,
  type ConfirmationFixture,
} from "./customer-confirmation-fixtures";
import { startSmtpCatcher, type SmtpCatcher } from "./smtp-catcher";

/**
 * Faz NOTIF.1A — the internal worker trigger
 * (app/api/internal/customer-notifications/process/route.ts). Matrix cases
 * 31-34: nobody but the scheduler can invoke it; a signed-in salon user's
 * session is not the cron secret; no CRON_SECRET means nobody at all; and
 * no credential or customer detail ever leaves the server.
 *
 * Calls the route's exported GET handler directly against a real Request
 * (this project's convention — see notification-worker-endpoint.test.ts).
 * Where a message is meant to be sent, the REAL transport is pointed at a
 * loopback catcher; nothing here can reach a real mail server.
 */

const TEST_CRON_SECRET = "test-only-cron-secret-not-a-real-value";
const ORIGINAL_ENV = { ...process.env };
const ROUTE_URL = "https://salon.parlakmediatech.com.tr/api/internal/customer-notifications/process";

let fx: ConfirmationFixture;
let catcher: SmtpCatcher | null = null;
let dayOffset = 2;
const nextDay = () => dayOffset++;

beforeAll(async () => {
  fx = await createConfirmationFixture("e", { salonName: "Uç Nokta Salon" });
  await activateConfirmationEmail(fx.slug);
}, 120_000);

afterAll(async () => {
  await teardownFixtures(fx ? [fx] : []);
}, 120_000);

beforeEach(async () => {
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  await testDb`delete from private.customer_notification_jobs where tenant_id = ${fx.tenant.id}`;
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  if (catcher) {
    await catcher.close();
    catcher = null;
  }
});

async function loadGET() {
  const mod = await import("../app/api/internal/customer-notifications/process/route");
  return mod.GET;
}

function request(options: { authorization?: string | null; url?: string } = {}): Request {
  const headers = new Headers({ "user-agent": "vercel-cron/1.0" });
  if (options.authorization !== null) headers.set("authorization", options.authorization ?? `Bearer ${TEST_CRON_SECRET}`);
  return new Request(options.url ?? ROUTE_URL, { method: "GET", headers });
}

async function pointSmtpAtCatcher(): Promise<SmtpCatcher> {
  catcher = await startSmtpCatcher();
  process.env.SMTP_HOST = catcher.host;
  process.env.SMTP_PORT = String(catcher.port);
  process.env.SMTP_USER = "catcher";
  process.env.SMTP_APP_PASSWORD = "not-a-real-password";
  process.env.EMAIL_FROM_ADDRESS = "SalonOS Test <noreply@salonos.test>";
  return catcher;
}

async function pendingJob(email = "uc.nokta@example.test") {
  const booking = await bookPublicly(fx, { dayOffset: nextDay(), email });
  await confirmAs(fx.owner.id, booking.appointmentId);
  return { appointmentId: booking.appointmentId, job: (await jobsForAppointment(booking.appointmentId))[0]! };
}

describe("31. an anonymous caller cannot invoke the worker", () => {
  it("no Authorization header -> 401, and nothing is processed", async () => {
    const c = await pointSmtpAtCatcher();
    const { job } = await pendingJob();
    const GET = await loadGET();

    const response = await GET(request({ authorization: null }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(c.connections()).toBe(0);
    expect((await jobsForAppointment(job.appointment_id))[0]).toMatchObject({ status: "pending", attempt_count: 0 });
  });
});

describe("32. an authenticated salon user cannot invoke the worker with their own session", () => {
  it("a real signed-in Owner's access token is not the cron secret -> 401", async () => {
    const c = await pointSmtpAtCatcher();
    const { job } = await pendingJob();
    const session = await signInAs(fx.owner);
    const { data } = await session.auth.getSession();
    const accessToken = data.session!.access_token;
    expect(accessToken.length).toBeGreaterThan(20);

    const GET = await loadGET();
    const response = await GET(request({ authorization: `Bearer ${accessToken}` }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(c.connections()).toBe(0);
    expect((await jobsForAppointment(job.appointment_id))[0]!.status).toBe("pending");
  });
});

describe("33. without the cron secret the endpoint answers 401 for everyone", () => {
  it("no CRON_SECRET configured: even a well-formed Bearer header is refused (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const GET = await loadGET();
    for (const authorization of [`Bearer ${TEST_CRON_SECRET}`, "Bearer ", "Bearer", "", null]) {
      const response = await GET(request({ authorization }));
      expect(response.status, String(authorization)).toBe(401);
    }
  });

  // (No trailing-space variant: the Headers API itself strips leading and
  // trailing whitespace from a header value, exactly as an HTTP server does,
  // so it cannot arrive as a distinct credential.)
  it("a wrong, malformed or differently-shaped credential is refused", async () => {
    const GET = await loadGET();
    for (const authorization of [
      "Bearer wrong-secret",
      `bearer ${TEST_CRON_SECRET}`,
      TEST_CRON_SECRET,
      `Basic ${TEST_CRON_SECRET}`,
      `Bearer  ${TEST_CRON_SECRET}`,
      `Bearer ${TEST_CRON_SECRET}extra`,
      `Bearer ${TEST_CRON_SECRET.slice(0, -1)}`,
    ]) {
      const response = await GET(request({ authorization }));
      expect(response.status, authorization).toBe(401);
    }
  });

  it("the rejection is logged as a fact only: the offered credential never reaches a log", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const GET = await loadGET();
    await GET(request({ authorization: "Bearer super-secret-attempt-123" }));
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("super-secret-attempt-123");
    }
  });

  it("the route exposes GET only — no POST/PUT/PATCH/DELETE handler exists to call", async () => {
    const mod = await import("../app/api/internal/customer-notifications/process/route");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((mod as Record<string, unknown>)[method], method).toBeUndefined();
    }
    expect(mod.runtime).toBe("nodejs");
    expect(mod.dynamic).toBe("force-dynamic");
  });
});

describe("with the secret: one bounded batch, counts only", () => {
  it("sends the queued confirmation through the real transport and reports counts", async () => {
    const c = await pointSmtpAtCatcher();
    const { appointmentId, job } = await pendingJob("uc.nokta.gercek@example.test");
    const GET = await loadGET();

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      activationAbsent: false,
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
      deferred: 0,
      leaseLost: 0,
      recordFailed: 0,
      purged: expect.any(Number),
      // the test process is not a Vercel production deployment
      realSmtpPermitted: false,
    });
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.envelopeTo).toEqual(["uc.nokta.gercek@example.test"]);
    expect(c.messages[0]!.subject).toBe("Randevunuz Onaylandı — Uç Nokta Salon");
    expect((await jobsForAppointment(appointmentId))[0]).toMatchObject({ id: job.id, status: "sent" });

    // scheduled again a minute later: nothing left to do
    const again = await (await GET(request())).json();
    expect(again).toMatchObject({ ok: true, claimed: 0, sent: 0 });
    expect(c.messages).toHaveLength(1);
  });

  it("the response and the log line carry no address, name, tenant, appointment or credential", async () => {
    await pointSmtpAtCatcher();
    const { appointmentId } = await pendingJob("kimlik.gizli@example.test");
    const logs = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const GET = await loadGET();

    const text = await (await GET(request())).text();

    const everything = text + JSON.stringify(logs.map((spy) => spy.mock.calls));
    for (const secret of [
      "kimlik.gizli",
      "example.test",
      fx.tenant.id,
      fx.slug,
      appointmentId,
      "Uç Nokta",
      TEST_CRON_SECRET,
      process.env.SMTP_APP_PASSWORD!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    ]) {
      expect(everything, secret).not.toContain(secret);
    }
    // ...but there IS a structured summary line
    expect(JSON.stringify(logs[1]!.mock.calls)).toContain("customer-confirmation-email batch complete");
  });

  it("the request carries no instruction: query parameters (tenant, job, batch size, recipient) are ignored", async () => {
    const c = await pointSmtpAtCatcher();
    await pendingJob("sorgu.yok@example.test");
    const GET = await loadGET();

    const body = await (
      await GET(request({ url: `${ROUTE_URL}?tenantId=${fx.tenant.id}&batchSize=9999&to=intruder@example.test&all=true` }))
    ).json();

    expect(body).toMatchObject({ ok: true, claimed: 1, sent: 1 });
    expect(c.messages.map((message) => message.envelopeTo)).toEqual([["sorgu.yok@example.test"]]);
  });

  it("a failure inside the worker gives a generic 500 with no detail, and leaves the appointment alone", async () => {
    const { appointmentId, job } = await pendingJob();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.SUPABASE_SERVICE_ROLE_KEY = "definitely-not-a-valid-service-key";
    const GET = await loadGET();

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("definitely-not-a-valid-service-key");
    expect(await appointmentStatus(appointmentId)).toBe("confirmed");
    process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_ENV.SUPABASE_SERVICE_ROLE_KEY;
    expect((await jobsForAppointment(appointmentId))[0]).toMatchObject({ id: job.id, status: "pending" });
  });

  it("with no activated tenant the endpoint is a cheap no-op that says so", async () => {
    await testDb`select private.deactivate_customer_confirmation_email(${fx.slug})`;
    try {
      const GET = await loadGET();
      const body = await (await GET(request())).json();
      expect(body).toMatchObject({ ok: true, claimed: 0, sent: 0 });
    } finally {
      await activateConfirmationEmail(fx.slug);
    }
  });
});

describe("34. service credentials and customer data stay on the server", () => {
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "tests"]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }
  const root = process.cwd();
  const read = (relative: string) => readFileSync(join(root, relative), "utf8");

  it("every new server module imports server-only", () => {
    for (const file of [
      "lib/email/smtp-transport.ts",
      "lib/modules/customer-notifications/confirmation-email-worker.ts",
      "app/api/internal/customer-notifications/process/route.ts",
    ]) {
      expect(read(file), file).toMatch(/^import ["']server-only["'];/m);
    }
  });

  it("no client component reaches the secrets or the new server modules", () => {
    const secretNames = ["SUPABASE_SERVICE_ROLE_KEY", "SMTP_APP_PASSWORD", "SMTP_USER", "SMTP_HOST", "CRON_SECRET", "EMAIL_FROM_ADDRESS"];
    const serverModules = ["smtp-transport", "confirmation-email-worker", "customer-notifications", "lib/supabase/admin"];
    const clientFiles = [...walk(join(root, "app")), ...walk(join(root, "components")), ...walk(join(root, "lib"))].filter((file) =>
      /^\s*["']use client["']/m.test(readFileSync(file, "utf8").slice(0, 400)),
    );
    expect(clientFiles.length).toBeGreaterThan(0);
    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      for (const name of secretNames) expect(source, `${file} mentions ${name}`).not.toContain(name);
      for (const name of serverModules) expect(source, `${file} imports ${name}`).not.toContain(name);
    }
  });

  it("none of the new configuration is exposed with a NEXT_PUBLIC_ prefix, anywhere", () => {
    const offenders = [...walk(join(root, "lib")), ...walk(join(root, "app")), ...walk(join(root, "components"))].filter((file) =>
      /NEXT_PUBLIC_(CRON|SMTP|EMAIL|CUSTOMER)/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
    expect(read(".env.example")).not.toMatch(/NEXT_PUBLIC_(CRON|SMTP|EMAIL_FROM)/);
  });

  it("the route reads nothing from the request but the Authorization header", () => {
    const source = read("app/api/internal/customer-notifications/process/route.ts");
    expect(source).not.toMatch(/searchParams|nextUrl|request\.(url|json|text|formData|body)|params\b/);
    expect(source).toContain('request.headers.get("authorization")');
    expect(source).toContain("isAuthorizedCronRequest");
  });

  it("vercel.json schedules exactly this path, next to the two existing crons", () => {
    const config = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
    expect(config.crons.map((cron) => cron.path).sort()).toEqual([
      "/api/internal/customer-notifications/process",
      "/api/internal/notifications/process",
      "/api/internal/notifications/purge-display-snapshots",
    ]);
    expect(config.crons.find((cron) => cron.path === "/api/internal/customer-notifications/process")!.schedule).toBe("* * * * *");
  });
});
