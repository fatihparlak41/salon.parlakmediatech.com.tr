import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkDependencies,
  DEPENDENCY_CACHE_TTL_MS,
  releaseId,
  resetDependencyHealthCache,
} from "@/lib/ops/dependency-health";
import { GET as liveness } from "@/app/api/health/route";
import { GET as dependencies } from "@/app/api/health/dependencies/route";

/**
 * Faz OPS.1A — the health endpoints. No database: every Supabase answer is injected, and the routes are called as
 * plain functions. What matters here is (1) the outage signal is right, (2) the public answer carries no internals,
 * (3) a flood of probes cannot become database load.
 */

const SECRET_URL = "https://abcdefghijklmnopqrst.supabase.co";
const SECRET_KEY = "sb_publishable_SECRETKEYVALUE1234567890";

function respond(status: number): Response {
  return new Response("{}", { status });
}

beforeEach(() => resetDependencyHealthCache());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkDependencies — the outage signal", () => {
  const base = { supabaseUrl: SECRET_URL, publishableKey: SECRET_KEY };

  it("healthy when Auth answers 200 and PostgREST answers (even with a 4xx permission answer)", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => (String(url).includes("/auth/v1/health") ? respond(200) : respond(401)));
    const result = await checkDependencies({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ status: "healthy", checks: { auth: "ok", database: "ok" } });
  });

  it("degraded when PostgREST cannot reach the database (503) — only the database component fails", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => (String(url).includes("/auth/v1/health") ? respond(200) : respond(503)));
    const result = await checkDependencies({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ status: "degraded", checks: { auth: "ok", database: "fail" } });
  });

  it("degraded when Auth is down (502) — only the auth component fails", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => (String(url).includes("/auth/v1/health") ? respond(502) : respond(200)));
    const result = await checkDependencies({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ status: "degraded", checks: { auth: "fail", database: "ok" } });
  });

  it("a network error or a timeout is a failure, never a thrown error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET to db-internal-host:5432 with key sb_secret_LEAK");
    });
    const result = await checkDependencies({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ status: "degraded", checks: { auth: "fail", database: "fail" } });
    expect(JSON.stringify(result)).not.toMatch(/ECONNRESET|db-internal|sb_secret/);
  });

  it("missing configuration degrades without calling out at all", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const fetchFn = vi.fn();
    const result = await checkDependencies({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(result.status).toBe("degraded");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses only the publishable key and read-only GETs (never a service-role credential)", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-must-never-be-sent");
    const fetchFn = vi.fn(async () => respond(200));
    await checkDependencies({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchFn.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.method).toBe("GET");
      expect(JSON.stringify(init.headers)).toContain(SECRET_KEY);
      expect(JSON.stringify(init.headers)).not.toContain("service-role-must-never-be-sent");
    }
  });
});

describe("checkDependencies — bounded load", () => {
  it("concurrent probes share ONE check, and the result is cached for the TTL", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return respond(200);
    });
    let clock = 1_000_000;
    const deps = { supabaseUrl: SECRET_URL, publishableKey: SECRET_KEY, fetchFn: fetchFn as unknown as typeof fetch, now: () => clock };

    await Promise.all(Array.from({ length: 50 }, () => checkDependencies(deps)));
    expect(calls).toBe(2); // one auth + one database request for 50 simultaneous probes

    clock += DEPENDENCY_CACHE_TTL_MS - 1;
    await checkDependencies(deps);
    expect(calls).toBe(2); // still cached

    clock += 2;
    await checkDependencies(deps);
    expect(calls).toBe(4); // expired -> exactly one more pair
  });
});

describe("the public routes", () => {
  it("/api/health is liveness only: ok, release id, timestamp, no dependency, no-store", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret-value");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SECRET_URL);
    const response = liveness();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["release", "status", "time"]);
    expect(body.status).toBe("ok");
    expect(body.release).toBe("0123456");
    expect(text).not.toContain("service-role-secret-value");
    expect(text).not.toContain("supabase.co");
  });

  it("/api/health/dependencies answers 200 healthy and 503 degraded, with component flags only", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SECRET_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", SECRET_KEY);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret-value");
    vi.stubEnv("TEST_DATABASE_URL", "postgres://u:p@db-host/db");

    vi.stubGlobal("fetch", vi.fn(async () => respond(200)));
    let response = await dependencies();
    expect(response.status).toBe(200);
    let text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ status: "healthy", checks: { auth: "ok", database: "ok" } });

    resetDependencyHealthCache();
    vi.stubGlobal("fetch", vi.fn(async () => respond(503)));
    response = await dependencies();
    expect(response.status).toBe(503);
    text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ status: "degraded", checks: { auth: "fail", database: "fail" } });
    for (const forbidden of [SECRET_URL, "abcdefghijklmnopqrst", SECRET_KEY, "service-role-secret-value", "db-host", "stack", "Error"]) {
      expect(text).not.toContain(forbidden);
    }
    vi.unstubAllGlobals();
  });

  it("releaseId is a 7-character prefix or 'local' — never a full environment dump", () => {
    expect(releaseId({ VERCEL_GIT_COMMIT_SHA: "abcdef1234567890" })).toBe("abcdef1");
    expect(releaseId({})).toBe("local");
  });
});
