import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Faz PERF.2 — contract tests for lib/auth/session.ts's hasPermission,
 * written the day it was wrapped in React's cache() to deduplicate
 * identical (tenantId, permissionKey) checks within one request (PERF.1
 * found the tenant-app layout and every page below it independently
 * re-checking overlapping permission keys, each an un-deduplicated RPC
 * round trip).
 *
 * WHAT THIS FILE DOES NOT AND CANNOT PROVE, AND WHY:
 * React's cache() only memoizes within a request-scoped store that
 * Next.js's own server runtime sets up via an internal AsyncLocalStorage
 * equivalent when it renders a Server Component tree — nothing else
 * provides that scope. Verified directly against this project's exact
 * installed react@19.2.8 before writing this file: calling a
 * cache()-wrapped function repeatedly with identical arguments, with no
 * such scope active (i.e. anywhere outside Next's own request handling —
 * including here, under Vitest), does not deduplicate at all; every call
 * re-runs the wrapped function. So no automated test in this project's
 * current infrastructure (real-DB integration tests only — no
 * component-rendering environment, no mocking framework in use anywhere
 * else — see reports-staff-page.test.ts's own header comment for the
 * same conclusion reached about jsdom/@testing-library) can exercise the
 * actual deduplication. That behavior is instead proven by construction:
 * hasPermission is now wrapped identically to getCurrentUser/
 * getTenantAccess/isPlatformAdmin in the same file, a pattern already
 * running in production for this whole engagement.
 *
 * WHAT THIS FILE DOES PROVE: the function's input/output CONTRACT is
 * byte-for-byte unchanged by adding the wrapper — same RPC name, same
 * argument shape, same tenantId/permissionKey threading (no
 * cross-contamination between calls for different tenants or
 * permission keys), same true/false mapping, same fail-closed behavior
 * on an RPC error. This requires stubbing @/lib/supabase/server's
 * createClient (the only way to reach hasPermission's body at all
 * without a real Next.js request — it calls next/headers's cookies()
 * internally, which throws outside one). vi.mock is a built-in Vitest
 * feature, not a new dependency; this is the only test in the suite
 * that uses it, scoped narrowly to this one contract.
 */

const rpcMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: rpcMock }),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

async function loadHasPermission() {
  const mod = await import("@/lib/auth/session");
  return mod.hasPermission;
}

describe("hasPermission contract (Faz PERF.2 cache() wrap)", () => {
  it("calls the has_permission RPC with the exact tenant/permission args it was given", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    const hasPermission = await loadHasPermission();

    const result = await hasPermission("tenant-1", "staff.view");

    expect(result).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("has_permission", {
      p_tenant_id: "tenant-1",
      p_permission_key: "staff.view",
    });
  });

  it("threads a different permission key independently — no cross-contamination", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    const hasPermission = await loadHasPermission();

    await hasPermission("tenant-1", "staff.view");
    await hasPermission("tenant-1", "settings.manage");

    expect(rpcMock).toHaveBeenNthCalledWith(1, "has_permission", {
      p_tenant_id: "tenant-1",
      p_permission_key: "staff.view",
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "has_permission", {
      p_tenant_id: "tenant-1",
      p_permission_key: "settings.manage",
    });
  });

  it("threads a different tenant id independently — no cross-contamination", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    const hasPermission = await loadHasPermission();

    await hasPermission("tenant-1", "staff.view");
    await hasPermission("tenant-2", "staff.view");

    expect(rpcMock).toHaveBeenNthCalledWith(1, "has_permission", {
      p_tenant_id: "tenant-1",
      p_permission_key: "staff.view",
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "has_permission", {
      p_tenant_id: "tenant-2",
      p_permission_key: "staff.view",
    });
  });

  it("fails closed (false) when the RPC returns an error — unauthorized behavior unchanged", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const hasPermission = await loadHasPermission();

    expect(await hasPermission("tenant-1", "staff.view")).toBe(false);
  });

  it("returns false for any non-true data value, not just explicit false", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const hasPermission = await loadHasPermission();

    expect(await hasPermission("tenant-1", "staff.view")).toBe(false);
  });
});
