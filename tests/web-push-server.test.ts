import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync("lib/pwa/web-push-server.ts", "utf8");

/**
 * Faz NOTIF.2D — lib/pwa/web-push-server.ts. This is the one place that
 * calls the actual `web-push` package, which makes a real HTTP POST to a
 * push service (FCM/Mozilla/etc.) — a genuine external system boundary,
 * unlike this project's own database (which the rest of this phase's
 * tests hit for real, per this codebase's established convention; see
 * notification-foundation.test.ts's own header). Mocking THIS boundary
 * (not our own DB/RPC layer) is the correct, narrow use of vi.mock here:
 * there is no way to integration-test a real push send without a real
 * subscribed device receiving it, which is what Faz NOTIF.2D Step 19
 * covers separately, manually, against a real browser.
 */

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY = "test-public-key";
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "test-private-key";
  process.env.WEB_PUSH_SUBJECT = "mailto:test@example.com";
});

afterEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

async function loadSendTestPush() {
  const mod = await import("@/lib/pwa/web-push-server");
  return mod.sendTestPush;
}

const FAKE_SUBSCRIPTION = { endpoint: "https://push.example.test/ep/1", p256dh: "p256dh-val", authKey: "auth-val" };

describe("sendTestPush", () => {
  it("1. source imports server-only as its first import — build-time client-bundle guard", () => {
    expect(source.trimStart().startsWith('import "server-only";')).toBe(true);
  });

  it("2. configures VAPID details from env exactly once, lazily, not at import time", async () => {
    const sendTestPush = await loadSendTestPush();
    expect(setVapidDetails).not.toHaveBeenCalled();
    sendNotification.mockResolvedValueOnce(undefined);
    await sendTestPush(FAKE_SUBSCRIPTION);
    expect(setVapidDetails).toHaveBeenCalledTimes(1);
    expect(setVapidDetails).toHaveBeenCalledWith("mailto:test@example.com", "test-public-key", "test-private-key");
    await sendTestPush(FAKE_SUBSCRIPTION);
    expect(setVapidDetails).toHaveBeenCalledTimes(1); // not re-configured on a second call
  });

  it("3. throws if any VAPID env var is missing, never silently sends unsigned", async () => {
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    const sendTestPush = await loadSendTestPush();
    await expect(sendTestPush(FAKE_SUBSCRIPTION)).rejects.toThrow(/VAPID/);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("4. sends the subscription's own endpoint/keys, mapped to web-push's expected shape", async () => {
    const sendTestPush = await loadSendTestPush();
    sendNotification.mockResolvedValueOnce(undefined);
    await sendTestPush(FAKE_SUBSCRIPTION);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [subArg] = sendNotification.mock.calls[0]!;
    expect(subArg).toEqual({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      keys: { p256dh: FAKE_SUBSCRIPTION.p256dh, auth: FAKE_SUBSCRIPTION.authKey },
    });
  });

  it("5. the payload is fixed — SalonOS / a generic success sentence / path '/' — never derived from a caller argument", async () => {
    const sendTestPush = await loadSendTestPush();
    sendNotification.mockResolvedValueOnce(undefined);
    await sendTestPush(FAKE_SUBSCRIPTION);
    const [, payloadArg] = sendNotification.mock.calls[0]!;
    const payload = JSON.parse(payloadArg as string);
    expect(payload).toEqual({ title: "SalonOS", body: "Test bildirimi başarıyla ulaştı.", path: "/" });
    // No customer name, appointment, or any other per-caller data appears.
    expect(payloadArg).not.toContain(FAKE_SUBSCRIPTION.endpoint);

    // Calling again with a totally different subscription produces the
    // byte-identical payload — proof the payload has no per-call inputs.
    sendNotification.mockResolvedValueOnce(undefined);
    await sendTestPush({ endpoint: "https://push.example.test/ep/OTHER", p256dh: "x", authKey: "y" });
    const [, payloadArg2] = sendNotification.mock.calls[1]!;
    expect(payloadArg2).toBe(payloadArg);
  });

  it("6. success maps to {outcome: 'sent'}", async () => {
    const sendTestPush = await loadSendTestPush();
    sendNotification.mockResolvedValueOnce(undefined);
    await expect(sendTestPush(FAKE_SUBSCRIPTION)).resolves.toEqual({ outcome: "sent" });
  });

  it("7. a 404 response maps to {outcome: 'stale'} — permanently gone, safe to revoke", async () => {
    const sendTestPush = await loadSendTestPush();
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("Gone"), { statusCode: 404 }));
    await expect(sendTestPush(FAKE_SUBSCRIPTION)).resolves.toEqual({ outcome: "stale" });
  });

  it("8. a 410 response maps to {outcome: 'stale'} — permanently gone, safe to revoke", async () => {
    const sendTestPush = await loadSendTestPush();
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("Gone"), { statusCode: 410 }));
    await expect(sendTestPush(FAKE_SUBSCRIPTION)).resolves.toEqual({ outcome: "stale" });
  });

  it("9. a transient failure (e.g. 500, or a network error with no statusCode) maps to {outcome: 'failed'}, never 'stale'", async () => {
    const sendTestPush = await loadSendTestPush();
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("server error"), { statusCode: 500 }));
    await expect(sendTestPush(FAKE_SUBSCRIPTION)).resolves.toEqual({ outcome: "failed" });

    sendNotification.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(sendTestPush(FAKE_SUBSCRIPTION)).resolves.toEqual({ outcome: "failed" });
  });

  it("10. never throws out of a delivery failure — the caller always gets a result, not an exception", async () => {
    const sendTestPush = await loadSendTestPush();
    sendNotification.mockRejectedValueOnce(new Error("anything"));
    await expect(sendTestPush(FAKE_SUBSCRIPTION)).resolves.toBeDefined();
  });

  it("11. no retry/backoff/queue logic exists — one attempt per call, Step 14's 'no retry system for this phase'", () => {
    expect(source).not.toMatch(/setTimeout|setInterval|retry|backoff|queue/i);
  });

  it("12. this module is not a generic sender — no function here accepts a title/body/path argument", () => {
    // The exported surface is sendTestPush(subscription) only, and the
    // payload constant is built with no parameters.
    expect(source).not.toMatch(/function sendTestPush\([^)]*title/i);
    expect(source).not.toMatch(/function sendTestPush\([^)]*body/i);
  });
});
