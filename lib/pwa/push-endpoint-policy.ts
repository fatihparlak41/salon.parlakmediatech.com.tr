/**
 * Faz ACCOUNT.1 (security) — what a Web Push subscription is allowed to
 * look like before this server will store it or POST anything to it.
 *
 * WHY THIS EXISTS. A push subscription's `endpoint` is a URL chosen by the
 * CLIENT, and this server later performs an HTTPS POST to it (the manual
 * test-send and every automatic delivery). Until this module existed the
 * database accepted any string, so any signed-in member could register an
 * arbitrary https URL and make the server call it: a server-side request
 * forgery surface. Real endpoints only ever come from the browser vendors'
 * own push services, so the policy is a short ALLOW-LIST of those hosts —
 * everything else is refused before any network I/O.
 *
 * This file is deliberately pure (no Node-only API, no I/O) so the same
 * rules run in the Server Action that stores a subscription, in the sender
 * that posts to it, and in unit tests.
 *
 * WHAT IS REJECTED, AND WHY
 *   - not a string, empty, longer than the column's 1024 characters
 *   - anything but visible ASCII: whitespace, control characters (the WHATWG
 *     parser silently strips tab/newline), non-ASCII, backslashes (parsers
 *     disagree about them) — the accepted set is small enough that the
 *     legacy `url.parse` used inside the `web-push` package and the WHATWG
 *     `URL` used here cannot disagree about the host
 *   - any scheme but lower-case `https://`
 *   - credentials (`user:pass@host`), any port but 443, a fragment
 *   - IP literals in every spelling (dotted, decimal, hex, octal, IPv6) and
 *     single-label / internal names (`localhost`, `intranet`, `x.local`)
 *   - every host that is not exactly a listed vendor host, or a sub-domain
 *     of a listed vendor SUFFIX. Google hosts are matched EXACTLY on
 *     purpose: `*.googleapis.com` also contains user-content hosts such as
 *     `storage.googleapis.com`, which would let a member point the server at
 *     a server they control.
 *   - redirects are not a case here: the `web-push` package performs one
 *     `https.request` per send and treats any non-2xx (including 3xx) as an
 *     error; it never follows `Location`. A test pins that property.
 *
 * DEVELOPMENT/TEST ONLY: `extraAllowedHosts` (fed from
 * WEB_PUSH_EXTRA_ALLOWED_HOSTS, ignored when NODE_ENV is "production") lets a
 * local mock push service on `host:port` be used in browser tests.
 */

/** Hosts that are exactly the vendor's push service. */
export const PUSH_SERVICE_EXACT_HOSTS: readonly string[] = [
  "fcm.googleapis.com", // Chrome, Chromium-based browsers, Opera, Brave, Samsung Internet
  "android.googleapis.com", // legacy GCM endpoints (older Chrome subscriptions)
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari (macOS, iOS/iPadOS 16.4+ Home Screen apps)
];

/** Dot-boundary suffixes owned by a single vendor's push service. */
export const PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = [
  ".notify.windows.com", // Microsoft Edge (Windows Notification Service)
];

export const MAX_ENDPOINT_LENGTH = 1024;

export type PushEndpointRejection =
  | "not_a_string"
  | "empty"
  | "too_long"
  | "unsafe_characters"
  | "not_https"
  | "credentials"
  | "port"
  | "fragment"
  | "invalid_url"
  | "ip_literal"
  | "host_not_allowed";

export type PushEndpointCheck =
  | { ok: true; href: string; hostname: string }
  | { ok: false; reason: PushEndpointRejection };

export type PushEndpointPolicyOptions = {
  /** `host` or `host:port` entries, lower-case. Development/test only. */
  extraAllowedHosts?: readonly string[];
};

const VISIBLE_ASCII_NO_BACKSLASH = /^[\x21-\x5b\x5d-\x7e]+$/;
// Authority = what sits between "https://" and the first "/", "?" or "#".
const PLAIN_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function looksLikeIpAddress(hostname: string): boolean {
  const labels = hostname.split(".");
  const last = labels[labels.length - 1] ?? "";
  // 127.0.0.1, 2130706433 (single decimal), 0x7f.1, 017700000001, 1.2.3 — a
  // numeric or 0x-prefixed final label is an IPv4 spelling to every parser.
  return /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/i.test(last) || labels.every((l) => /^[0-9]+$/.test(l));
}

function hostAllowed(hostname: string): boolean {
  if (PUSH_SERVICE_EXACT_HOSTS.includes(hostname)) return true;
  return PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length);
}

/**
 * Decides whether `endpoint` may be stored / posted to. On success returns
 * the canonical href (identical to the input by construction — the input is
 * only accepted when it is already canonical) that callers must use for the
 * request, never the original string.
 */
export function validatePushEndpoint(endpoint: unknown, options: PushEndpointPolicyOptions = {}): PushEndpointCheck {
  if (typeof endpoint !== "string") return { ok: false, reason: "not_a_string" };
  if (endpoint.length === 0) return { ok: false, reason: "empty" };
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return { ok: false, reason: "too_long" };
  if (!VISIBLE_ASCII_NO_BACKSLASH.test(endpoint)) return { ok: false, reason: "unsafe_characters" };
  if (!endpoint.startsWith("https://")) return { ok: false, reason: "not_https" };

  const afterScheme = endpoint.slice("https://".length);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority.includes("@")) return { ok: false, reason: "credentials" };
  if (authority.startsWith("[")) return { ok: false, reason: "ip_literal" }; // IPv6 literal
  if (endpoint.includes("#")) return { ok: false, reason: "fragment" };

  const extra = (options.extraAllowedHosts ?? []).map((h) => h.toLowerCase());
  const isExtraHost = extra.includes(authority);

  const [host, port, ...rest] = authority.split(":");
  if (rest.length > 0 || host === undefined || host === "") return { ok: false, reason: "invalid_url" };
  if (port !== undefined && port !== "443" && !isExtraHost) return { ok: false, reason: "port" };
  if (port === "") return { ok: false, reason: "port" };

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  if (url.hash !== "") return { ok: false, reason: "fragment" };

  if (isExtraHost) {
    if (url.href !== endpoint) return { ok: false, reason: "invalid_url" };
    return { ok: true, href: url.href, hostname: url.hostname };
  }

  if (url.port !== "") return { ok: false, reason: "port" };
  if (!PLAIN_HOST.test(host)) return { ok: false, reason: looksLikeIpAddress(host) ? "ip_literal" : "host_not_allowed" };
  if (looksLikeIpAddress(host)) return { ok: false, reason: "ip_literal" };
  if (url.hostname !== host) return { ok: false, reason: "invalid_url" };
  if (!hostAllowed(host)) return { ok: false, reason: "host_not_allowed" };
  // The input must already be in the parser's canonical form (default port
  // dropped, host lower-cased, no dot-segments collapsed behind our back).
  const canonical = url.href;
  const withoutDefaultPort = endpoint.replace(`${host}:443`, host);
  if (canonical !== withoutDefaultPort) return { ok: false, reason: "invalid_url" };
  return { ok: true, href: canonical, hostname: url.hostname };
}

// ---------------------------------------------------------------- keys

export type PushKeysRejection = "p256dh_format" | "auth_format";

export type PushKeysCheck = { ok: true } | { ok: false; reason: PushKeysRejection };

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * A real subscription carries an uncompressed P-256 public key (65 bytes,
 * first byte 0x04) and a 16-byte auth secret, both base64url without
 * padding — exactly what lib/pwa/push-subscription.ts sends. Anything else
 * would make `web-push` throw inside the sender and be mistaken for a
 * transient network error (retried for hours), so it is refused up front.
 */
export function validatePushKeys(p256dh: unknown, authKey: unknown): PushKeysCheck {
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(p256dh)) return { ok: false, reason: "p256dh_format" };
  const point = base64UrlToBytes(p256dh);
  if (!point || point.length !== 65 || point[0] !== 0x04) return { ok: false, reason: "p256dh_format" };
  if (typeof authKey !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(authKey)) return { ok: false, reason: "auth_format" };
  const secret = base64UrlToBytes(authKey);
  if (!secret || secret.length !== 16) return { ok: false, reason: "auth_format" };
  return { ok: true };
}

// ------------------------------------------------------- policy from env

/**
 * Extra `host[:port]` entries for LOCAL browser tests (a mock push service
 * on localhost). Never honoured in production: a deployed environment can
 * only add a push service by changing the constants above, in a reviewed
 * commit.
 */
export function extraAllowedPushHostsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.NODE_ENV === "production") return [];
  return (env.WEB_PUSH_EXTRA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}
