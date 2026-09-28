import { createECDH, randomBytes } from "node:crypto";
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
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL_ENV };
});

async function loadSendTestPush() {
  const mod = await import("@/lib/pwa/web-push-server");
  return mod.sendTestPush;
}

// Faz ACCOUNT.1 (security): every send is now checked against the push-service
// allow-list first, so the fixture is REAL-shaped: a supported vendor host and
// a genuine P-256 key pair (the old placeholder strings are exactly what the
// sender now refuses).
const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function realKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: b64url(ecdh.getPublicKey()), authKey: b64url(randomBytes(16)) };
}
const KEYS = realKeys();
const FAKE_SUBSCRIPTION = { endpoint: "https://fcm.googleapis.com/fcm/send/fixture-token-1", ...KEYS };

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
    await sendTestPush({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/OTHER", ...realKeys() });
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

  it("11. no retry/backoff/queue logic exists inside sendTestPush itself — one attempt per call, Step 14's 'no retry system for this phase'", () => {
    // Faz NOTIF.2E.2 adds real retry/backoff classification (classifyPushSendError/sendDeliveryPush)
    // to this SAME file, for the separate automatic-delivery sender — by design, that is
    // this phase's whole point, and this check must not fail because of it. Scoped to exactly
    // sendTestPush's own function body (start of its declaration to the next top-level export),
    // which remains untouched and still genuinely has zero retry/backoff/queue vocabulary.
    const start = source.indexOf("export async function sendTestPush");
    const end = source.indexOf("\nexport", start + 1);
    const sendTestPushBody = source.slice(start, end === -1 ? undefined : end);
    expect(sendTestPushBody).not.toMatch(/setTimeout|setInterval|retry|backoff|queue/i);
  });

  it("12. this module is not a generic sender — no function here accepts a title/body/path argument", () => {
    // The exported surface is sendTestPush(subscription) only, and the
    // payload constant is built with no parameters.
    expect(source).not.toMatch(/function sendTestPush\([^)]*title/i);
    expect(source).not.toMatch(/function sendTestPush\([^)]*body/i);
  });
});

// ============ Faz ACCOUNT.1 (security) — the endpoint policy at the send edge ============

const HOSTILE_ENDPOINTS = [
  "https://evil.example/collect",
  "http://fcm.googleapis.com/fcm/send/x",
  "https://127.0.0.1/x",
  "https://169.254.169.254/latest/meta-data/",
  "https://localhost:9443/push/abc",
  "https://[::1]/x",
  "https://user:pw@fcm.googleapis.com/x",
  "https://fcm.googleapis.com.evil.example/x",
  "https://storage.googleapis.com/bucket/object",
  "https://fcm.googleapis.com:8443/x",
];

describe("sendTestPush — endpoint policy", () => {
  it("13. refuses every hostile endpoint with {outcome: 'rejected'} and makes NO network request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sendTestPush = await loadSendTestPush();
    for (const endpoint of HOSTILE_ENDPOINTS) {
      await expect(sendTestPush({ ...FAKE_SUBSCRIPTION, endpoint }), endpoint).resolves.toEqual({ outcome: "rejected" });
    }
    expect(sendNotification).not.toHaveBeenCalled();
    // the log carries a reason code only — never the endpoint
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/evil|127\.0\.0\.1|169\.254|localhost|storage\.googleapis/);
    warn.mockRestore();
  });

  it("14. refuses malformed keys before web-push can throw on them (which would look like a transient error)", async () => {
    const sendTestPush = await loadSendTestPush();
    await expect(sendTestPush({ ...FAKE_SUBSCRIPTION, p256dh: "p256dh-val" })).resolves.toEqual({ outcome: "rejected" });
    await expect(sendTestPush({ ...FAKE_SUBSCRIPTION, authKey: "auth-val" })).resolves.toEqual({ outcome: "rejected" });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("15. posts to the CANONICAL endpoint (default port dropped) and always with a hard timeout", async () => {
    const sendTestPush = await loadSendTestPush();
    sendNotification.mockResolvedValueOnce(undefined);
    await sendTestPush({ ...FAKE_SUBSCRIPTION, endpoint: "https://fcm.googleapis.com:443/fcm/send/fixture-token-1" });
    const [subArg, , optionsArg] = sendNotification.mock.calls[0]!;
    expect((subArg as { endpoint: string }).endpoint).toBe("https://fcm.googleapis.com/fcm/send/fixture-token-1");
    expect(optionsArg).toEqual({ timeout: 10_000 });
  });

  it("16. the local-mock escape hatch works outside production and is IGNORED in production", async () => {
    const mock = { ...FAKE_SUBSCRIPTION, endpoint: "https://localhost:9443/push/fixture-1" };
    vi.stubEnv("WEB_PUSH_EXTRA_ALLOWED_HOSTS", "localhost:9443");

    vi.stubEnv("NODE_ENV", "development");
    let sendTestPush = await loadSendTestPush();
    sendNotification.mockResolvedValueOnce(undefined);
    await expect(sendTestPush(mock)).resolves.toEqual({ outcome: "sent" });

    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    sendTestPush = await loadSendTestPush();
    sendNotification.mockClear();
    await expect(sendTestPush(mock)).resolves.toEqual({ outcome: "rejected" });
    expect(sendNotification).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("17. checkSubscriptionForSend reports reason codes and returns the canonical endpoint on success", async () => {
    const { checkSubscriptionForSend } = await import("@/lib/pwa/web-push-server");
    expect(checkSubscriptionForSend(FAKE_SUBSCRIPTION, { NODE_ENV: "production" })).toEqual({ ok: true, endpoint: FAKE_SUBSCRIPTION.endpoint });
    expect(checkSubscriptionForSend({ ...FAKE_SUBSCRIPTION, endpoint: "https://evil.example/x" }, { NODE_ENV: "production" })).toEqual({ ok: false, reason: "endpoint:host_not_allowed" });
    expect(checkSubscriptionForSend({ ...FAKE_SUBSCRIPTION, authKey: "x" }, { NODE_ENV: "production" })).toEqual({ ok: false, reason: "keys:auth_format" });
  });

  it("18. a rejected result carries nothing else — no endpoint, no keys, no error text", async () => {
    const sendTestPush = await loadSendTestPush();
    const result = await sendTestPush({ ...FAKE_SUBSCRIPTION, endpoint: "https://evil.example/collect" });
    expect(Object.keys(result)).toEqual(["outcome"]);
  });
});

describe("sendDeliveryPush — endpoint policy (the automatic worker path)", () => {
  const PAYLOAD = { title: "SalonOS", body: "Yeni randevu oluşturuldu.", path: "/app/x/appointments" };

  async function loadSendDeliveryPush() {
    return (await import("@/lib/pwa/web-push-server")).sendDeliveryPush;
  }

  it("19. a subscription the policy refuses is reported as STALE (so the database revokes the row on the first attempt), with no network request", async () => {
    const sendDeliveryPush = await loadSendDeliveryPush();
    for (const endpoint of HOSTILE_ENDPOINTS) {
      const outcome = await sendDeliveryPush({ ...FAKE_SUBSCRIPTION, endpoint }, PAYLOAD);
      expect(outcome, endpoint).toEqual({
        outcome: "stale",
        errorCode: "endpoint_rejected",
        errorMessage: "subscription refused by the push endpoint policy",
      });
    }
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("20. a valid subscription is posted to the canonical endpoint with the hard timeout", async () => {
    const sendDeliveryPush = await loadSendDeliveryPush();
    sendNotification.mockResolvedValueOnce(undefined);
    await expect(sendDeliveryPush(FAKE_SUBSCRIPTION, PAYLOAD)).resolves.toEqual({ outcome: "sent" });
    const [subArg, payloadArg, optionsArg] = sendNotification.mock.calls[0]!;
    expect((subArg as { endpoint: string }).endpoint).toBe(FAKE_SUBSCRIPTION.endpoint);
    expect(JSON.parse(payloadArg as string)).toEqual(PAYLOAD);
    expect(optionsArg).toEqual({ timeout: 10_000 });
  });

  it("21. redirects are permanent failures: a 3xx answer is 'failed', never retried and never followed", async () => {
    const sendDeliveryPush = await loadSendDeliveryPush();
    for (const statusCode of [301, 302, 307, 308]) {
      sendNotification.mockRejectedValueOnce(Object.assign(new Error("Received unexpected response code"), { statusCode }));
      await expect(sendDeliveryPush(FAKE_SUBSCRIPTION, PAYLOAD)).resolves.toMatchObject({ outcome: "failed", errorCode: "http_" + statusCode });
    }
  });
});

// ============ Apple Web Push — the host both current production subscriptions use ============

// Safari / iOS Home-Screen web apps register with web.push.apple.com: one opaque base64url-style
// path segment of roughly a hundred characters, no query string.
const APPLE_SUBSCRIPTION = {
  endpoint:
    "https://web.push.apple.com/QRs1xJ_9-0aB3cD5eF7gH2iJ4kL6mN8oP0qR2sT4uV6wX8yZ1a3C5e7G9iK1mO3qS5uW7yA9bD2fH4jL6nP8rT0vX2zB4dF6hJ8lN1pR3tV5xZ7bC",
  ...KEYS,
};

describe("Apple Web Push (web.push.apple.com) — the send edge accepts it, and only it", () => {
  it("22. checkSubscriptionForSend accepts a realistic Apple endpoint with real-shaped keys, in production mode, and returns it unchanged", async () => {
    const { checkSubscriptionForSend } = await import("@/lib/pwa/web-push-server");
    expect(checkSubscriptionForSend(APPLE_SUBSCRIPTION, { NODE_ENV: "production" })).toEqual({ ok: true, endpoint: APPLE_SUBSCRIPTION.endpoint });
  });

  it("23. both sender paths (manual test and automatic delivery) post to the Apple endpoint exactly as stored, with the hard timeout", async () => {
    const sendTestPush = await loadSendTestPush();
    const { sendDeliveryPush } = await import("@/lib/pwa/web-push-server");
    sendNotification.mockResolvedValue(undefined);

    await expect(sendTestPush(APPLE_SUBSCRIPTION)).resolves.toEqual({ outcome: "sent" });
    await expect(sendDeliveryPush(APPLE_SUBSCRIPTION, { title: "SalonOS", body: "x", path: "/" })).resolves.toEqual({ outcome: "sent" });

    expect(sendNotification).toHaveBeenCalledTimes(2);
    for (const [subArg, , optionsArg] of sendNotification.mock.calls) {
      expect((subArg as { endpoint: string }).endpoint).toBe(APPLE_SUBSCRIPTION.endpoint);
      expect(optionsArg).toEqual({ timeout: 10_000 });
    }
  });

  it("24. look-alike Apple hosts and other schemes/ports make NO network request on either path", async () => {
    const sendTestPush = await loadSendTestPush();
    const { sendDeliveryPush } = await import("@/lib/pwa/web-push-server");
    for (const endpoint of [
      "https://web.push.apple.com.evil.example/x",
      "https://sub.web.push.apple.com/x",
      "https://evil-web.push.apple.com/x",
      "https://api.push.apple.com/3/device/abc",
      "http://web.push.apple.com/x",
      "https://web.push.apple.com:8443/x",
    ]) {
      await expect(sendTestPush({ ...APPLE_SUBSCRIPTION, endpoint }), endpoint).resolves.toEqual({ outcome: "rejected" });
      await expect(sendDeliveryPush({ ...APPLE_SUBSCRIPTION, endpoint }, { title: "SalonOS", body: "x", path: "/" }), endpoint).resolves.toMatchObject({
        outcome: "stale",
        errorCode: "endpoint_rejected",
      });
    }
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
