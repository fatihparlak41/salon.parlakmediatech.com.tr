import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb, createTestUser, createTestTenant, createBranch, createCustomer, cleanupTenants, cleanupUsers, type TestUser, type TestTenant } from "./helpers";

/**
 * Faz NOTIF.2F.3 — the internal retention trigger endpoint (app/api/
 * internal/notifications/purge-display-snapshots/route.ts).
 *
 * Calls the route's own exported GET handler directly against a real
 * Request object, matching tests/notification-worker-endpoint.test.ts's
 * own established convention (itself matching app/auth/confirm/
 * route.ts's "test the real function directly" precedent). No `web-push`
 * mocking needed here — this route never sends a push, it only calls one
 * RPC — so DB/RPC/auth all run for real against DEV except where a test
 * specifically mocks lib/supabase/admin to observe the exact RPC call
 * arguments or simulate an RPC failure.
 */

const TEST_CRON_SECRET = "test-only-cron-secret-not-a-real-value";
const ORIGINAL_ENV = { ...process.env };
const ROUTE_PATH = "app/api/internal/notifications/purge-display-snapshots/route.ts";
const ROUTE_URL = "https://salon.parlakmediatech.com.tr/api/internal/notifications/purge-display-snapshots";

beforeAll(() => {
  process.env.CRON_SECRET = TEST_CRON_SECRET;
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/supabase/admin");
});

async function loadRouteGET() {
  const mod = await import("../app/api/internal/notifications/purge-display-snapshots/route");
  return mod.GET;
}

function cronRequest(options: { authorization?: string | null; url?: string } = {}): Request {
  const url = options.url ?? ROUTE_URL;
  const headers = new Headers();
  headers.set("user-agent", "vercel-cron/1.0");
  if (options.authorization !== null) {
    headers.set("authorization", options.authorization ?? `Bearer ${TEST_CRON_SECRET}`);
  }
  return new Request(url, { method: "GET", headers });
}

function mockAdminRpc(impl: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({ rpc: impl }),
  }));
  vi.resetModules();
}

// ===========================================================================
// A/B — auth.
// ===========================================================================

describe("auth", () => {
  it("A. missing Authorization header -> 401, rejected", async () => {
    const GET = await loadRouteGET();
    const response = await GET(cronRequest({ authorization: null }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it("B. wrong secret -> 401, rejected", async () => {
    const GET = await loadRouteGET();
    const response = await GET(cronRequest({ authorization: "Bearer definitely-the-wrong-secret" }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it("missing CRON_SECRET on the server -> 401 even with a well-formed header", async () => {
    delete process.env.CRON_SECRET;
    const GET = await loadRouteGET();
    const response = await GET(cronRequest({ authorization: `Bearer ${TEST_CRON_SECRET}` }));
    expect(response.status).toBe(401);
    process.env.CRON_SECRET = TEST_CRON_SECRET;
  });
});

// ===========================================================================
// C — correct auth, no expired snapshots left after convergence.
// ===========================================================================

describe("no-op case", () => {
  it("C. correct auth + no expired snapshots -> 200, purged = 0 (a second immediate call converges to zero)", async () => {
    const GET = await loadRouteGET();
    // First call drains any pre-existing global backlog (harmless,
    // exactly what the real cron does); the SECOND, immediate call has
    // nothing left to find, proving the no-op contract without assuming
    // a pristine starting state shared across test files.
    await GET(cronRequest());
    const response = await GET(cronRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.purged).toBe(0);
  });
});

// ===========================================================================
// E/F — the RPC is always called with exactly {p_batch_size: 500}, never
// overridable by any request parameter.
// ===========================================================================

describe("fixed batch size, no caller override", () => {
  it("E. the endpoint always requests batch size 500 from the RPC", async () => {
    let capturedArgs: unknown;
    mockAdminRpc((_name, args) => {
      capturedArgs = args;
      return Promise.resolve({ data: 0, error: null });
    });

    const GET = await loadRouteGET();
    await GET(cronRequest());

    expect(capturedArgs).toEqual({ p_batch_size: 500 });
  });

  it("F. request query-string parameters cannot override the batch size or target anything", async () => {
    let capturedArgs: unknown;
    mockAdminRpc((_name, args) => {
      capturedArgs = args;
      return Promise.resolve({ data: 0, error: null });
    });

    const GET = await loadRouteGET();
    await GET(
      cronRequest({
        url: `${ROUTE_URL}?p_batch_size=1&batchSize=999999&tenantId=forged&eventId=forged&ageDays=1&retentionDays=1`,
      }),
    );

    expect(capturedArgs).toEqual({ p_batch_size: 500 });
  });
});

// ===========================================================================
// G — RPC failure.
// ===========================================================================

describe("RPC failure", () => {
  it("G. RPC error -> sanitized non-2xx response, no raw DB detail leaked", async () => {
    mockAdminRpc(() =>
      Promise.resolve({ data: null, error: { message: "simulated database failure with sensitive detail xyz" } }),
    );

    const GET = await loadRouteGET();
    const response = await GET(cronRequest());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("internal_error");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("sensitive detail xyz");
    expect(serialized).not.toContain("simulated database failure");
  });
});

// ===========================================================================
// H — no PII anywhere in the response or the log.
// ===========================================================================

describe("privacy", () => {
  it("H. response and log contain no customer/event/snapshot data, only counts", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const GET = await loadRouteGET();
      const response = await GET(cronRequest());
      const body = await response.json();

      expect(Object.keys(body).sort()).toEqual(["ok", "purged"].sort());
      const serializedBody = JSON.stringify(body);
      expect(serializedBody).not.toMatch(
        /customerName|full_name|serviceNames|appointmentStartAt|eventId|tenantId|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );

      expect(infoSpy).toHaveBeenCalledWith(
        "notification-display-snapshot-purge complete",
        expect.objectContaining({ durationMs: expect.any(Number), purgedCount: expect.any(Number) }),
      );
      const logArgs = infoSpy.mock.calls.find((c) => c[0] === "notification-display-snapshot-purge complete")?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(Object.keys(logArgs ?? {}).sort()).toEqual(["durationMs", "purgedCount"].sort());
    } finally {
      infoSpy.mockRestore();
    }
  });
});

// ===========================================================================
// I/J/K — vercel.json cron configuration.
// ===========================================================================

describe("vercel.json cron configuration", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string; schedule: string }[] };

  it("I. the existing notification worker cron remains exactly unchanged", () => {
    const entries = (config.crons ?? []).filter((c) => c.path === "/api/internal/notifications/process");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.schedule).toBe("* * * * *");
  });

  it("J. the new retention cron exists exactly once", () => {
    const entries = (config.crons ?? []).filter(
      (c) => c.path === "/api/internal/notifications/purge-display-snapshots",
    );
    expect(entries).toHaveLength(1);
  });

  it("K. the retention cron schedule is exactly '17 * * * *'", () => {
    const entry = (config.crons ?? []).find((c) => c.path === "/api/internal/notifications/purge-display-snapshots");
    expect(entry?.schedule).toBe("17 * * * *");
  });

  it("no other vercel.json cron entries exist", () => {
    expect(config.crons).toHaveLength(2);
  });
});

// ===========================================================================
// L — the two internal notification endpoints remain fully isolated.
// ===========================================================================

describe("isolation from the notification delivery worker", () => {
  // Checks actual import/call SHAPES, not bare substring presence — each
  // route's own header comment legitimately names the other function by
  // way of explaining that it's never used, which a blunt substring match
  // would misfire on.
  it("L. neither endpoint's source imports or calls the other's RPC/worker function", () => {
    const workerSource = readFileSync("app/api/internal/notifications/process/route.ts", "utf8");
    const purgeSource = readFileSync(ROUTE_PATH, "utf8");

    expect(workerSource).not.toMatch(/\.rpc\(\s*["']purge_expired_notification_event_display_snapshots["']/);

    expect(purgeSource).not.toMatch(/from\s*["']@\/lib\/modules\/notifications\/delivery-worker["']/);
    expect(purgeSource).not.toMatch(/processNotificationDeliveryBatch\s*\(/);
  });
});

// ===========================================================================
// Runtime/caching contract — same structural-check convention as
// tests/notification-worker-endpoint.test.ts's own "I" section.
// ===========================================================================

describe("route runtime/caching contract", () => {
  const source = readFileSync(ROUTE_PATH, "utf8");

  it("declares the Node.js runtime explicitly", () => {
    expect(source).toMatch(/export const runtime\s*=\s*["']nodejs["']/);
  });

  it("declares force-dynamic + revalidate 0 so a cron invocation is never served a cached response", () => {
    expect(source).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
    expect(source).toMatch(/export const revalidate\s*=\s*0/);
  });

  it("is server-only (imports the server-only guard)", () => {
    expect(source.trimStart().startsWith('import "server-only";')).toBe(true);
  });
});

// ===========================================================================
// D — real DEV fixture: only expired snapshots are removed, a younger
// one survives.
// ===========================================================================

describe("D — real eligible work", () => {
  let tenant: TestTenant;
  let owner: TestUser;
  let appointmentId: string;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    owner = await createTestUser("notif2f3-owner");
    const tenantRow = await createTestTenant("notif2f3-purge", owner.id);
    tenant = { id: tenantRow.id, slug: tenantRow.slug, ownerRoleId: tenantRow.ownerRoleId };
    cleanupUserIds.push(owner.id);

    const branchId = await createBranch(tenant.id, "NOTIF.2F.3 Branch");
    const customer = await createCustomer(tenant.id, "NOTIF.2F.3 Customer");
    const [appointment] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, created_by, status)
      values (${tenant.id}, ${branchId}, ${customer.id}, 'internal', now() + interval '1 day', now() + interval '1 day 30 minutes', ${owner.id}, 'scheduled')
      returning id
    `;
    if (!appointment) throw new Error("failed to create test appointment");
    appointmentId = appointment.id;
  }, 60000);

  afterAll(async () => {
    await cleanupTenants([tenant.id]);
    await cleanupUsers(cleanupUserIds);
  }, 60000);

  async function insertEventWithSnapshot(createdAt: Date): Promise<string> {
    const [row] = await testDb<{ id: string }[]>`
      insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data)
      values (${tenant.id}, ${appointmentId}, 'appointment.created', ${owner.id}, ${testDb.json({})})
      returning id
    `;
    if (!row) throw new Error("failed to insert test notification_events row");
    await testDb`
      insert into notification_event_display_snapshots
        (event_id, tenant_id, customer_name, service_names, appointment_start_at, tenant_timezone, created_at)
      values (
        ${row.id}, ${tenant.id}, 'Test Customer', ${testDb.array(["Test Service"])},
        ${new Date().toISOString()}, 'UTC', ${createdAt.toISOString()}
      )
    `;
    return row.id;
  }
  async function snapshotExists(eventId: string): Promise<boolean> {
    const rows = await testDb<{ event_id: string }[]>`
      select event_id from notification_event_display_snapshots where event_id = ${eventId}
    `;
    return rows.length > 0;
  }

  it("D. correct auth + expired fixture -> the real RPC is invoked, only the expired snapshot is removed", async () => {
    const expiredEventId = await insertEventWithSnapshot(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    const freshEventId = await insertEventWithSnapshot(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));

    const GET = await loadRouteGET();
    const response = await GET(cronRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.purged).toBeGreaterThanOrEqual(1);

    expect(await snapshotExists(expiredEventId)).toBe(false);
    expect(await snapshotExists(freshEventId)).toBe(true);
  });
});
