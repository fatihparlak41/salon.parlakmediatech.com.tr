import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_TEST_SEND_LIMIT,
  MAX_DEVICES_PER_TEST_SEND,
  SlidingWindowLimiter,
  USER_TEST_SEND_LIMIT,
  retryAfterPhrase,
} from "@/lib/pwa/test-send-limiter";

/**
 * Faz ACCOUNT.1 (security) — abuse protection for the manual test
 * notification: the limiter itself (pure, injectable clock) and the Server
 * Action that applies it (mocked Supabase/session, same narrow precedent as
 * push-subscription.test.ts: a Server Action needs next/headers to run).
 */

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// ---------------------------------------------------------------- limiter

describe("SlidingWindowLimiter", () => {
  function make(config = { minIntervalMs: 5000, maxPerWindow: 3, windowMs: 60_000 }) {
    let clock = 1_000_000;
    const limiter = new SlidingWindowLimiter(config, () => clock, 3);
    return { limiter, advance: (ms: number) => (clock += ms) };
  }

  it("accepts the first attempt and reports how long to wait when the next comes too soon", () => {
    const { limiter, advance } = make();
    expect(limiter.check("u")).toEqual({ allowed: true });
    limiter.record("u");
    advance(1000);
    expect(limiter.check("u")).toEqual({ allowed: false, reason: "too_soon", retryAfterMs: 4000 });
    advance(4000);
    expect(limiter.check("u")).toEqual({ allowed: true });
  });

  it("closes the window after maxPerWindow attempts and reopens it exactly when the oldest one ages out", () => {
    const { limiter, advance } = make({ minIntervalMs: 0, maxPerWindow: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("u").allowed).toBe(true);
      limiter.record("u");
      advance(10_000); // attempts at t=0, 10, 20 s
    }
    const blocked = limiter.check("u"); // now t=30 s; oldest attempt was at t=0
    expect(blocked).toEqual({ allowed: false, reason: "window_full", retryAfterMs: 30_000 });
    advance(30_000); // t=60 s: the oldest attempt is now outside the window
    expect(limiter.check("u")).toEqual({ allowed: true });
  });

  it("check() never counts an attempt — only record() does", () => {
    const { limiter } = make({ minIntervalMs: 0, maxPerWindow: 1, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) expect(limiter.check("u")).toEqual({ allowed: true });
    limiter.record("u");
    expect(limiter.check("u").allowed).toBe(false);
  });

  it("keys are independent (one user or device never throttles another)", () => {
    const { limiter } = make({ minIntervalMs: 0, maxPerWindow: 1, windowMs: 60_000 });
    limiter.record("a");
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("bounds its memory: past maxKeys distinct keys the oldest key is evicted", () => {
    const { limiter } = make({ minIntervalMs: 0, maxPerWindow: 1, windowMs: 60_000 });
    for (const k of ["k1", "k2", "k3", "k4"]) limiter.record(k); // maxKeys is 3
    expect(limiter.check("k1").allowed).toBe(true); // evicted -> forgotten
    expect(limiter.check("k4").allowed).toBe(false);
  });

  it("ships the documented production limits", () => {
    expect(USER_TEST_SEND_LIMIT).toEqual({ minIntervalMs: 5_000, maxPerWindow: 6, windowMs: 600_000 });
    expect(DEVICE_TEST_SEND_LIMIT).toEqual({ minIntervalMs: 0, maxPerWindow: 3, windowMs: 600_000 });
    expect(MAX_DEVICES_PER_TEST_SEND).toBe(5);
  });

  it("phrases waits in Turkish seconds or minutes, never below one second", () => {
    expect(retryAfterPhrase(0)).toBe("1 saniye");
    expect(retryAfterPhrase(1200)).toBe("2 saniye");
    expect(retryAfterPhrase(89_000)).toBe("89 saniye");
    expect(retryAfterPhrase(90_000)).toBe("2 dakika");
    expect(retryAfterPhrase(600_000)).toBe("10 dakika");
  });
});

// ----------------------------------------------------------------- action

const rpcMock = vi.fn(); // the regular (RLS) client
const adminRpcMock = vi.fn(); // service_role client
const requireUserMock = vi.fn(async () => ({ id: "user-1" }));
const sendTestPushMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: rpcMock }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: adminRpcMock }) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: () => requireUserMock() }));
vi.mock("@/lib/pwa/web-push-server", () => ({ sendTestPush: (...args: unknown[]) => sendTestPushMock(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

async function loadAction() {
  return (await import("@/lib/modules/settings/actions")).sendTestPushNotificationAction;
}

const device = (id: string) => ({ id, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: "p", authKey: "a" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T09:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("sendTestPushNotificationAction — abuse limits", () => {
  it("throttles a user who presses again within 5 s: RATE_LIMITED, and the second press costs no RPC and no push", async () => {
    adminRpcMock.mockResolvedValue({ data: [device("d1")], error: null });
    sendTestPushMock.mockResolvedValue({ outcome: "sent" });
    const action = await loadAction();

    const first = await action(null, { tenantId: "t" });
    expect(first).toEqual({ success: true, data: { sent: true } });

    vi.advanceTimersByTime(2000);
    const second = await action(null, { tenantId: "t" });
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error.code).toBe("RATE_LIMITED");
      expect(second.error.message).toMatch(/3 saniye/);
    }
    expect(adminRpcMock).toHaveBeenCalledTimes(1);
    expect(sendTestPushMock).toHaveBeenCalledTimes(1);
  });

  it("allows another press once the 5 s gap has passed", async () => {
    adminRpcMock.mockResolvedValue({ data: [device("d1")], error: null });
    sendTestPushMock.mockResolvedValue({ outcome: "sent" });
    const action = await loadAction();
    await action(null, { tenantId: "t" });
    vi.advanceTimersByTime(5000);
    expect((await action(null, { tenantId: "t" })).success).toBe(true);
    expect(sendTestPushMock).toHaveBeenCalledTimes(2);
  });

  it("caps a user at 6 test sends per 10 minutes, then reopens", async () => {
    adminRpcMock.mockImplementation(async () => ({ data: [device(`fresh-${Math.random()}`)], error: null })); // a new device each time: only the USER limit can bite
    sendTestPushMock.mockResolvedValue({ outcome: "sent" });
    const action = await loadAction();
    for (let i = 0; i < 6; i++) {
      expect((await action(null, { tenantId: "t" })).success, `press ${i + 1}`).toBe(true);
      vi.advanceTimersByTime(6000);
    }
    const seventh = await action(null, { tenantId: "t" });
    expect(seventh.success).toBe(false);
    if (!seventh.success) expect(seventh.error.code).toBe("RATE_LIMITED");

    vi.advanceTimersByTime(10 * 60_000);
    expect((await action(null, { tenantId: "t" })).success).toBe(true);
  });

  it("limits ONE device to 3 test sends per 10 minutes; a fresh device is still testable", async () => {
    sendTestPushMock.mockResolvedValue({ outcome: "sent" });
    const action = await loadAction();
    adminRpcMock.mockResolvedValue({ data: [device("same-device")], error: null });
    for (let i = 0; i < 3; i++) {
      expect((await action(null, { tenantId: "t" })).success, `press ${i + 1}`).toBe(true);
      vi.advanceTimersByTime(6000);
    }
    const fourth = await action(null, { tenantId: "t" });
    expect(fourth.success).toBe(false);
    if (!fourth.success) {
      expect(fourth.error.code).toBe("RATE_LIMITED");
      expect(fourth.error.message).toMatch(/cihaza/);
    }
    expect(sendTestPushMock).toHaveBeenCalledTimes(3);

    // The member connects a second device: only that one goes out; the limited one is skipped.
    vi.advanceTimersByTime(6000);
    adminRpcMock.mockResolvedValue({ data: [device("same-device"), device("second-device")], error: null });
    expect((await action(null, { tenantId: "t" })).success).toBe(true);
    expect(sendTestPushMock).toHaveBeenCalledTimes(4);
    expect(sendTestPushMock.mock.calls[3]![0].endpoint).toContain("second-device");
  });

  it(`contacts at most ${MAX_DEVICES_PER_TEST_SEND} devices per press even if the database returns more`, async () => {
    adminRpcMock.mockResolvedValue({ data: Array.from({ length: 9 }, (_, i) => device(`d${i}`)), error: null });
    sendTestPushMock.mockResolvedValue({ outcome: "sent" });
    const action = await loadAction();
    await action(null, { tenantId: "t" });
    expect(sendTestPushMock).toHaveBeenCalledTimes(MAX_DEVICES_PER_TEST_SEND);
  });

  it("a throttled user is throttled BEFORE any database work; an unauthenticated caller reaches neither", async () => {
    adminRpcMock.mockResolvedValue({ data: [device("d1")], error: null });
    sendTestPushMock.mockResolvedValue({ outcome: "sent" });
    const action = await loadAction();
    await action(null, { tenantId: "t" });
    adminRpcMock.mockClear();
    await action(null, { tenantId: "t" });
    expect(adminRpcMock).not.toHaveBeenCalled();

    requireUserMock.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(action(null, { tenantId: "t" })).rejects.toThrow("NEXT_REDIRECT");
    expect(adminRpcMock).not.toHaveBeenCalled();
  });

  it("two different users never share a bucket", async () => {
    adminRpcMock.mockImplementation(async () => ({ data: [device(`fresh-${Math.random()}`)], error: null }));
    sendTestPushMock.mockResolvedValue({ outcome: "sent" });
    const action = await loadAction();
    expect((await action(null, { tenantId: "t" })).success).toBe(true); // user-1
    requireUserMock.mockResolvedValueOnce({ id: "user-2" });
    expect((await action(null, { tenantId: "t" })).success).toBe(true); // user-2 right away
  });
});

describe("sendTestPushNotificationAction — only the caller's own devices", () => {
  it("passes the SESSION's user id to the privileged read and ignores every id smuggled in the input", async () => {
    adminRpcMock.mockResolvedValue({ data: [device("d1")], error: null });
    sendTestPushMock.mockResolvedValue({ outcome: "sent" });
    const action = await loadAction();
    // @ts-expect-error — deliberately smuggling other members' identifiers in.
    await action(null, { tenantId: "t", userId: "victim", user_id: "victim", subscriptionId: "victims-device", endpoint: "https://fcm.googleapis.com/fcm/send/victim" });
    expect(adminRpcMock).toHaveBeenCalledWith("get_push_subscriptions_for_test_send", { p_tenant_id: "t", p_user_id: "user-1" });
    // and what is sent is exactly what that read returned
    expect(sendTestPushMock).toHaveBeenCalledTimes(1);
    expect(sendTestPushMock.mock.calls[0]![0].endpoint).toBe(device("d1").endpoint);
  });

  it("a subscription the sender refuses ('rejected') is revoked like a dead one and reported as an expired connection", async () => {
    adminRpcMock.mockResolvedValue({ data: [device("bad")], error: null });
    rpcMock.mockResolvedValue({ error: null });
    sendTestPushMock.mockResolvedValue({ outcome: "rejected" });
    const action = await loadAction();
    const result = await action(null, { tenantId: "t" });
    expect(rpcMock).toHaveBeenCalledWith("remove_push_subscription", { p_subscription_id: "bad" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("source contracts", () => {
  it("the limiter runs before the admin client is created, and the action imports it from lib/pwa", () => {
    const src = read("lib/modules/settings/actions.ts");
    const start = src.indexOf("export async function sendTestPushNotificationAction");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body.indexOf("testSendLimiters.user.check")).toBeGreaterThan(-1);
    expect(body.indexOf("testSendLimiters.user.check")).toBeLessThan(body.indexOf("createAdminClient()"));
    expect(body).toContain("MAX_DEVICES_PER_TEST_SEND");
    expect(src).toContain('from "@/lib/pwa/test-send-limiter"');
  });
});
