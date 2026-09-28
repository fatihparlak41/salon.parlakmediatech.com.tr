import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as legacyUrlParse } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_ENDPOINT_LENGTH,
  PUSH_SERVICE_EXACT_HOSTS,
  PUSH_SERVICE_HOST_SUFFIXES,
  extraAllowedPushHostsFromEnv,
  validatePushEndpoint,
  validatePushKeys,
  type PushEndpointRejection,
} from "@/lib/pwa/push-endpoint-policy";

/**
 * Faz ACCOUNT.1 (security) — the allow-list that decides which push
 * endpoints this server will store and POST to. Pure unit tests: no
 * database, no network. The hostile inputs below are the classic SSRF
 * shapes: internal hosts, every IP spelling, credentials, ports, look-alike
 * domains, parser-differential tricks.
 */

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function realKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) };
}

const ALLOWED = [
  "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bE_fake-token-123",
  "https://fcm.googleapis.com/wp/fake_token-123",
  "https://android.googleapis.com/gcm/send/fake-registration-id",
  "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABfake_token-123",
  "https://web.push.apple.com/QVVUSE_fake-token-123",
  "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB_fake-token%2fabc",
  "https://sg2p.notify.windows.com/w/?token=fake",
];

describe("push endpoint policy — accepted endpoints", () => {
  it("accepts every supported vendor push service and returns the canonical href unchanged", () => {
    for (const endpoint of ALLOWED) {
      const result = validatePushEndpoint(endpoint);
      expect(result, endpoint).toMatchObject({ ok: true, href: endpoint });
    }
  });

  it("accepts an explicit :443 and returns the href WITHOUT it (the form a sender must use)", () => {
    const result = validatePushEndpoint("https://fcm.googleapis.com:443/fcm/send/abc");
    expect(result).toEqual({ ok: true, href: "https://fcm.googleapis.com/fcm/send/abc", hostname: "fcm.googleapis.com" });
  });

  it("lists exactly the vendor hosts documented in the module (no accidental widening)", () => {
    expect([...PUSH_SERVICE_EXACT_HOSTS].sort()).toEqual([
      "android.googleapis.com",
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "web.push.apple.com",
    ]);
    expect([...PUSH_SERVICE_HOST_SUFFIXES]).toEqual([".notify.windows.com"]);
  });
});

// Safari / iOS Home-Screen web apps register with web.push.apple.com, and both of the
// active subscriptions in production today point there. A real endpoint is one opaque
// base64url-style path segment of roughly a hundred characters, with no query string.
const APPLE_ENDPOINT =
  "https://web.push.apple.com/QRs1xJ_9-0aB3cD5eF7gH2iJ4kL6mN8oP0qR2sT4uV6wX8yZ1a3C5e7G9iK1mO3qS5uW7yA9bD2fH4jL6nP8rT0vX2zB4dF6hJ8lN1pR3tV5xZ7bC";

describe("push endpoint policy — Apple Web Push (web.push.apple.com), the host production's current subscriptions use", () => {
  it("accepts a realistic Safari/iOS endpoint and returns the identical canonical href", () => {
    expect(validatePushEndpoint(APPLE_ENDPOINT)).toEqual({ ok: true, href: APPLE_ENDPOINT, hostname: "web.push.apple.com" });
  });

  it("accepts the keys a real subscription carries, and an explicit :443 is dropped from the stored form", () => {
    const keys = realKeys();
    expect(validatePushKeys(keys.p256dh, keys.auth)).toEqual({ ok: true });
    expect(validatePushEndpoint("https://web.push.apple.com:443/QRs1xJ_9-0aB3cD5eF")).toEqual({
      ok: true,
      href: "https://web.push.apple.com/QRs1xJ_9-0aB3cD5eF",
      hostname: "web.push.apple.com",
    });
  });

  it("is an EXACT-host entry, not a suffix: sub-domains, look-alikes and Apple's other push hosts are refused", () => {
    expect(PUSH_SERVICE_EXACT_HOSTS).toContain("web.push.apple.com");
    // no suffix rule can ever reach it, so a sub-domain of it is not implicitly allowed either
    expect(PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => "sub.web.push.apple.com".endsWith(suffix))).toBe(false);
    for (const endpoint of [
      "https://web.push.apple.com.evil.example/x",
      "https://sub.web.push.apple.com/x",
      "https://evil-web.push.apple.com/x",
      "https://push.apple.com/x",
      "https://api.push.apple.com/3/device/abc",
      "https://apple.com/x",
    ]) {
      expect(validatePushEndpoint(endpoint), endpoint).toEqual({ ok: false, reason: "host_not_allowed" });
    }
  });

  it("is only ever contacted over https on the default port", () => {
    expect(validatePushEndpoint("http://web.push.apple.com/x")).toEqual({ ok: false, reason: "not_https" });
    expect(validatePushEndpoint("https://web.push.apple.com:8443/x")).toEqual({ ok: false, reason: "port" });
    expect(validatePushEndpoint("https://user@web.push.apple.com/x")).toEqual({ ok: false, reason: "credentials" });
  });
});

describe("push endpoint policy — rejected endpoints", () => {
  const cases: Array<[PushEndpointRejection, string[]]> = [
    ["empty", [""]],
    ["unsafe_characters", [
      " https://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com/fcm/send/a b",
      "https://fcm.googleapis.com/fcm/send/a\tb",
      "https://fcm.googleapis.com/fcm/send/a\nb",
      "https://fcm.goo\ngleapis.com/x", // the WHATWG parser would silently strip the newline
      "https://fcm.googleapis.com/fcm/send/ü",
      "https://fcm。googleapis.com/x", // ideographic full stop
      "https://fcm.googleapis.com\\@evil.com/x",
      "https://fcm.googleapis.com/x\\y",
      "https://fcm.googleapis.com/x\u0000",
    ]],
    ["not_https", [
      "http://fcm.googleapis.com/fcm/send/x",
      "HTTPS://fcm.googleapis.com/fcm/send/x",
      "ftp://fcm.googleapis.com/x",
      "javascript:alert(1)",
      "//fcm.googleapis.com/fcm/send/x",
      "fcm.googleapis.com/fcm/send/x",
      "file:///etc/passwd",
      "data:text/plain,hello",
      "https:/fcm.googleapis.com/x",
      "wss://fcm.googleapis.com/x",
    ]],
    ["credentials", [
      "https://user@fcm.googleapis.com/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com@evil.com/x",
      "https://fcm.googleapis.com:443@evil.com/x",
      "https://evil.com%2f@fcm.googleapis.com/x",
      "https://@fcm.googleapis.com/x",
    ]],
    ["port", [
      "https://fcm.googleapis.com:8443/x",
      "https://fcm.googleapis.com:80/x",
      "https://fcm.googleapis.com:0443/x",
      "https://fcm.googleapis.com:/x",
      "https://fcm.googleapis.com:65535/x",
    ]],
    ["fragment", [
      "https://fcm.googleapis.com/x#frag",
      "https://fcm.googleapis.com/x?a=b#c",
      "https://fcm.googleapis.com#@evil.com",
    ]],
    ["ip_literal", [
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://172.16.0.1/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://0.0.0.0/x",
      "https://2130706433/x", // decimal 127.0.0.1
      "https://0x7f.0.0.1/x", // hex octet
      "https://0x7f000001/x",
      "https://017700000001/x", // octal
      "https://127.1/x",
      "https://1.2.3.4:443/x",
      "https://[::1]/x",
      "https://[fe80::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[::1]:443/x",
    ]],
    ["host_not_allowed", [
      "https://localhost/x",
      "https://localhost:443/x",
      "https://intranet/x",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://printer.local/x",
      "https://evil.com/fcm/send/x",
      "https://example.com/x",
      // look-alikes and suffix tricks
      "https://fcm.googleapis.com.evil.com/x",
      "https://evilfcm.googleapis.com/x",
      "https://xfcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.com:443/x",
      "https://fcm-googleapis.com/x",
      "https://googleapis.com/x",
      "https://storage.googleapis.com/bucket/object", // Google user-content host, deliberately NOT allowed
      "https://www.googleapis.com/x",
      "https://firebaseinstallations.googleapis.com/x",
      "https://notify.windows.com/x", // the bare suffix domain
      "https://evil-notify.windows.com/x",
      "https://x.notify.windows.com.evil.com/x",
      "https://windows.com/x",
      "https://push.services.mozilla.com/x",
      "https://updates.push.services.mozilla.com.evil.com/x",
      "https://apple.com/x",
      "https://push.apple.com/x",
      // trailing dot, upper case, underscore
      "https://fcm.googleapis.com./fcm/send/x",
      "https://FCM.GOOGLEAPIS.COM/fcm/send/x",
      "https://fcm_googleapis.com/x",
      "https://fcm.googleapis.com%2eevil.com/x",
    ]],
    ["invalid_url", [
      "https://fcm.googleapis.com/a/../b", // not canonical
      "https://fcm.googleapis.com/a/./b",
      "https://:443/x",
    ]],
  ];

  for (const [reason, inputs] of cases) {
    it(`refuses with '${reason}': ${inputs.length} hostile input(s)`, () => {
      for (const input of inputs) {
        const result = validatePushEndpoint(input);
        expect(result.ok, `must be refused: ${JSON.stringify(input)}`).toBe(false);
        if (!result.ok) expect(result.reason, JSON.stringify(input)).toBe(reason);
      }
    });
  }

  it("refuses anything that is not a string", () => {
    for (const value of [null, undefined, 123, true, {}, [], ["https://fcm.googleapis.com/x"], Symbol("x")]) {
      const result = validatePushEndpoint(value as unknown);
      expect(result).toEqual({ ok: false, reason: "not_a_string" });
    }
  });

  it(`refuses an endpoint longer than the ${MAX_ENDPOINT_LENGTH}-character column limit, accepts one exactly at it`, () => {
    const prefix = "https://fcm.googleapis.com/fcm/send/";
    const atLimit = prefix + "a".repeat(MAX_ENDPOINT_LENGTH - prefix.length);
    expect(atLimit.length).toBe(MAX_ENDPOINT_LENGTH);
    expect(validatePushEndpoint(atLimit).ok).toBe(true);
    expect(validatePushEndpoint(atLimit + "a")).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("push endpoint policy — parser agreement (the request is made by the legacy url.parse inside web-push)", () => {
  it("for every ACCEPTED endpoint the WHATWG URL and the legacy parser name the same host, protocol and no port", () => {
    for (const endpoint of ALLOWED) {
      const accepted = validatePushEndpoint(endpoint);
      if (!accepted.ok) throw new Error("fixture must be accepted");
      const legacy = legacyUrlParse(accepted.href);
      expect(legacy.hostname).toBe(accepted.hostname);
      expect(legacy.protocol).toBe("https:");
      expect(legacy.port).toBeNull();
      expect(legacy.auth).toBeNull();
    }
  });

  it("fuzz: across thousands of hostile concatenations, whatever is accepted always resolves to an allow-listed host under BOTH parsers", () => {
    const pieces = [
      "https://", "http://", "fcm.googleapis.com", "evil.com", "127.0.0.1", "localhost", "web.push.apple.com",
      "x.notify.windows.com", "@", "\\", "%2f", "%40", "%2e", ":443", ":80", ":", "/", "//", "?", "#", "..", "./",
      "\t", " ", "[::1]", "user:pass", ".", "a", "-", "fcm/send/", "token=abc", "é", "0x7f", "2130706433",
    ];
    // deterministic LCG so a failure is reproducible
    let state = 0x2545f491;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000;
    let accepted = 0;
    for (let i = 0; i < 6000; i++) {
      const count = 1 + Math.floor(next() * 8);
      let candidate = next() < 0.6 ? "https://" : "";
      for (let j = 0; j < count; j++) candidate += pieces[Math.floor(next() * pieces.length)];
      const result = validatePushEndpoint(candidate);
      if (!result.ok) continue;
      accepted++;
      const legacy = legacyUrlParse(result.href);
      const allowed = (h: string | null) => !!h && (PUSH_SERVICE_EXACT_HOSTS.includes(h) || PUSH_SERVICE_HOST_SUFFIXES.some((s) => h.endsWith(s)));
      expect(allowed(result.hostname), JSON.stringify(candidate)).toBe(true);
      expect(legacy.hostname, JSON.stringify(candidate)).toBe(result.hostname);
      expect(legacy.auth, JSON.stringify(candidate)).toBeNull();
    }
    // sanity: the corpus is not vacuous
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("push endpoint policy — mutation fuzz of VALID endpoints", () => {
  it("random single-character and token mutations of real-looking endpoints never yield an accepted URL that the two parsers read differently", () => {
    const insertions = ["@", "\\", "%2f", "%40", "%2e", "..", "//", "#", "?", ":", ":443", ":80", " ", "\t", "\n", "é", ".", "0x7f.", "127.0.0.1", "evil.com", "[::1]", "user:pass@"];
    let state = 0x9e3779b1;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000;
    let accepted = 0;
    let mutated = 0;
    for (let round = 0; round < 3000; round++) {
      let candidate = ALLOWED[Math.floor(next() * ALLOWED.length)]!;
      const mutations = 1 + Math.floor(next() * 3);
      for (let m = 0; m < mutations; m++) {
        const at = Math.floor(next() * (candidate.length + 1));
        const kind = next();
        if (kind < 0.55) candidate = candidate.slice(0, at) + insertions[Math.floor(next() * insertions.length)] + candidate.slice(at);
        else if (kind < 0.8) candidate = candidate.slice(0, at) + candidate.slice(at + 1);
        else candidate = candidate.slice(0, at) + candidate[Math.floor(next() * candidate.length)] + candidate.slice(at);
      }
      mutated++;
      const result = validatePushEndpoint(candidate);
      if (!result.ok) continue;
      accepted++;
      const legacy = legacyUrlParse(result.href);
      const allowedHost = PUSH_SERVICE_EXACT_HOSTS.includes(result.hostname) || PUSH_SERVICE_HOST_SUFFIXES.some((s) => result.hostname.endsWith(s));
      expect(allowedHost, JSON.stringify(candidate)).toBe(true);
      expect(legacy.hostname, JSON.stringify(candidate)).toBe(result.hostname);
      expect(legacy.protocol, JSON.stringify(candidate)).toBe("https:");
      expect(legacy.port, JSON.stringify(candidate)).toBeNull();
      expect(legacy.auth, JSON.stringify(candidate)).toBeNull();
      expect(legacy.hash, JSON.stringify(candidate)).toBeNull();
    }
    expect(mutated).toBe(3000);
    // Plenty of mutations land in the path/query and are legitimately accepted; the point is that none of the
    // accepted ones can point the request anywhere else.
    expect(accepted).toBeGreaterThan(200);
  });
});

describe("push endpoint policy — development/test-only extra hosts", () => {
  it("allows a local mock push service only when the exact host:port is listed", () => {
    const mock = "https://localhost:9443/push/0f6b6a2e-1111-2222-3333-444455556666";
    expect(validatePushEndpoint(mock)).toEqual({ ok: false, reason: "port" });
    expect(validatePushEndpoint(mock, { extraAllowedHosts: ["localhost:9443"] })).toMatchObject({ ok: true, href: mock });
    expect(validatePushEndpoint("https://localhost:9444/x", { extraAllowedHosts: ["localhost:9443"] })).toEqual({ ok: false, reason: "port" });
    expect(validatePushEndpoint("https://evil.com:9443/x", { extraAllowedHosts: ["localhost:9443"] })).toEqual({ ok: false, reason: "port" });
    // http is never allowed, even for an extra host
    expect(validatePushEndpoint("http://localhost:9443/x", { extraAllowedHosts: ["localhost:9443"] })).toEqual({ ok: false, reason: "not_https" });
  });

  it("the environment variable is honoured outside production and IGNORED in production", () => {
    const env = { WEB_PUSH_EXTRA_ALLOWED_HOSTS: " Localhost:9443 , 127.0.0.1:9443 ,, " };
    expect(extraAllowedPushHostsFromEnv({ ...env, NODE_ENV: "development" })).toEqual(["localhost:9443", "127.0.0.1:9443"]);
    expect(extraAllowedPushHostsFromEnv({ ...env, NODE_ENV: "test" })).toEqual(["localhost:9443", "127.0.0.1:9443"]);
    expect(extraAllowedPushHostsFromEnv({ ...env, NODE_ENV: "production" })).toEqual([]);
    expect(extraAllowedPushHostsFromEnv({ NODE_ENV: "development" })).toEqual([]);
  });
});

describe("push key policy", () => {
  it("accepts a real P-256 subscription key pair", () => {
    for (let i = 0; i < 5; i++) {
      const { p256dh, auth } = realKeys();
      expect(validatePushKeys(p256dh, auth)).toEqual({ ok: true });
    }
  });

  it("refuses malformed keys before they can reach web-push (which would throw and look like a transient error)", () => {
    const { p256dh, auth } = realKeys();
    const compressed = createECDH("prime256v1");
    compressed.generateKeys();
    const compressedKey = b64url(compressed.getPublicKey(undefined, "compressed"));

    const bad: Array<[unknown, unknown, string]> = [
      ["p256dh-val", auth, "p256dh_format"],
      [p256dh.slice(0, -1), auth, "p256dh_format"],
      [p256dh + "=", auth, "p256dh_format"],
      [p256dh.replace(/.$/, "+"), auth, "p256dh_format"],
      [compressedKey, auth, "p256dh_format"], // 33-byte compressed point
      [b64url(Buffer.concat([Buffer.from([0x02]), randomBytes(64)])), auth, "p256dh_format"], // wrong prefix byte
      [null, auth, "p256dh_format"],
      [123, auth, "p256dh_format"],
      [p256dh, "auth-val", "auth_format"],
      [p256dh, b64url(randomBytes(32)), "auth_format"],
      [p256dh, b64url(randomBytes(15)), "auth_format"],
      [p256dh, auth + "=", "auth_format"],
      [p256dh, undefined, "auth_format"],
    ];
    for (const [k, a, reason] of bad) {
      expect(validatePushKeys(k, a), `${String(k)?.slice?.(0, 12)} / ${String(a)?.slice?.(0, 12)}`).toEqual({ ok: false, reason });
    }
  });
});

describe("redirects: the sender can never be walked to another host", () => {
  const lib = readFileSync("node_modules/web-push/src/web-push-lib.js", "utf8");

  it("web-push performs exactly one https.request per send and has no redirect handling; a library upgrade that adds any fails here and forces a review", () => {
    expect((lib.match(/https\.request\(/g) ?? []).length).toBe(1);
    expect(lib).not.toMatch(/followRedirect|maxRedirects|\.headers\.location|headers\['location'\]|statusCode\s*(>=|===)\s*30[0-9]/i);
    // any non-2xx (which includes 3xx) rejects instead of being followed
    expect(lib).toMatch(/statusCode < 200 \|\| pushResponse\.statusCode > 299/);
  });

  it("a 301/302/307/308 answer is classified as a permanent failure — never retried, never followed", async () => {
    // classifyPushSendError lives in a server-only module: import it with the guard stubbed.
    const { classifyPushSendError } = await import("@/lib/pwa/web-push-server");
    for (const statusCode of [301, 302, 303, 307, 308]) {
      const outcome = classifyPushSendError(Object.assign(new Error("Received unexpected response code"), { statusCode }));
      expect(outcome).toMatchObject({ outcome: "failed", errorCode: `http_${statusCode}` });
    }
  });
});
