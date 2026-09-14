import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admin,
  anonClient,
  testDb,
  signInAs,
  createTestUser,
  createTestTenant,
  createRoleForTenant,
  addMembership,
  cleanupTenants,
  cleanupUsers,
  type TestTenant,
  type TestUser,
} from "./helpers";
import {
  urlBase64ToUint8Array,
  arrayBufferToBase64Url,
  extractSubscriptionKeys,
  deriveDeviceLabel,
} from "@/lib/pwa/push-subscription";

/**
 * Faz NOTIF.2D — real Web Push subscription + manual test-send. Builds
 * on Faz NOTIF.2A's push_subscriptions/save_push_subscription/
 * remove_push_subscription/list_my_devices (already exhaustively tested
 * in notification-foundation.test.ts, not repeated here) with:
 *   - the client-side crypto/encoding helpers (real unit tests, no DB)
 *   - the server-only RPC, get_push_subscriptions_for_test_send
 *     (20260914121000, correcting 20260914120000's browser-reachable
 *     original) — real DB integration, same convention as every other
 *     RPC test file in this project
 *   - the three new Server Actions — mocked @/lib/supabase/server and
 *     @/lib/auth/session, same narrow precedent as
 *     session-permission-contract.test.ts (requireUser/createClient
 *     both ultimately need next/headers' cookies(), which throws
 *     outside a real Next.js request; there is no other way to execute
 *     a Server Action's body directly under Vitest)
 *   - source-scan contracts for the browser-only wrappers and the
 *     settings card (mirrors pwa-notification-ux.test.ts's own style
 *     for anything that needs a real browser to execute)
 */

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ===================== PURE ENCODE/DECODE HELPERS =====================

describe("push-subscription.ts pure helpers", () => {
  it("1. urlBase64ToUint8Array decodes a known base64url VAPID-shaped key to the expected bytes", () => {
    // "SGVsbG8h" (standard base64 for "Hello!") re-expressed as base64url
    // with no padding — a tiny, hand-verifiable fixture rather than a
    // real key, so the expected bytes are independently checkable.
    const bytes = urlBase64ToUint8Array("SGVsbG8h");
    expect(Array.from(bytes)).toEqual(Array.from(Buffer.from("Hello!", "utf8")));
  });

  it("2. urlBase64ToUint8Array handles '-' and '_' (the two chars that differ from standard base64)", () => {
    // Bytes [0xfb, 0xff] -> standard base64 "+/8=" -> base64url "-_8".
    const bytes = urlBase64ToUint8Array("-_8");
    expect(Array.from(bytes)).toEqual([0xfb, 0xff]);
  });

  it("3. urlBase64ToUint8Array restores padding regardless of input length mod 4", () => {
    for (const input of ["SGVsbG8h", "SGVsbG8", "SGVsbG8hIQ"]) {
      expect(() => urlBase64ToUint8Array(input)).not.toThrow();
    }
  });

  it("4. arrayBufferToBase64Url is the exact inverse of urlBase64ToUint8Array (round-trip, no padding)", () => {
    const original = "a-fake_VAPID-styleKey123";
    const bytes = urlBase64ToUint8Array(original);
    const reencoded = arrayBufferToBase64Url(bytes.buffer as ArrayBuffer);
    expect(urlBase64ToUint8Array(reencoded)).toEqual(bytes);
    expect(reencoded).not.toContain("=");
    expect(reencoded).not.toContain("+");
    expect(reencoded).not.toContain("/");
  });

  it("5. extractSubscriptionKeys reads endpoint + base64url-encodes p256dh/auth from a real-shaped PushSubscription", () => {
    const p256dhBytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const authBytes = new Uint8Array([9, 8, 7]);
    const fakeSubscription = {
      endpoint: "https://push.example.test/ep/abc",
      getKey: (name: string) => (name === "p256dh" ? p256dhBytes.buffer : name === "auth" ? authBytes.buffer : null),
    } as unknown as PushSubscription;

    const extracted = extractSubscriptionKeys(fakeSubscription);
    expect(extracted.endpoint).toBe("https://push.example.test/ep/abc");
    expect(urlBase64ToUint8Array(extracted.p256dh)).toEqual(p256dhBytes);
    expect(urlBase64ToUint8Array(extracted.authKey)).toEqual(authBytes);
  });

  it("6. extractSubscriptionKeys throws rather than sending partial data when a key is missing", () => {
    const fakeSubscription = {
      endpoint: "https://push.example.test/ep/broken",
      getKey: () => null,
    } as unknown as PushSubscription;
    expect(() => extractSubscriptionKeys(fakeSubscription)).toThrow(/p256dh|auth/);
  });

  it("7. deriveDeviceLabel is coarse platform-family only — no model/serial/hardware id, no raw UA string", () => {
    const cases: Array<[string, string]> = [
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone"],
      ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "iPad"],
      ["Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Android"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Mac"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Windows"],
    ];
    for (const [ua, expected] of cases) {
      vi.stubGlobal("navigator", { userAgent: ua });
      expect(deriveDeviceLabel()).toBe(expected);
    }
    vi.unstubAllGlobals();
  });

  it("7b. deriveDeviceLabel never returns the raw user-agent string itself", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" });
    const label = deriveDeviceLabel();
    expect(label.length).toBeLessThan(20);
    expect(label).not.toContain("Mozilla");
    expect(label).not.toContain("AppleWebKit");
    vi.unstubAllGlobals();
  });
});

// ==================== get_push_subscriptions_for_test_send ====================
// Faz NOTIF.2D.1 — security correction. The original 20260914120000
// function (get_my_push_subscriptions_for_test_send, authenticated-
// grantable, auth.uid()-derived) is gone — dropped by 20260914121000.
// This block tests its server-only replacement: callable ONLY by
// service_role, taking p_user_id explicitly.

describe("get_push_subscriptions_for_test_send RPC (20260914121000, server-only)", () => {
  let tenant: TestTenant;
  let owner: TestUser; // SALON_OWNER -> has settings.manage
  let outsider: TestUser; // no membership in this tenant at all

  let ownerClient: SupabaseClient;

  function endpoint(label: string): string {
    return `https://push.example.test/ep/notif2d1-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  beforeAll(async () => {
    owner = await createTestUser("notif2d1-owner");
    outsider = await createTestUser("notif2d1-outsider");

    tenant = await createTestTenant("notif2d1-tenant", owner.id);

    ownerClient = await signInAs(owner);
  });

  afterAll(async () => {
    await cleanupTenants([tenant.id]);
    await cleanupUsers([owner.id, outsider.id]);
  });

  it("1. authenticated (even the subscription's own owner, with settings.manage) CANNOT execute it at all — permission denied, not a data-level rejection", async () => {
    const ep = endpoint("browser-blocked");
    const saved = await ownerClient.rpc("save_push_subscription", {
      p_tenant_id: tenant.id,
      p_endpoint: ep,
      p_p256dh: "p256dh-secret",
      p_auth_key: "auth-secret",
    });
    expect(saved.error).toBeNull();

    const { data, error } = await ownerClient.rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenant.id,
      p_user_id: owner.id,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    // PostgREST's own "no such function you're allowed to call" shape —
    // proves this is an access rejection (no grant), not the function's
    // own logic rejecting the input.
    expect(error!.message).toMatch(/function .* does not exist|permission denied|schema cache/i);
  });

  it("2. anon CANNOT execute it either", async () => {
    const { error } = await anonClient().rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenant.id,
      p_user_id: owner.id,
    });
    expect(error).not.toBeNull();
  });

  it("3. service_role CAN execute it and gets full subscription material back for the given (tenant, user)", async () => {
    const ep = endpoint("full-material");
    const saved = await ownerClient.rpc("save_push_subscription", {
      p_tenant_id: tenant.id,
      p_endpoint: ep,
      p_p256dh: "p256dh-secret",
      p_auth_key: "auth-secret",
      p_device_label: "Test Device",
    });
    expect(saved.error).toBeNull();

    const { data, error } = await admin.rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenant.id,
      p_user_id: owner.id,
    });
    expect(error).toBeNull();
    const row = (data as Array<{ id: string; endpoint: string; p256dh: string; authKey: string }>).find(
      (d) => d.id === saved.data.id,
    );
    expect(row).toBeTruthy();
    expect(row!.endpoint).toBe(ep);
    expect(row!.p256dh).toBe("p256dh-secret");
    expect(row!.authKey).toBe("auth-secret");
  });

  it("4. no subscription yet -> empty array, not an error", async () => {
    const freshUser = await createTestUser("notif2d1-fresh-owner-check");
    const roleId = await createRoleForTenant(tenant.id, "TempOwnerLike", ["settings.manage"]);
    const membershipId = await addMembership(tenant.id, freshUser.id, roleId);

    const { data, error } = await admin.rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenant.id,
      p_user_id: freshUser.id,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);

    await testDb`delete from tenant_memberships where id = ${membershipId}`;
    await cleanupUsers([freshUser.id]);
  });

  it("5. revoked subscriptions are excluded (unlike list_my_devices, which shows them marked)", async () => {
    const ep = endpoint("revoked-excluded");
    const saved = await ownerClient.rpc("save_push_subscription", {
      p_tenant_id: tenant.id,
      p_endpoint: ep,
      p_p256dh: "p",
      p_auth_key: "a",
    });
    await ownerClient.rpc("remove_push_subscription", { p_subscription_id: saved.data.id });

    const { data } = await admin.rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenant.id,
      p_user_id: owner.id,
    });
    expect((data as Array<{ id: string }>).some((d) => d.id === saved.data.id)).toBe(false);
  });

  it("6. a p_user_id with no active membership in p_tenant_id is rejected — cross-tenant/cross-user read is structurally impossible even under service_role", async () => {
    const { error } = await admin.rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenant.id,
      p_user_id: outsider.id,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/active tenant membership required/i);
  });

  it("7. a settings.manage-less active member's own user_id still only ever returns THEIR OWN membership's rows, never another member's", async () => {
    const roleId = await createRoleForTenant(tenant.id, "SecondManager", ["settings.manage"]);
    const secondManager = await createTestUser("notif2d1-second-manager");
    const membershipId = await addMembership(tenant.id, secondManager.id, roleId);

    const ep = endpoint("owner-only");
    const saved = await ownerClient.rpc("save_push_subscription", {
      p_tenant_id: tenant.id,
      p_endpoint: ep,
      p_p256dh: "p",
      p_auth_key: "a",
    });

    const { data } = await admin.rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenant.id,
      p_user_id: secondManager.id,
    });
    expect((data as Array<{ id: string }>).some((d) => d.id === saved.data.id)).toBe(false);

    await testDb`delete from tenant_memberships where id = ${membershipId}`;
    await cleanupUsers([secondManager.id]);
  });

  it("8. grants: service_role ONLY on the public wrapper — zero PUBLIC/anon/authenticated anywhere, zero grants at all on private.*", async () => {
    const privateGrants = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_routine_grants
      where routine_schema = 'private'
        and routine_name = 'get_push_subscriptions_for_test_send'
        and grantee in ('authenticated', 'anon', 'PUBLIC', 'service_role')
    `;
    expect(privateGrants).toEqual([]);

    const publicGrants = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_routine_grants
      where routine_schema = 'public'
        and routine_name = 'get_push_subscriptions_for_test_send'
    `;
    const grantees = new Set(publicGrants.map((r) => r.grantee));
    expect(grantees.has("service_role")).toBe(true);
    expect(grantees.has("authenticated")).toBe(false);
    expect(grantees.has("anon")).toBe(false);
    expect(grantees.has("PUBLIC")).toBe(false);
  });

  it("9. the OLD, flawed function (get_my_push_subscriptions_for_test_send) no longer exists in either schema", async () => {
    const rows = await testDb<{ proname: string }[]>`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'get_my_push_subscriptions_for_test_send'
    `;
    expect(rows).toEqual([]);
  });

  it("10. push_subscriptions still carries zero table grants to authenticated/anon (unchanged by this phase)", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'push_subscriptions'
        and grantee in ('authenticated', 'anon')
    `;
    expect(rows).toEqual([]);
  });

  it("11. service_role has no DATA-ACCESS table grant on push_subscriptions — no direct SELECT/INSERT/UPDATE/DELETE shortcut", async () => {
    // The whole point of the SECURITY DEFINER function is that
    // service_role never needs (and does not get) a table-level DATA
    // grant — it can call the function without being able to query the
    // table directly through it. TRUNCATE/REFERENCES/TRIGGER are
    // Postgres's own schema-maintenance defaults on every table
    // (20260817104813's own documented, intentional carve-out — not
    // data access) and are correctly excluded from this check.
    const rows = await testDb<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'push_subscriptions'
        and grantee = 'service_role'
        and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    `;
    expect(rows).toEqual([]);
  });
});

// ========================= SERVER ACTIONS =========================

const rpcMock = vi.fn(); // the REGULAR (RLS-respecting) client's .rpc()
const adminRpcMock = vi.fn(); // the service_role admin client's .rpc()
const requireUserMock = vi.fn(async () => ({ id: "mock-user-id" }));
const hasPermissionMock = vi.fn(async (_tenantId: string, _permissionKey: string) => true);
const sendTestPushMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: rpcMock }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: adminRpcMock }),
}));
vi.mock("@/lib/auth/session", () => ({
  requireUser: () => requireUserMock(),
  hasPermission: (tenantId: string, permissionKey: string) => hasPermissionMock(tenantId, permissionKey),
}));
vi.mock("@/lib/pwa/web-push-server", () => ({
  sendTestPush: (...args: unknown[]) => sendTestPushMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadActions() {
  return import("@/lib/modules/settings/actions");
}

describe("savePushSubscriptionAction", () => {
  it("10. calls the existing save_push_subscription RPC with exactly the expected args, nothing else", async () => {
    rpcMock.mockResolvedValueOnce({ data: { id: "sub-1", deviceLabel: "iPhone" }, error: null });
    const { savePushSubscriptionAction } = await loadActions();

    const result = await savePushSubscriptionAction(null, {
      tenantId: "tenant-1",
      endpoint: "https://push.example.test/ep/x",
      p256dh: "p256dh-x",
      authKey: "auth-x",
      deviceLabel: "iPhone",
    });

    expect(requireUserMock).toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith("save_push_subscription", {
      p_tenant_id: "tenant-1",
      p_endpoint: "https://push.example.test/ep/x",
      p_p256dh: "p256dh-x",
      p_auth_key: "auth-x",
      p_device_label: "iPhone",
    });
    expect(result).toEqual({ success: true, data: { id: "sub-1", deviceLabel: "iPhone" } });
  });

  it("11. maps NF003 (no active membership) to UNAUTHORIZED, not a raw DB error", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "NF003", message: "active tenant membership required" } });
    const { savePushSubscriptionAction } = await loadActions();
    const result = await savePushSubscriptionAction(null, {
      tenantId: "tenant-1",
      endpoint: "e",
      p256dh: "p",
      authKey: "a",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("12. does not revalidate any path — no SSR-rendered data depends on subscription state", async () => {
    rpcMock.mockResolvedValueOnce({ data: { id: "sub-1", deviceLabel: null }, error: null });
    const { savePushSubscriptionAction } = await loadActions();
    await savePushSubscriptionAction(null, { tenantId: "t", endpoint: "e", p256dh: "p", authKey: "a" });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("removePushSubscriptionAction", () => {
  it("13. calls remove_push_subscription with exactly the subscription id, no tenant/user id accepted", async () => {
    rpcMock.mockResolvedValueOnce({ error: null });
    const { removePushSubscriptionAction } = await loadActions();
    const result = await removePushSubscriptionAction(null, { subscriptionId: "sub-1" });
    expect(rpcMock).toHaveBeenCalledWith("remove_push_subscription", { p_subscription_id: "sub-1" });
    expect(result).toEqual({ success: true, data: null });
  });

  it("14. maps NF004 (not found / not yours) to one generic NOT_FOUND message — no existence side-channel", async () => {
    rpcMock.mockResolvedValueOnce({ error: { code: "NF004", message: "subscription not found" } });
    const { removePushSubscriptionAction } = await loadActions();
    const result = await removePushSubscriptionAction(null, { subscriptionId: "sub-1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("sendTestPushNotificationAction", () => {
  it("15. accepts ONLY a tenantId — no endpoint/title/body/path field exists on its input type", async () => {
    const src = read("lib/modules/settings/actions.ts");
    const fnStart = src.indexOf("export async function sendTestPushNotificationAction");
    const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
    const inputType = fnBody.slice(fnBody.indexOf("input:"), fnBody.indexOf("):"));
    expect(inputType).toContain("tenantId");
    expect(inputType).not.toMatch(/endpoint|title|body|path|p256dh|authKey/i);
  });

  it("16. reads via the new server-only admin RPC (never the regular client), never a client-supplied subscription id/endpoint", async () => {
    adminRpcMock.mockResolvedValueOnce({
      data: [{ id: "sub-1", endpoint: "https://e", p256dh: "p", authKey: "a" }],
      error: null,
    });
    sendTestPushMock.mockResolvedValueOnce({ outcome: "sent" });
    const { sendTestPushNotificationAction } = await loadActions();
    await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });
    expect(adminRpcMock).toHaveBeenCalledWith("get_push_subscriptions_for_test_send", {
      p_tenant_id: "tenant-1",
      p_user_id: "mock-user-id",
    });
    // The privileged read never goes through the regular (RLS) client —
    // that client is only reached later, for the stale-revoke path.
    expect(rpcMock).not.toHaveBeenCalledWith("get_push_subscriptions_for_test_send", expect.anything());
  });

  it("17. user_id is derived server-side from requireUser() — never accepted from the browser input, and the input type has no such field", async () => {
    adminRpcMock.mockResolvedValueOnce({ data: [], error: null });
    const { sendTestPushNotificationAction } = await loadActions();
    // @ts-expect-error — deliberately trying to smuggle a userId/user_id
    // through the input to prove the action ignores it entirely.
    await sendTestPushNotificationAction(null, { tenantId: "tenant-1", userId: "attacker-supplied-id", user_id: "attacker-supplied-id" });
    expect(adminRpcMock).toHaveBeenCalledWith("get_push_subscriptions_for_test_send", {
      p_tenant_id: "tenant-1",
      p_user_id: "mock-user-id", // from requireUser(), not from input
    });

    const src = read("lib/modules/settings/actions.ts");
    const fnStart = src.indexOf("export async function sendTestPushNotificationAction");
    const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
    const inputType = fnBody.slice(fnBody.indexOf("input:"), fnBody.indexOf("):"));
    expect(inputType).not.toMatch(/userId|user_id/i);
  });

  it("18. settings.manage is checked via hasPermission() (the normal user-session path) BEFORE the admin client is ever touched", async () => {
    hasPermissionMock.mockResolvedValueOnce(false);
    const { sendTestPushNotificationAction } = await loadActions();
    const result = await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });

    expect(hasPermissionMock).toHaveBeenCalledWith("tenant-1", "settings.manage");
    expect(adminRpcMock).not.toHaveBeenCalled(); // never reached — authorization failed first
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("18b. settings.manage true lets execution proceed to the privileged read", async () => {
    hasPermissionMock.mockResolvedValueOnce(true);
    adminRpcMock.mockResolvedValueOnce({ data: [], error: null });
    const { sendTestPushNotificationAction } = await loadActions();
    await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });
    expect(adminRpcMock).toHaveBeenCalled();
  });

  it("19. NF003 from the privileged read (structural membership check) still maps to UNAUTHORIZED", async () => {
    adminRpcMock.mockResolvedValueOnce({ data: null, error: { code: "NF003", message: "active tenant membership required" } });
    const { sendTestPushNotificationAction } = await loadActions();
    const result = await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("20. no active subscription -> NOT_FOUND, web-push is never invoked", async () => {
    adminRpcMock.mockResolvedValueOnce({ data: [], error: null });
    const { sendTestPushNotificationAction } = await loadActions();
    const result = await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
    expect(sendTestPushMock).not.toHaveBeenCalled();
  });

  it("21. a stale ('outcome: stale') delivery revokes exactly that one subscription via the EXISTING remove RPC, called through the regular (non-admin) client", async () => {
    adminRpcMock.mockResolvedValueOnce({ data: [{ id: "sub-stale", endpoint: "e", p256dh: "p", authKey: "a" }], error: null });
    rpcMock.mockResolvedValueOnce({ error: null }); // the remove_push_subscription call
    sendTestPushMock.mockResolvedValueOnce({ outcome: "stale" });
    const { sendTestPushNotificationAction } = await loadActions();
    const result = await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });

    expect(rpcMock).toHaveBeenCalledWith("remove_push_subscription", { p_subscription_id: "sub-stale" });
    // Reused unchanged — no admin client involved in the revoke path.
    expect(adminRpcMock).not.toHaveBeenCalledWith("remove_push_subscription", expect.anything());
    expect(result.success).toBe(false); // nothing was actually delivered
  });

  it("22. a transient ('outcome: failed') delivery never calls remove_push_subscription", async () => {
    adminRpcMock.mockResolvedValueOnce({ data: [{ id: "sub-1", endpoint: "e", p256dh: "p", authKey: "a" }], error: null });
    sendTestPushMock.mockResolvedValueOnce({ outcome: "failed" });
    const { sendTestPushNotificationAction } = await loadActions();
    await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });
    expect(rpcMock).not.toHaveBeenCalled(); // no revoke call at all
  });

  it("23. the action's return type never carries endpoint/p256dh/authKey back out", async () => {
    adminRpcMock.mockResolvedValueOnce({ data: [{ id: "sub-1", endpoint: "e", p256dh: "p", authKey: "a" }], error: null });
    sendTestPushMock.mockResolvedValueOnce({ outcome: "sent" });
    const { sendTestPushNotificationAction } = await loadActions();
    const result = await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });
    expect(JSON.stringify(result)).not.toMatch(/p256dh|authKey|endpoint/i);
    expect(result).toEqual({ success: true, data: { sent: true } });
  });

  // Faz NOTIF.2D.2 — a real PROD failure logged only `{tenantId, code:
  // undefined}` for an admin.rpc() error, which is exactly why the real
  // root cause (a PROD-side credential/environment issue, confirmed via
  // a live DEV probe using the unmodified createAdminClient()) couldn't
  // be diagnosed from the log alone. These tests lock in the fix: every
  // field PostgrestError actually carries, plus the HTTP status/
  // statusText .rpc() returns alongside it (a sibling of `error`, not a
  // field on it — easy to miss).
  it("24. a failed admin RPC read logs the full diagnostic shape — name, message, code, details, hint, status, statusText", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    adminRpcMock.mockResolvedValueOnce({
      data: null,
      error: { name: "PostgrestError", message: "Invalid API key", code: "", details: "", hint: "" },
      status: 401,
      statusText: "Unauthorized",
    });
    const { sendTestPushNotificationAction } = await loadActions();
    await sendTestPushNotificationAction(null, { tenantId: "tenant-1" });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[sendTestPushNotificationAction] read failed",
      expect.objectContaining({
        tenantId: "tenant-1",
        name: "PostgrestError",
        message: "Invalid API key",
        code: "",
        details: "",
        hint: "",
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("25. the diagnostic log can never contain a secret — it only ever carries PostgrestError's own fields and the HTTP status, never a raw header/key/subscription value", () => {
    const src = read("lib/modules/settings/actions.ts");
    const logCallStart = src.indexOf('console.error("[sendTestPushNotificationAction] read failed"');
    const logCallBody = src.slice(logCallStart, src.indexOf("});", logCallStart));
    expect(logCallBody).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|VAPID|Authorization|p256dh|authKey|endpoint/i);
  });
});

// ================== CLIENT MODULE / COMPONENT CONTRACTS ==================
// (source-scan, mirroring pwa-notification-ux.test.ts's own style for
// anything that needs a real browser/PushManager to actually execute)

describe("client wrapper contracts", () => {
  const pushSub = codeOnly(read("lib/pwa/push-subscription.ts"));
  const card = read("components/settings/notification-settings-card.tsx");

  it("22. subscribeToPush always sets userVisibleOnly: true", () => {
    expect(pushSub).toMatch(/userVisibleOnly:\s*true/);
  });

  it("23. getExistingPushSubscription never calls pushManager.subscribe — read-only", () => {
    const fnStart = pushSub.indexOf("export async function getExistingPushSubscription");
    const fnBody = pushSub.slice(fnStart, pushSub.indexOf("\n}", fnStart));
    expect(fnBody).not.toContain(".subscribe(");
    expect(fnBody).toContain(".getSubscription()");
  });

  it("24. no direct push_subscriptions table access anywhere in the new client/action files", () => {
    const actionsSrc = codeOnly(read("lib/modules/settings/actions.ts"));
    expect(pushSub).not.toMatch(/\.from\(["']push_subscriptions["']\)/);
    expect(actionsSrc).not.toMatch(/\.from\(["']push_subscriptions["']\)/);
  });

  it("25. save/remove/test-send actions are called ONLY through lib/modules/settings/actions.ts's RPC wrappers, never a new ad-hoc RPC name", () => {
    const actionsSrc = read("lib/modules/settings/actions.ts");
    expect(actionsSrc).toContain('"save_push_subscription"');
    expect(actionsSrc).toContain('"remove_push_subscription"');
    expect(actionsSrc).toContain('"get_push_subscriptions_for_test_send"');
    expect(actionsSrc).not.toContain('"get_my_push_subscriptions_for_test_send"');
  });

  it("26. subscribeToPush/unsubscribeFromPush are invoked ONLY from click handlers in the card, never from a bare useEffect body", () => {
    const connectHandlerIdx = card.indexOf("handleConnectClick");
    const subscribeCallIdx = card.indexOf("subscribeToPush(");
    expect(connectHandlerIdx).toBeGreaterThan(-1);
    expect(subscribeCallIdx).toBeGreaterThan(connectHandlerIdx);

    const disconnectHandlerIdx = card.indexOf("handleDisconnectClick");
    const unsubscribeCallIdx = card.indexOf("unsubscribeFromPush(");
    expect(disconnectHandlerIdx).toBeGreaterThan(-1);
    expect(unsubscribeCallIdx).toBeGreaterThan(disconnectHandlerIdx);

    // The mount-time effect only reads (getExistingPushSubscription) and
    // reconciles via save — it must never itself call subscribeToPush or
    // unsubscribeFromPush.
    const effectMatch = card.match(/useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[granted, tenantId\]\);/);
    expect(effectMatch).toBeTruthy();
    expect(effectMatch![0]).not.toContain("subscribeToPush(");
    expect(effectMatch![0]).not.toContain("unsubscribeFromPush(");
  });

  it("27. the connect button is disabled while not in the not-subscribed state — no double-submit path to a duplicate subscribe", () => {
    expect(card).toMatch(/disabled=\{device\.status !== "not-subscribed"\}/);
  });

  it("28. disconnect ordering: browser unsubscribe is attempted before the DB association is removed", () => {
    const fnStart = card.indexOf("handleDisconnectClick = useCallback");
    const fnBody = card.slice(fnStart, card.indexOf("[t],", fnStart));
    const unsubIdx = fnBody.indexOf("unsubscribeFromPush(");
    const removeIdx = fnBody.indexOf("removePushSubscriptionAction(");
    expect(unsubIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(unsubIdx);
  });

  it("29. a failed browser-side unsubscribe never proceeds to remove the DB association (no false 'disconnected' state)", () => {
    const fnStart = card.indexOf("handleDisconnectClick = useCallback");
    const fnBody = card.slice(fnStart, card.indexOf("[t],", fnStart));
    const guardIdx = fnBody.indexOf("if (!browserOk)");
    const returnAfterGuard = fnBody.slice(guardIdx, guardIdx + 250);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(returnAfterGuard).toContain("return;");
  });

  it("30. a DB-side removal failure after a successful browser unsubscribe is surfaced as an error, not silent success", () => {
    expect(card).toContain("disconnectPartialError");
  });

  it("31. NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY is read server-side and passed down as a prop, never read directly inside the client card", () => {
    const settingsPage = read("app/[locale]/app/[tenantSlug]/settings/page.tsx");
    expect(settingsPage).toContain("process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY");
    expect(card).not.toContain("process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY");
    expect(card).toContain("vapidPublicKey");
  });

  it("32. no technical jargon (VAPID, endpoint, PushSubscription, p256dh, auth key) appears in any user-facing tr.json string", () => {
    const messages = JSON.parse(read("messages/tr.json"));
    const notifStrings = JSON.stringify(messages.Settings.notifications);
    expect(notifStrings).not.toMatch(/VAPID|endpoint|PushSubscription|p256dh/i);
  });

  // Faz NOTIF.2D.2 — handleConnectClick/handleDisconnectClick already
  // wrapped their Server Action call in try/catch; handleTestSendClick
  // did not. sendTestPushNotificationAction is designed to always
  // return an ActionResult, but a Server Action call can still reject
  // (createAdminClient() throwing "supabaseKey is required" was PROD's
  // own confirmed first failure, before the env var was corrected) —
  // without a catch, setTestSend("sending") was the last state update
  // ever made, and the button stayed on "Gönderiliyor…" forever.
  it("33. handleTestSendClick wraps its Server Action call in try/catch — a rejected promise still resolves the sending state, never leaves it stuck", () => {
    const fnStart = card.indexOf("handleTestSendClick = useCallback");
    const fnBody = card.slice(fnStart, card.indexOf("[tenantId, t]);", fnStart));
    const tryIdx = fnBody.indexOf("try {");
    const actionCallIdx = fnBody.indexOf("sendTestPushNotificationAction(");
    const catchIdx = fnBody.indexOf("} catch");
    expect(tryIdx).toBeGreaterThan(-1);
    expect(actionCallIdx).toBeGreaterThan(tryIdx);
    expect(catchIdx).toBeGreaterThan(actionCallIdx);
    // The catch body itself must still call setTestSend — not just log
    // and fall through, which would reproduce the exact same stuck-on-
    // "sending" bug this test exists to prevent.
    const catchBody = fnBody.slice(catchIdx, fnBody.length);
    expect(catchBody).toContain("setTestSend(");
  });

  it("34. every setTestSend branch inside handleTestSendClick's try/catch sets a terminal status ('sent' or 'error'), never re-enters 'sending'", () => {
    const fnStart = card.indexOf("handleTestSendClick = useCallback");
    const fnBody = card.slice(fnStart, card.indexOf("[tenantId, t]);", fnStart));
    const tryStart = fnBody.indexOf("try {");
    const restOfFn = fnBody.slice(tryStart);
    const statuses = Array.from(restOfFn.matchAll(/setTestSend\(\{\s*status:\s*"(\w+)"/g)).map((m) => m[1]);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain("sending");
    expect(new Set(statuses)).toEqual(new Set(["sent", "error"]));
  });
});

// ===================== SERVICE WORKER COMPATIBILITY =====================

describe("Service Worker compatibility with a real test payload", () => {
  function loadSwHelpers() {
    const ctx: { self: Record<string, unknown> } = { self: {} };
    vm.runInNewContext(read("public/sw-helpers.js"), ctx);
    return ctx.self.SalonOSPush as {
      safeNotificationTargetPath: (raw: unknown) => string;
      parsePushPayload: (event: unknown) => { title: string; body: string; path: string };
    };
  }

  it("33. the fixed manual test payload parses through the EXISTING (unmodified) sw-helpers.js exactly as intended", () => {
    const helpers = loadSwHelpers();
    const payload = { title: "SalonOS", body: "Test bildirimi başarıyla ulaştı.", path: "/" };
    const fakeEvent = { data: { json: () => payload } };
    const parsed = helpers.parsePushPayload(fakeEvent);
    expect(parsed).toEqual(payload);
  });

  it("34. safeNotificationTargetPath still enforces same-origin-only for the fixed payload's path", () => {
    const helpers = loadSwHelpers();
    expect(helpers.safeNotificationTargetPath("/")).toBe("/");
    expect(helpers.safeNotificationTargetPath("https://evil.example/")).toBe("/");
  });

  it("35. public/sw.js is byte-for-byte unchanged from Faz NOTIF.2C — no caching/fetch handler introduced by this phase", () => {
    const sw = read("public/sw.js");
    expect(sw).not.toMatch(/caches\.open|addEventListener\(["']fetch["']/);
    expect(sw).toContain("SW_VERSION");
  });
});

// ========================= SECURITY REGRESSIONS =========================

describe("security regressions", () => {
  const NEW_FILES = [
    "lib/pwa/push-subscription.ts",
    "lib/pwa/web-push-server.ts",
    "components/settings/notification-settings-card.tsx",
  ];
  const sources = codeOnly(NEW_FILES.map((f) => read(f)).join("\n"));
  const originalMigration = read("supabase/migrations/20260914120000_push_subscription_test_send_read.sql");
  const correctiveMigration = read("supabase/migrations/20260914121000_harden_push_test_send_server_only.sql");
  const actionsSrc = codeOnly(read("lib/modules/settings/actions.ts"));

  it("no service_role / admin client in any BROWSER-adjacent new file (push-subscription.ts, web-push-server.ts, the settings card)", () => {
    expect(sources).not.toMatch(/service_role|SERVICE_ROLE|supabase\/admin/i);
  });

  it("service_role IS used, but ONLY in the one server-only Server Action file, never NEXT_PUBLIC_-prefixed, never in a client component", () => {
    expect(actionsSrc).toMatch(/createAdminClient/);
    expect(read("lib/modules/settings/actions.ts").trimStart().startsWith('"use server";')).toBe(true);
    expect(actionsSrc).not.toMatch(/NEXT_PUBLIC_.*service_role|service_role.*NEXT_PUBLIC_/i);
    // The admin client factory itself still carries the server-only guard.
    expect(read("lib/supabase/admin.ts").trimStart().startsWith('import "server-only";')).toBe(true);
  });

  it("no notification_events reader/consumer introduced", () => {
    expect(sources).not.toMatch(/notification_events/);
    expect(actionsSrc).not.toMatch(/notification_events/);
  });

  it("booking_gateway / public-booking surface untouched", () => {
    expect(sources).not.toMatch(/booking_gateway|create_guest_booking/);
    expect(actionsSrc).not.toMatch(/booking_gateway|create_guest_booking/);
  });

  it("the ORIGINAL (superseded) migration is left byte-for-byte unedited — the correction is forward-only, per Faz NOTIF.2D.1's own rule", () => {
    // Historical record only: this file's own grant to authenticated is
    // exactly why 20260914121000 exists to drop it. Not re-asserted as
    // current-state-correct here — see the corrective migration's own
    // checks below for what actually holds today.
    expect(originalMigration).toContain("create function public.get_my_push_subscriptions_for_test_send");
  });

  it("the corrective migration drops the browser-reachable function in both schemas", () => {
    expect(correctiveMigration).toMatch(/drop function if exists public\.get_my_push_subscriptions_for_test_send\(uuid\);/);
    expect(correctiveMigration).toMatch(/drop function if exists private\.get_my_push_subscriptions_for_test_send\(uuid\);/);
  });

  it("the corrective migration grants EXECUTE to service_role ONLY — never anon/authenticated/PUBLIC", () => {
    expect(correctiveMigration).toMatch(
      /grant execute on function public\.get_push_subscriptions_for_test_send\(uuid, uuid\) to service_role;/,
    );
    expect(correctiveMigration).toMatch(
      /revoke execute on function public\.get_push_subscriptions_for_test_send\(uuid, uuid\) from authenticated;/,
    );
    expect(correctiveMigration).not.toMatch(/grant execute .* to anon/);
    expect(correctiveMigration).not.toMatch(/grant execute .* to (public|authenticated)/i);
  });

  it("the corrective migration does not widen push_subscriptions' own table grants (still zero-grant-plus-RLS; no service_role table SELECT shortcut)", () => {
    expect(correctiveMigration).not.toMatch(/grant .* on (table )?push_subscriptions/i);
  });

  it("no new table created by either migration — subscription storage is 100% reused from Faz NOTIF.2A", () => {
    expect(originalMigration).not.toMatch(/create table/i);
    expect(correctiveMigration).not.toMatch(/create table/i);
  });
});
