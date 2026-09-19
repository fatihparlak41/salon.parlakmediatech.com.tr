import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GET as authConfirmGet, resolveSafeNext } from "@/app/auth/confirm/route";
import { confirmEmailAction, signInAction, signOutAction, signUpAction } from "@/lib/modules/auth/actions";
import { requestAccountMagicLinkAction } from "@/lib/modules/customer-account/actions";
import LoginPage from "@/app/[locale]/(auth)/login/page";
import SignUpPage from "@/app/[locale]/(auth)/sign-up/page";
import AccountLoginPage from "@/app/[locale]/account/login/page";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Release-review finding F4 — resolveSafeNext, the one guard every auth return
 * path goes through, must be SAFE and IDEMPOTENT.
 *
 * Root cause: it accepted any same-origin result and returned
 * `pathname + search + hash`. After URL normalization that pathname can begin
 * with "//" — through dot segments ("/.//evil.com", "/%2e//evil.com"), through a
 * same-site absolute URL with a double-slash path ("https://<site>//evil.com"),
 * or through slash/backslash mixes — and "//evil.com" used as a redirect target
 * is a protocol-relative, OFF-SITE URL. It was also not idempotent: normalizing
 * "//<site>//evil.com" a second time yields the off-site "//evil.com", so the
 * login chain (page normalizes once, signInAction normalizes again) redirected
 * off-site, and a single-pass sink (the confirm redirect, a forged action field)
 * did so at once.
 *
 * This file pins the fix at three levels: exact hostile payloads, a large
 * generated corpus against explicit invariants (including an INDEPENDENT oracle
 * for percent-encoded equivalents), and every real sink that consumes the guard,
 * driven through the real actions, pages and route handler.
 */

// ---------------------------------------------------------------------------
// Real-sink harness: the same narrow Next seams the other action tests use.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { RedirectSignal, jar: new Map<string, string>(), client: null as unknown };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    has: (name: string) => h.jar.has(name),
    getAll: () => [...h.jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (value === "" || options?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
    delete: (name: string) => {
      h.jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// The pages render through next-intl and the client forms through useTranslations; keys are enough here.
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/i18n/navigation", async () => {
  const { createElement } = await import("react");
  return { Link: ({ href, children }: { href: string; children?: React.ReactNode }) => createElement("a", { href }, children) };
});

const SITE = getSiteUrl();
const SITE_HOST = new URL(SITE).host;
const PROD = "https://salon.parlakmediatech.com.tr";
const PROD_HOST = new URL(PROD).host;
const LOCAL = "http://localhost:3000";

type Outcome = { kind: "returned"; value: unknown } | { kind: "redirected"; url: string };

async function run(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: "returned", value: await fn() };
  } catch (error) {
    if (error instanceof h.RedirectSignal) return { kind: "redirected", url: error.url };
    throw error;
  }
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  h.jar.clear();
  h.client = null;
});

// ---------------------------------------------------------------------------
// Explicit invariants, written independently of the implementation.
// ---------------------------------------------------------------------------

/** "/" or exactly one leading "/" followed by a character that is neither "/" nor "\". */
const isPlainShape = (path: string) => path === "/" || /^\/[^/\\]/.test(path);
const hasRawControl = (value: string) => [...value].some((ch) => ch.charCodeAt(0) <= 0x1f || ch.charCodeAt(0) === 0x7f);
const hasEncodedControl = (value: string) => /%(?:[01][0-9a-f]|7f)/i.test(value);
const hasScheme = (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);

/**
 * INDEPENDENT oracle for "encoded equivalents that normalize into a
 * protocol-relative URL": percent-decode the path repeatedly (as a sloppy
 * intermediary might), drop tab/CR/LF the way the URL parser does, and check the
 * leading characters again at every round. Deliberately shares no code with the
 * implementation.
 */
function decodesToProtocolRelative(pathname: string): boolean {
  let current = pathname;
  for (let round = 0; round < 8; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      next = current.replace(/%(2f|5c|25|09|0a|0d)/gi, (_m, hex: string) => ({ "2f": "/", "5c": "\\", "25": "%", "09": "", "0a": "", "0d": "" })[hex.toLowerCase()]!);
    }
    if (!isPlainShape(next.replace(/[\t\n\r]/g, ""))) return true;
    if (next === current) return false;
    current = next;
  }
  return false;
}

function assertSafeResult(input: string, result: string, origin: string) {
  const label = `resolveSafeNext(${JSON.stringify(input)}, ${origin}) = ${JSON.stringify(result)}`;
  expect(isPlainShape(result), `${label}: must be "/" or one leading "/" then a non-slash, non-backslash`).toBe(true);
  expect(result.startsWith("//") || result.startsWith("/\\"), label).toBe(false);
  expect(hasScheme(result), `${label}: must not be absolute`).toBe(false);
  expect(new URL(result, origin).origin, `${label}: must stay on the origin`).toBe(origin);
  expect(hasRawControl(result) || hasEncodedControl(result), `${label}: no control characters, raw or encoded`).toBe(false);
  expect(decodesToProtocolRelative(new URL(result, origin).pathname), `${label}: no encoded equivalent of a protocol-relative URL`).toBe(false);
  expect(resolveSafeNext(result, origin), `${label}: feeding it back must not change it`).toBe(result);
}

// ---------------------------------------------------------------------------
// The exact hostile payloads.
// ---------------------------------------------------------------------------

const F4_LITERAL = "/.////evil.com"; // exactly as written in the F4 fix request
const F4_PROVEN = (host: string) => `/.//${host}//evil.com`; // the payload the release review proved, with the site's host

const hostilePayloads = (host: string): ReadonlyArray<readonly [string, string]> => [
  ["F4 as written in the fix request", F4_LITERAL],
  ["F4 as proven by the release review (with this site's host)", F4_PROVEN(host)],
  ["dot-segment protocol-relative", "/.//evil.com"],
  ["dot-segment protocol-relative (..)", "/..//evil.com"],
  ["dot-segment behind a real segment", "/a/..//evil.com"],
  ["dot-segment behind a real segment, with the host", `/a/..//${host}//evil.com`],
  ["encoded dot segment", "/%2e//evil.com"],
  ["encoded double-dot segment", "/%2e%2e//evil.com"],
  ["upper-case encoded dot segments", "/%2E/%2E//evil.com"],
  ["mixed encoded dot segment", "/.%2e//evil.com"],
  ["protocol-relative", "//evil.com"],
  ["triple slash", "///evil.com"],
  ["quadruple slash", "////evil.com"],
  ["backslash host", "/\\evil.com"],
  ["leading backslash", "\\/evil.com"],
  ["double backslash", "\\\\evil.com"],
  ["slash slash backslash", "//\\evil.com"],
  ["mixed slash/backslash", "/\\/evil.com"],
  ["mixed slash/backslash (2)", "/\\\\evil.com"],
  ["dot then backslash", "/./\\evil.com"],
  ["dot backslash slash", "/.\\/evil.com"],
  ["absolute https", "https://evil.com"],
  ["absolute http", "http://evil.com"],
  ["javascript:", "javascript:alert(1)"],
  ["data:", "data:text/html,<script>alert(1)</script>"],
  ["encoded slashes", "/%2f%2fevil.com"],
  ["encoded slashes (upper case)", "/%2F%2Fevil.com"],
  ["encoded backslashes", "/%5c%5cevil.com"],
  ["encoded backslashes (upper case)", "/%5C%5Cevil.com"],
  ["double-encoded slashes", "/%252f%252fevil.com"],
  ["triple-encoded slashes", "/%25252f%25252fevil.com"],
  ["one encoded slash after the first", "/%2f/evil.com"],
  ["one encoded backslash", "/%5cevil.com"],
  ["encoded tab", "/%09/evil.com"],
  ["encoded LF", "/%0a/evil.com"],
  ["encoded CR", "/%0d/evil.com"],
  ["encoded CRLF", "/%0d%0a//evil.com"],
  ["encoded CRLF (upper case)", "/%0D%0A//evil.com"],
  ["encoded CRLF header injection", "/%0d%0aLocation:%20https://evil.com"],
  ["encoded CRLF in the query", "/x?a=%0d%0a"],
  ["encoded tab in the fragment", "/x#%09"],
  ["encoded NUL", "/%00"],
  ["raw tab", "/\t/evil.com"],
  ["raw LF", "/\n/evil.com"],
  ["raw CR", "/\r/evil.com"],
  ["raw CRLF", "/\r\n/evil.com"],
  ["raw CRLF header injection", "/\r\nSet-Cookie: a=b"],
  ["raw tab inside a path", "/a\tb"],
  ["raw NUL", "/" + String.fromCharCode(0)],
  ["userinfo host trick", `https://${host}@evil.com/x`],
  ["backslash userinfo trick", `https://evil.com\\@${host}/`],
  ["protocol-relative userinfo", `//${host}@evil.com`],
  ["look-alike suffix host", `https://${host}.evil.com/`],
  ["host in the fragment", `https://evil.com#@${host}`],
  ["host in the query", `https://evil.com?@${host}`],
  ["credentials", "https://user:pass@evil.com"],
  ["IPv6 host", "http://[::1]"],
  ["hex IP host", "http://0x7f000001"],
  ["decimal IP host", "http://2130706433"],
  ["same-site absolute URL with a double-slash path", `https://${host}//evil.com`],
  ["same-site protocol-relative URL with a double-slash path", `//${host}//evil.com`],
  ["same-site dot-segment", `https://${host}/.//evil.com`],
  ["same-site backslashes", `https://${host}\\\\evil.com`],
];

const originsUnderTest: ReadonlyArray<readonly [string, string]> = [
  [PROD, PROD_HOST],
  [LOCAL, new URL(LOCAL).host],
  [SITE, SITE_HOST],
];

describe("resolveSafeNext: every hostile payload falls back to /", () => {
  for (const [origin, host] of originsUnderTest) {
    it.each(hostilePayloads(host))(`[${origin}] %s`, (_label, input) => {
      const result = resolveSafeNext(input, origin);
      expect(result).toBe("/");
      assertSafeResult(input, result, origin);
      expect(resolveSafeNext(resolveSafeNext(input, origin), origin)).toBe(resolveSafeNext(input, origin));
    });
  }

  it("non-string input can never be turned into a path", () => {
    for (const value of [undefined, null, 0, 1, true, {}, [], ["/x"], Symbol.iterator]) {
      expect(resolveSafeNext(value as never, PROD)).toBe("/");
    }
  });

  it("an unusable origin fails closed", () => {
    for (const badOrigin of ["", "not a url", "https://", "salon.parlakmediatech.com.tr"]) {
      expect(resolveSafeNext("/x", badOrigin)).toBe("/");
      expect(resolveSafeNext("https://evil.com", badOrigin)).toBe("/");
    }
  });
});

describe("resolveSafeNext: legitimate internal routes are untouched", () => {
  const legitimate: ReadonlyArray<readonly [string, string]> = [
    ["/", "/"],
    ["", "/"],
    ["/login", "/login"],
    ["/accept-invite", "/accept-invite"],
    ["/app", "/app"],
    ["/app/", "/app/"],
    ["/app//team", "/app//team"],
    ["/app/some-salon/team", "/app/some-salon/team"],
    ["/account", "/account"],
    ["/account/", "/account/"],
    ["/account/claim/complete/0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0", "/account/claim/complete/0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0"],
    ["/account/link-salon/some-salon", "/account/link-salon/some-salon"],
    ["/account/appointments?tab=upcoming#next", "/account/appointments?tab=upcoming#next"],
    ["/login?next=%2Faccept-invite", "/login?next=%2Faccept-invite"],
    ["/x//y", "/x//y"],
    ["not-a-real-path", "/not-a-real-path"],
    ["/a%20b", "/a%20b"],
    ["/caf%C3%A9", "/caf%C3%A9"],
    ["/a%2Fb", "/a%2Fb"],
    ["/x?q=100%25", "/x?q=100%25"],
    ["/x?next=//evil.com", "/x?next=//evil.com"],
    ["/x#//evil.com", "/x#//evil.com"],
  ];

  for (const [origin, host] of [
    [PROD, PROD_HOST],
    [LOCAL, new URL(LOCAL).host],
  ] as const) {
    it.each(legitimate)(`[${origin}] %s -> %s`, (input, expected) => {
      expect(resolveSafeNext(input, origin)).toBe(expected);
    });

    it(`[${origin}] a same-site absolute or protocol-relative URL resolves to its own path`, () => {
      expect(resolveSafeNext(`${origin}/accept-invite`, origin)).toBe("/accept-invite");
      expect(resolveSafeNext(`//${host}/accept-invite`, origin)).toBe("/accept-invite");
      expect(resolveSafeNext(`${origin}/account/claim/complete/abc?x=1#y`, origin)).toBe("/account/claim/complete/abc?x=1#y");
    });
  }
});

// ---------------------------------------------------------------------------
// Property test: a large generated corpus against the explicit invariants.
// ---------------------------------------------------------------------------

/** The guard exactly as it was in 747ea33 — kept ONLY as a reference: it proves the corpus reaches the dangerous class and that the fix changes nothing else. */
function legacyResolveSafeNext(next: string, origin: string): string {
  try {
    const resolved = new URL(next, origin);
    return resolved.origin === origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : "/";
  } catch {
    return "/";
  }
}

describe("resolveSafeNext: property test over a generated corpus", () => {
  // Deterministic PRNG (mulberry32) so any failure is reproducible.
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const fragments = [
    "/", "//", "///", "////", "\\", "\\\\", "/\\", "\\/", ".", "..", "...", "./", "../", "/.", "/..",
    "%2e", "%2E", "%2e%2e", "%2f", "%2F", "%5c", "%5C", "%09", "%0a", "%0d", "%0D%0A", "%25", "%252f", "%25252f", "%00", "%", "%zz", "%E2%80%A8", "%1f", "%7f", "%20",
    "\t", "\n", "\r", " ", String.fromCharCode(0), String.fromCharCode(0x1f), String.fromCharCode(0x7f), String.fromCharCode(0x2028), "@", ":", "?", "#", "&", "=", ";", "'", '"', "<", ">", "{", "}", "|", "^", "`",
    "evil.com", "evil.example", PROD_HOST, `${PROD_HOST}.evil.com`, "localhost:3000", "http:", "https:", "javascript:", "data:", "mailto:", "vbscript:", "file:", "blob:",
    "accept-invite", "account", "app", "login", "x", "a", "0", "∕", "／", "．", "。", "․", "‥", "é", "😀", "[", "]", "::1", "127.0.0.1", "0x7f000001", "2130706433",
    "?next=", "#/", "&next=//", "/%2f", "/%5c",
  ];
  const generate = () => {
    const count = 1 + Math.floor(random() * 9);
    let out = random() < 0.5 ? "/" : random() < 0.3 ? "" : fragments[Math.floor(random() * fragments.length)]!;
    for (let i = 0; i < count; i++) out += fragments[Math.floor(random() * fragments.length)]!;
    return out;
  };

  it("120,000 generated inputs: always a plain same-site path, never encoded-equivalent, stable when applied again", () => {
    const origins = [PROD, LOCAL, "https://example.com"];
    let legacyUnsafeAtOnePass = 0;
    let legacyNotIdempotent = 0;
    let changedWhereLegacyWasSafe = 0;
    let fellBackToRoot = 0;

    for (let n = 0; n < 120000; n++) {
      const input = generate();
      const origin = origins[n % origins.length]!;
      const result = resolveSafeNext(input, origin);

      // 1. "/" or exactly one leading "/" then a non-slash/non-backslash character
      if (!isPlainShape(result)) throw new Error(`not a plain path: ${JSON.stringify(input)} -> ${JSON.stringify(result)} (${origin})`);
      // 2. never //, /\ or ///  (implied by 1, asserted separately so a failure names it)
      if (result.startsWith("//") || result.startsWith("/\\")) throw new Error(`protocol-relative result: ${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
      // 3. repeated application is stable
      if (resolveSafeNext(result, origin) !== result) throw new Error(`not idempotent: ${JSON.stringify(input)} -> ${JSON.stringify(result)} -> ${JSON.stringify(resolveSafeNext(result, origin))}`);
      // 4. never absolute / external, on the origin, no control characters (raw or encoded), no encoded equivalent
      if (hasScheme(result) || new URL(result, origin).origin !== origin) throw new Error(`external result: ${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
      if (hasRawControl(result) || hasEncodedControl(result)) throw new Error(`control character in result: ${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
      if (decodesToProtocolRelative(new URL(result, origin).pathname)) throw new Error(`encoded protocol-relative result: ${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
      if (result === "/") fellBackToRoot++;

      // Reference behavior (747ea33): how often was it unsafe, and does the fix change anything it handled safely?
      const legacy = legacyResolveSafeNext(input, origin);
      if (!isPlainShape(legacy)) legacyUnsafeAtOnePass++;
      if (legacyResolveSafeNext(legacy, origin) !== legacy) legacyNotIdempotent++;
      const hasControl = hasRawControl(input) || hasEncodedControl(legacy); // control characters are deliberately fail-closed now
      if (
        !hasControl &&
        result !== legacy &&
        isPlainShape(legacy) &&
        legacyResolveSafeNext(legacy, origin) === legacy &&
        !decodesToProtocolRelative(new URL(legacy, origin).pathname)
      ) {
        changedWhereLegacyWasSafe++;
      }
    }

    // The corpus reaches the dangerous class (otherwise this proves nothing)...
    expect(legacyUnsafeAtOnePass).toBeGreaterThan(300);
    expect(legacyNotIdempotent).toBeGreaterThan(300);
    // ...and the fix changes nothing the old guard handled safely: no legitimate route is affected.
    expect(changedWhereLegacyWasSafe).toBe(0);
    // ...while still accepting plenty of real paths (it is not simply returning "/" for everything).
    expect(fellBackToRoot).toBeLessThan(120000 * 0.9);
  });

  it("idempotency holds even when the two passes use different origins (the GET route uses the request origin, the actions use the site URL)", () => {
    for (let n = 0; n < 20000; n++) {
      const input = generate();
      const first = resolveSafeNext(input, PROD);
      expect(resolveSafeNext(first, LOCAL), JSON.stringify(input)).toBe(first);
      expect(isPlainShape(resolveSafeNext(first, "https://example.com"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Every real sink, driven through the real actions, pages and route handler.
// ---------------------------------------------------------------------------

/** What a browser would submit for the hidden `next` field the page rendered (null when the page rendered none). */
function hiddenNext(html: string): string | null {
  const match = /<input[^>]*type="hidden"[^>]*name="next"[^>]*value="([^"]*)"/.exec(html);
  if (!match) return null;
  return match[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

/** Every href on the page, resolved against the site. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

const pageProps = (next: string) => ({ params: Promise.resolve({ locale: "tr" }), searchParams: Promise.resolve({ next }) }) as never;

const sinkPayloads: ReadonlyArray<readonly [string, string]> = [
  ["F4 as written in the fix request", F4_LITERAL],
  ["F4 as proven by the release review", F4_PROVEN(SITE_HOST)],
  ["dot-segment protocol-relative", "/.//evil.com"],
  ["same-site absolute URL with a double-slash path", `${SITE}//evil.com`],
  ["protocol-relative", "//evil.com"],
  ["triple slash", "///evil.com"],
  ["backslash host", "/\\evil.com"],
  ["absolute https", "https://evil.com"],
  ["javascript:", "javascript:alert(1)"],
  ["encoded slashes", "/%2f%2fevil.com"],
  ["encoded CRLF", "/%0d%0a//evil.com"],
  ["raw CRLF", "/\r\n/evil.com"],
  ["userinfo trick", `https://${SITE_HOST}@evil.com/`],
];

/** A destination is only acceptable if it is a plain same-site path. */
function expectOnSite(destination: string) {
  expect(isPlainShape(destination), destination).toBe(true);
  expect(new URL(destination, SITE).origin, destination).toBe(SITE);
}

describe("real sink: signInAction (the post-login redirect)", () => {
  const install = () => {
    const signInWithPassword = vi.fn(async () => ({ error: null }));
    h.client = { auth: { signInWithPassword } };
    return signInWithPassword;
  };
  const credentials = { email: "person@example.com", password: "Passw0rd!x" };

  it.each(sinkPayloads)("a forged hidden field (%s) stays on-site", async (_label, next) => {
    install();
    const outcome = await run(() => signInAction(null, form({ ...credentials, next })));
    expect(outcome).toEqual({ kind: "redirected", url: "/" });
  });

  it.each(sinkPayloads)("the page -> action chain for /login?next=%s stays on-site", async (_label, raw) => {
    install();
    // What the visitor's browser gets from /login?next=<raw> ...
    const html = renderToStaticMarkup(await LoginPage(pageProps(raw)));
    const submitted = hiddenNext(html);
    // ... and what it then submits to signInAction.
    const outcome = await run(() => signInAction(null, form({ ...credentials, ...(submitted ? { next: submitted } : {}) })));

    expect(outcome.kind).toBe("redirected");
    if (outcome.kind === "redirected") {
      expectOnSite(outcome.url);
      expect(outcome.url).toBe("/");
    }
    // The page must not turn the hostile value into a link either.
    for (const href of hrefs(html)) expect(new URL(href, SITE).origin, href).toBe(SITE);
  });

  it("the exact F4 chain: /login?next=/.//<site-host>//evil.com no longer reaches //evil.com", async () => {
    install();
    const html = renderToStaticMarkup(await LoginPage(pageProps(F4_PROVEN(SITE_HOST))));
    expect(hiddenNext(html)).toBeNull(); // dropped by the page: it normalizes to "/"
    const outcome = await run(() => signInAction(null, form({ ...credentials })));
    expect(outcome).toEqual({ kind: "redirected", url: "/" });
  });

  it.each(["/accept-invite", "/app//team", "/account/claim/complete/0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0?x=1#y", "/account", "/login?next=%2Faccept-invite"])(
    "a legitimate return path %s still works, end to end",
    async (raw) => {
      install();
      const html = renderToStaticMarkup(await LoginPage(pageProps(raw)));
      expect(hiddenNext(html)).toBe(raw);
      const outcome = await run(() => signInAction(null, form({ ...credentials, next: hiddenNext(html)! })));
      expect(outcome).toEqual({ kind: "redirected", url: raw });
    },
  );
});

describe("real sink: signOutAction", () => {
  const install = () => {
    const signOut = vi.fn(async () => ({ error: null }));
    h.client = { auth: { signOut } };
    return signOut;
  };

  it.each(sinkPayloads)("a forged next (%s) stays on-site", async (_label, next) => {
    const signOut = install();
    const outcome = await run(() => signOutAction(form({ next })));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "redirected", url: "/" });
  });

  it("the sign-out forms that send no next, or /accept-invite, behave exactly as before", async () => {
    install();
    expect(await run(() => signOutAction())).toEqual({ kind: "redirected", url: "/" });
    expect(await run(() => signOutAction(form({ next: "/accept-invite" })))).toEqual({ kind: "redirected", url: "/accept-invite" });
  });
});

describe("real sink: signUpAction (emailRedirectTo and the stored hint)", () => {
  const install = () => {
    const signUp = vi.fn(async () => ({ error: null }));
    h.client = { auth: { signUp } };
    return signUp;
  };
  const details = { fullName: "Test Kişi", email: "person@example.com", password: "Passw0rd!x" };
  const sentOptions = (signUp: ReturnType<typeof install>) => (signUp.mock.calls[0] as unknown as [{ options: { emailRedirectTo: string; data: Record<string, unknown> } }])[0].options;

  it.each(sinkPayloads)("a forged next (%s) yields the bare site URL and no stored hint", async (_label, next) => {
    const signUp = install();
    await run(() => signUpAction(null, form({ ...details, next })));
    const { emailRedirectTo, data } = sentOptions(signUp);
    expect(emailRedirectTo).toBe(SITE);
    expect(data).toEqual({ full_name: details.fullName });
  });

  it.each(sinkPayloads)("the page -> action chain for /sign-up?next=%s stays on-site", async (_label, raw) => {
    const signUp = install();
    const html = renderToStaticMarkup(await SignUpPage(pageProps(raw)));
    const submitted = hiddenNext(html);
    await run(() => signUpAction(null, form({ ...details, ...(submitted ? { next: submitted } : {}) })));
    const { emailRedirectTo, data } = sentOptions(signUp);
    expect(emailRedirectTo).toBe(SITE);
    expect(data).toEqual({ full_name: details.fullName });
    for (const href of hrefs(html)) expect(new URL(href, SITE).origin, href).toBe(SITE);
  });

  it("the invitation return path still works: redirect to /accept-invite and the allowlisted hint", async () => {
    const signUp = install();
    await run(() => signUpAction(null, form({ ...details, next: "/accept-invite" })));
    const { emailRedirectTo, data } = sentOptions(signUp);
    expect(emailRedirectTo).toBe(`${SITE}/accept-invite`);
    expect(data).toEqual({ full_name: details.fullName, post_confirm_next: "/accept-invite" });
  });
});

describe("real sink: /auth/confirm GET -> confirmEmailAction (the post-confirmation redirect)", () => {
  const install = (userMetadata: Record<string, unknown> = {}) => {
    h.client = { auth: { verifyOtp: vi.fn(async () => ({ data: { user: { user_metadata: userMetadata }, session: {} }, error: null })) } };
  };
  const confirmVia = async (type: string, rawNext: string, userMetadata: Record<string, unknown> = {}) => {
    install(userMetadata);
    const response = await authConfirmGet(new Request(`${SITE}/auth/confirm?token_hash=hash-for-tests&type=${type}&next=${encodeURIComponent(rawNext)}`));
    expect(new URL(response.headers.get("location")!).pathname).toBe("/confirm-email");
    return run(() => confirmEmailAction());
  };

  it.each(sinkPayloads)("a crafted confirmation link (%s) lands on-site, for every confirmation type", async (_label, raw) => {
    for (const type of ["signup", "magiclink", "recovery", "email_change", "invite", "email"]) {
      h.jar.clear();
      expect(await confirmVia(type, raw), `${type} ${raw}`).toEqual({ kind: "redirected", url: "/" });
    }
  });

  it("the route stores only a plain path in the pending-confirmation cookie", async () => {
    for (const [, raw] of sinkPayloads) {
      h.jar.clear();
      await authConfirmGet(new Request(`${SITE}/auth/confirm?token_hash=hash-for-tests&type=signup&next=${encodeURIComponent(raw)}`));
      const stored = JSON.parse(h.jar.get("sb-pending-email-confirmation")!) as { next: string };
      expect(isPlainShape(stored.next), stored.next).toBe(true);
    }
  });

  it("an invited sign-up whose link carries a hostile next still returns to /accept-invite", async () => {
    const hinted = { full_name: "Kişi", post_confirm_next: "/accept-invite" };
    expect(await confirmVia("signup", F4_PROVEN(SITE_HOST), hinted)).toEqual({ kind: "redirected", url: "/accept-invite" });
    h.jar.clear();
    expect(await confirmVia("signup", F4_LITERAL, hinted)).toEqual({ kind: "redirected", url: "/accept-invite" });
  });

  it.each(["/account", "/account/claim/complete/0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0", "/app//team", "/accept-invite"])(
    "a legitimate destination %s in the link is still followed",
    async (raw) => {
      expect(await confirmVia("magiclink", raw)).toEqual({ kind: "redirected", url: raw });
    },
  );
});

describe("real sink: the customer magic link (page -> requestAccountMagicLinkAction -> /auth/confirm -> confirmEmailAction)", () => {
  const request = async (submitted: string | null) => {
    const signInWithOtp = vi.fn(async () => ({ data: {}, error: null }));
    h.client = { auth: { signInWithOtp } };
    await run(() => requestAccountMagicLinkAction(null, form({ email: "musteri@example.com", ...(submitted ? { next: submitted } : {}) })));
    return (signInWithOtp.mock.calls[0] as unknown as [{ options: { emailRedirectTo: string } }])[0].options.emailRedirectTo;
  };

  it.each(sinkPayloads)("a hostile /account/login?next (%s) never reaches the emailed redirect or the confirmation destination", async (_label, raw) => {
    const html = renderToStaticMarkup(await AccountLoginPage(pageProps(raw)));
    const emailRedirectTo = await request(hiddenNext(html));

    const url = new URL(emailRedirectTo);
    expect(url.origin).toBe(SITE);
    expect(url.pathname).toBe("/auth/confirm");
    expect(isPlainShape(url.searchParams.get("next")!)).toBe(true);

    // The customer clicks the emailed link.
    h.jar.clear();
    h.client = { auth: { verifyOtp: vi.fn(async () => ({ data: { user: { user_metadata: {} }, session: {} }, error: null })) } };
    await authConfirmGet(new Request(`${SITE}/auth/confirm?token_hash=hash-for-tests&type=magiclink&next=${encodeURIComponent(url.searchParams.get("next")!)}`));
    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/" });
  });

  it("a forged next posted straight to the action is neutralized too", async () => {
    for (const [, raw] of sinkPayloads) {
      const emailRedirectTo = await request(raw);
      expect(emailRedirectTo).toBe(`${SITE}/auth/confirm?next=%2F`);
    }
  });

  it("the customer's own destinations survive the whole chain", async () => {
    const claim = "/account/claim/complete/0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";
    const html = renderToStaticMarkup(await AccountLoginPage(pageProps(claim)));
    expect(hiddenNext(html)).toBe(claim);
    const emailRedirectTo = await request(hiddenNext(html));
    expect(emailRedirectTo).toBe(`${SITE}/auth/confirm?next=${encodeURIComponent(claim)}`);
  });
});
