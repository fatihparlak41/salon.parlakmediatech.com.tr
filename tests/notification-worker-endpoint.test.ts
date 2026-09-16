import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testDb,
  createTestUser,
  createTestTenant,
  createTestMembershipFromTemplate,
  addMembership,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
  type TestTenant,
} from "./helpers";

/**
 * Faz NOTIF.2E.3 — the internal worker trigger endpoint
 * (app/api/internal/notifications/process/route.ts).
 *
 * Calls the route's own exported GET handler directly against a real
 * Request object, matching this project's established "test the real
 * function directly" convention (see app/auth/confirm/route.ts's own
 * header comment) rather than driving it through an HTTP server this
 * suite has no harness for. Mocks the `web-push` package itself (the one
 * genuine external-system boundary — a real HTTP POST to a push
 * service), exactly the same narrow mocking boundary tests/web-push-
 * server.test.ts already established; everything else (DB, RPCs, the
 * route's own auth check, the worker core) runs for real against DEV.
 *
 * notification_delivery_activation is a global, non-tenant-scoped
 * singleton — cleared explicitly in afterEach/afterAll so no test
 * activation residue survives into another test or another suite.
 */

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

const TEST_CRON_SECRET = "test-only-cron-secret-not-a-real-value";
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY = "test-public-key";
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "test-private-key";
  process.env.WEB_PUSH_SUBJECT = "mailto:test@example.com";
  sendNotification.mockReset();
  setVapidDetails.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function loadRouteGET() {
  const mod = await import("../app/api/internal/notifications/process/route");
  return mod.GET;
}

function cronRequest(options: { authorization?: string | null; url?: string } = {}): Request {
  const url = options.url ?? "https://salon.parlakmediatech.com.tr/api/internal/notifications/process";
  const headers = new Headers();
  headers.set("user-agent", "vercel-cron/1.0");
  if (options.authorization !== null) {
    headers.set("authorization", options.authorization ?? `Bearer ${TEST_CRON_SECRET}`);
  }
  return new Request(url, { method: "GET", headers });
}

async function setActivation(activatedAt: Date): Promise<void> {
  await testDb`
    insert into notification_delivery_activation (id, activated_at) values (1, ${activatedAt.toISOString()})
    on conflict (id) do update set activated_at = excluded.activated_at
  `;
}
async function clearActivation(): Promise<void> {
  await testDb`delete from notification_delivery_activation where id = 1`;
}

// ===========================================================================
// A/B/C/E/F/H — pure auth + contract tests. No DEV fixture needed beyond
// activation itself (cleared/absent throughout this block).
// ===========================================================================

describe("auth + response contract (no eligible work)", () => {
  afterEach(async () => {
    await clearActivation();
  });

  it("A. missing Authorization header -> 401, rejected", async () => {
    const GET = await loadRouteGET();
    const response = await GET(cronRequest({ authorization: null }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("B. wrong secret -> 401, rejected", async () => {
    const GET = await loadRouteGET();
    const response = await GET(cronRequest({ authorization: "Bearer definitely-the-wrong-secret" }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("B2. CRON_SECRET unset on the server -> fails closed even with a well-formed header", async () => {
    delete process.env.CRON_SECRET;
    const GET = await loadRouteGET();
    const response = await GET(cronRequest({ authorization: `Bearer ${TEST_CRON_SECRET}` }));
    expect(response.status).toBe(401);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("C. correct secret + activation absent -> safe no-op (200), zero transport send", async () => {
    await clearActivation();
    const GET = await loadRouteGET();
    const response = await GET(cronRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.activationAbsent).toBe(true);
    expect(body.sent).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("F. success response contains no endpoint/key/customer PII shaped keys", async () => {
    await clearActivation();
    const GET = await loadRouteGET();
    const response = await GET(cronRequest());
    const body = await response.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/endpoint|p256dh|authKey|auth_key|customerName|full_name|appointmentId/i);
    expect(Object.keys(body).sort()).toEqual(
      ["activationAbsent", "claimed", "failed", "materialized", "ok", "prepared", "retried", "sent", "skipped", "stale"].sort(),
    );
  });

  it("H. request query-string parameters (tenantId/eventId/subscriptionId) have zero effect", async () => {
    await clearActivation();
    const GET = await loadRouteGET();
    const withParams = await GET(
      cronRequest({
        url: "https://salon.parlakmediatech.com.tr/api/internal/notifications/process?tenantId=forged&eventId=forged&subscriptionId=forged&batchSize=999999",
      }),
    );
    const withoutParams = await GET(cronRequest());
    expect(withParams.status).toBe(withoutParams.status);
    const [bodyWith, bodyWithout] = await Promise.all([withParams.json(), withoutParams.json()]);
    expect(bodyWith).toEqual(bodyWithout);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// E — worker throws.
// ===========================================================================

describe("unexpected worker failure", () => {
  afterEach(async () => {
    await clearActivation();
    vi.doUnmock("@/lib/supabase/admin");
  });

  it("E. worker throws -> sanitized non-2xx response, no internal details leaked", async () => {
    await setActivation(new Date(Date.now() - 60_000));

    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        rpc: () => Promise.resolve({ data: null, error: { message: "simulated database failure with sensitive detail xyz" } }),
      }),
    }));
    vi.resetModules();

    const GET = await loadRouteGET();
    const response = await GET(cronRequest());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("sensitive detail xyz");
    expect(serialized).not.toContain("simulated database failure");

    vi.resetModules();
  });
});

// ===========================================================================
// I — Node runtime / caching route contract (source-level structural
// check, same established pattern as this project's own app-shell
// structural tests — Next's runtime/dynamic exports are read by the
// build system, not observable via a unit-level function call).
// ===========================================================================

describe("I. route runtime/caching contract", () => {
  const source = readFileSync("app/api/internal/notifications/process/route.ts", "utf8");

  it("declares the Node.js runtime explicitly (web-push needs Node's crypto, not Edge-compatible)", () => {
    expect(source).toMatch(/export const runtime\s*=\s*["']nodejs["']/);
  });

  it("declares force-dynamic so a cron invocation is never served a cached response", () => {
    expect(source).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
  });

  it("is server-only (imports the server-only guard)", () => {
    expect(source.trimStart().startsWith('import "server-only";')).toBe(true);
  });
});

// ===========================================================================
// J — cron configuration points to the exact intended path.
// ===========================================================================

describe("J. vercel.json cron configuration", () => {
  it("points at the exact route path with a valid 5-field cron expression", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(Array.isArray(config.crons)).toBe(true);
    const entry = config.crons.find(
      (c: { path?: string }) => c.path === "/api/internal/notifications/process",
    );
    expect(entry).toBeDefined();
    expect(typeof entry.schedule).toBe("string");
    expect(entry.schedule.trim().split(/\s+/)).toHaveLength(5);
  });
});

// ===========================================================================
// D/G — real DEV fixture: eligible work exists, worker is actually
// invoked correctly, and overlapping invocations remain DB-safe.
// ===========================================================================

describe("D/G — real eligible work, overlap safety", () => {
  let tenant: TestTenant;
  let owner: TestUser;
  let appointmentId: string;
  let cashierRoleId: string;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    owner = await createTestUser("notif2e3-owner");
    const tenantRow = await createTestTenant("notif2e3-endpoint", owner.id);
    tenant = { id: tenantRow.id, slug: tenantRow.slug, ownerRoleId: tenantRow.ownerRoleId };
    cleanupUserIds.push(owner.id);

    const roleSeedUser = await createTestUser("notif2e3-role-seed");
    cleanupUserIds.push(roleSeedUser.id);
    const { roleId } = await createTestMembershipFromTemplate(tenant.id, roleSeedUser.id, "CASHIER");
    cashierRoleId = roleId;

    const [branch] = await testDb<{ id: string }[]>`
      insert into branches (tenant_id, name) values (${tenant.id}, 'NOTIF.2E.3 Branch') returning id
    `;
    const [customer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name) values (${tenant.id}, 'NOTIF.2E.3 Customer') returning id
    `;
    const [appointment] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, created_by, status)
      values (${tenant.id}, ${branch!.id}, ${customer!.id}, 'internal', now() + interval '1 day', now() + interval '1 day 30 minutes', ${owner.id}, 'scheduled')
      returning id
    `;
    appointmentId = appointment!.id;
  }, 60000);

  afterAll(async () => {
    await clearActivation();
    await cleanupTenants([tenant.id]);
    await cleanupUsers(cleanupUserIds);
  }, 60000);

  async function createEligibleTarget(label: string): Promise<{ endpoint: string }> {
    const user = await createTestUser(label);
    cleanupUserIds.push(user.id);
    const membershipId = await addMembership(tenant.id, user.id, cashierRoleId);
    const [staffRow] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name, tenant_membership_id, status)
      values (${tenant.id}, ${label}, ${membershipId}, 'active')
      returning id
    `;
    const endpoint = `https://example-push.test/notif2e3-${label}-${Date.now()}`;
    await testDb`
      insert into push_subscriptions (tenant_membership_id, endpoint, p256dh, auth_key)
      values (${membershipId}, ${endpoint}, ${"p256dh-" + label}, ${"authkey-" + label})
    `;

    await testDb`
      insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data, created_at)
      values (${tenant.id}, ${appointmentId}, 'appointment.created', ${owner.id}, ${testDb.json({ staffMemberIds: [staffRow!.id] })}, now())
    `;

    return { endpoint };
  }

  it("D. correct secret + DEV fixture activation + eligible work -> worker actually called, real send recorded", async () => {
    await setActivation(new Date(Date.now() - 60_000));
    const target = await createEligibleTarget("d-eligible");

    sendNotification.mockResolvedValue(undefined);

    const GET = await loadRouteGET();
    const response = await GET(cronRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.activationAbsent).toBe(false);
    expect(body.sent).toBeGreaterThanOrEqual(1);
    expect(sendNotification).toHaveBeenCalled();

    const [sentCall] = sendNotification.mock.calls.find(
      (call) => (call[0] as { endpoint?: string })?.endpoint === target.endpoint,
    ) ?? [];
    expect(sentCall).toBeDefined();

    const [row] = await testDb<{ status: string }[]>`
      select ndt.status from notification_delivery_targets ndt
      join push_subscriptions ps on ps.id = ndt.push_subscription_id
      where ps.endpoint = ${target.endpoint}
    `;
    expect(row?.status).toBe("sent");
  });

  it("G. overlapping invocations remain DB-safe — no duplicate successful send for the same device", async () => {
    await setActivation(new Date(Date.now() - 60_000));
    const target = await createEligibleTarget("g-overlap");

    sendNotification.mockResolvedValue(undefined);

    const GET = await loadRouteGET();
    // Fire two invocations concurrently, exactly what real overlapping
    // cron ticks would look like (previous run still finishing when the
    // next one starts).
    const [responseA, responseB] = await Promise.all([GET(cronRequest()), GET(cronRequest())]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);

    const rows = await testDb<{ status: string }[]>`
      select ndt.status from notification_delivery_targets ndt
      join push_subscriptions ps on ps.id = ndt.push_subscription_id
      where ps.endpoint = ${target.endpoint}
    `;
    // Exactly one target row for this device — claimed by whichever
    // invocation's FOR UPDATE SKIP LOCKED got there first, never
    // duplicated, never left unresolved by the other.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");

    const sendCallsForThisEndpoint = sendNotification.mock.calls.filter(
      (call) => (call[0] as { endpoint?: string })?.endpoint === target.endpoint,
    );
    expect(sendCallsForThisEndpoint).toHaveLength(1);
  });
});
