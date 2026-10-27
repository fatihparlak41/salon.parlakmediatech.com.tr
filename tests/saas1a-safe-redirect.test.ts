import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPlainSitePath, resolveSafeNext } from "@/lib/auth/safe-redirect";

/**
 * Faz SAAS.1A — the ONE redirect sanitizer (lib/auth/safe-redirect.ts) and the two route handlers that
 * use it. IDs SR1-SR9.
 *
 * What must hold, for every input: the result is "/" or a plain same-site path (exactly one leading "/",
 * never "//", never "/\"), has no control character (raw or percent-encoded), stays on the site's origin
 * when resolved, and applying the function to its own result changes nothing.
 */

const ORIGIN = "https://salon.example.test";

// A SECOND, independent statement of the guarantee. It deliberately does not reuse any helper of the code under test.
function satisfiesGuarantee(result: string): boolean {
  if (result === "/") return true;
  if (!result.startsWith("/")) return false;
  if (result.startsWith("//") || result.startsWith("/\\")) return false;
  for (const ch of result) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  if (/%(?:[01][0-9a-f]|7f)/i.test(result)) return false;
  let resolved: URL;
  try {
    resolved = new URL(result, ORIGIN);
  } catch {
    return false;
  }
  return resolved.origin === ORIGIN && !resolved.pathname.startsWith("//");
}

describe("SR1 hostile payloads collapse to /", () => {
  const hostile = [
    "//evil.example",
    "///evil.example",
    "////evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "\\/evil.example",
    "/\\/evil.example",
    "https://evil.example",
    "http://evil.example/path",
    "HTTPS://EVIL.EXAMPLE",
    "https://evil.example@salon.example.test",
    "https://salon.example.test@evil.example",
    "//salon.example.test@evil.example",
    "https://salon.example.test.evil.example/",
    "https://salon.example.test:8443/x",
    "http://salon.example.test/x",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "\tjavascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://evil.example/x",
    "mailto:a@b.c",
    "tel:+900000000000",
    "/.//evil.example",
    "/%2e//evil.example",
    "/./\\evil.example",
    "https://salon.example.test//evil.example",
    "/%2f/evil.example",
    "/%2F/evil.example",
    "/%5cevil.example",
    "/%5Cevil.example",
    "/%252f%252fevil.example",
    "/%255cevil.example",
    "/%25252fevil.example",
    "/\t/evil.example",
    "/%09/evil.example",
    "/\n/evil.example",
    "/%0a/evil.example",
    "/%0d%0aSet-Cookie:x=1",
    "/ok\r\nLocation: https://evil.example",
    "/ok%0d%0aLocation:%20https://evil.example",
    "/ok\u0000",
    "/ok%00",
    "/ok\u007f",
    "/ok%7f",
    "/\u001b[31m",
    "",
    "   ",
    "javascript://salon.example.test/%0aalert(1)",
  ];
  it.each(hostile)("%j -> /", (input) => {
    expect(resolveSafeNext(input, ORIGIN)).toBe("/");
  });
});

describe("SR2 ordinary same-site targets survive exactly", () => {
  const benign: [string, string][] = [
    ["/", "/"],
    ["/accept-invite", "/accept-invite"],
    ["/app/emel-beauty-bar/team", "/app/emel-beauty-bar/team"],
    ["/account?tab=appointments", "/account?tab=appointments"],
    ["/book/emel-beauty-bar#services", "/book/emel-beauty-bar#services"],
    ["/a/b?c=d&e=f#g", "/a/b?c=d&e=f#g"],
    ["/%C5%9Falon", "/%C5%9Falon"],
    ["https://salon.example.test/accept-invite", "/accept-invite"],
    ["https://salon.example.test/x?y=1#z", "/x?y=1#z"],
    ["/path with space", "/path%20with%20space"],
    // A relative reference resolves against OUR origin: it can only ever name a path on this site, so it is safe
    // (the host never changes). These are the cases a reader might wrongly expect to be refused.
    ["evil.example", "/evil.example"],
    ["evil.example/path", "/evil.example/path"],
    ["?next=/x", "/?next=/x"],
    ["#frag", "/#frag"],
  ];
  it.each(benign)("%j -> %j", (input, expected) => {
    expect(resolveSafeNext(input, ORIGIN)).toBe(expected);
  });
});

describe("SR3 generated corpus: guarantee + idempotence", () => {
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const fragments = [
    "/", "//", "\\", "/\\", "%2f", "%2F", "%5c", "%5C", "%25", "%252f", "%09", "%0a", "%0d", "%00", "%7f", "%1f",
    "\t", "\n", "\r", "\u0000", "\u007f", ".", "..", "/.", "/..", "%2e", "%2E", "a", "evil.example", "salon.example.test",
    "@", ":", "?", "#", "=", "&", "https:", "http:", "javascript:", "data:", " ", "%20", "ç", "ğ", "​", "／",
    "x", "1",
  ];

  it("5000 random strings: every result satisfies the guarantee and is a fixed point", () => {
    const rand = mulberry32(0x5a_a5_1a);
    for (let i = 0; i < 5000; i++) {
      const parts: string[] = [];
      const length = 1 + Math.floor(rand() * 9);
      for (let j = 0; j < length; j++) parts.push(fragments[Math.floor(rand() * fragments.length)]!);
      const input = parts.join("");
      const once = resolveSafeNext(input, ORIGIN);
      expect(satisfiesGuarantee(once), JSON.stringify({ input, once })).toBe(true);
      expect(resolveSafeNext(once, ORIGIN), JSON.stringify({ input, once })).toBe(once);
    }
  });

  it("the very long and the deeply encoded do not slip through", () => {
    expect(resolveSafeNext(`/${"a".repeat(100_000)}`, ORIGIN)).toMatch(/^\/a+$/);
    // Many encoding rounds still only ever yield a path on THIS site (the guarantee is about how the path BEGINS).
    const deep = resolveSafeNext(`/${"%25".repeat(50)}2f/evil.example`, ORIGIN);
    expect(satisfiesGuarantee(deep)).toBe(true);
    expect(resolveSafeNext(deep, ORIGIN)).toBe(deep);
    // ...while a prefix that BECOMES "//host" within the folding rounds is refused, and one that needs more rounds than
    // the sanitizer will unfold is refused as too deeply encoded to vouch for.
    expect(resolveSafeNext("/%252f%252fevil.example", ORIGIN)).toBe("/");
    expect(resolveSafeNext("/%25252f%25252fevil.example", ORIGIN)).toBe("/");
    expect(resolveSafeNext(`//${"/".repeat(5000)}evil.example`, ORIGIN)).toBe("/");
  });

  it("a non-string never reaches a redirect", () => {
    for (const value of [null, undefined, 0, {}, [], ["/x"]]) {
      expect(resolveSafeNext(value as unknown as string, ORIGIN)).toBe("/");
    }
  });
});

describe("SR4 origin handling", () => {
  it("only the exact origin is honoured: another scheme, host, port or user-info is refused", () => {
    expect(resolveSafeNext("https://salon.example.test/ok", ORIGIN)).toBe("/ok");
    expect(resolveSafeNext("http://salon.example.test/ok", ORIGIN)).toBe("/");
    expect(resolveSafeNext("https://salon.example.test:444/ok", ORIGIN)).toBe("/");
    expect(resolveSafeNext("https://user@salon.example.test/ok", ORIGIN)).toBe("/ok");
    expect(resolveSafeNext("https://evil.example/ok", ORIGIN)).toBe("/");
  });

  it("works against an origin with a port", () => {
    expect(resolveSafeNext("http://localhost:3000/x", "http://localhost:3000")).toBe("/x");
    expect(resolveSafeNext("http://localhost:3001/x", "http://localhost:3000")).toBe("/");
  });
});

describe("SR5 isPlainSitePath", () => {
  it.each([
    ["/", true],
    ["/x", true],
    ["/x//y", true],
    ["//x", false],
    ["///x", false],
    ["/\\x", false],
    ["x", false],
    ["", false],
    ["https://x", false],
  ])("%j -> %s", (input, expected) => {
    expect(isPlainSitePath(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The two route handlers
// ---------------------------------------------------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  jar: new Map<string, { value: string; options?: Record<string, unknown> }>(),
  exchange: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (value === "" || options?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, { value, options });
    },
    delete: (name: string) => {
      h.jar.delete(name);
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: h.exchange } }),
}));

import { GET as callbackGet } from "@/app/auth/callback/route";
import { GET as confirmGet } from "@/app/auth/confirm/route";

const SITE = "http://localhost:3000";

describe("SR6 /auth/callback uses the central sanitizer", () => {
  beforeEach(() => {
    h.exchange.mockReset();
    h.jar.clear();
  });

  it("a valid code lands on the sanitized next path", async () => {
    h.exchange.mockResolvedValue({ error: null });
    const res = await callbackGet(new Request(`${SITE}/auth/callback?code=abc&next=/app/x/team%3Ftab%3D1`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${SITE}/app/x/team?tab=1`);
  });

  it.each(["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/%2f/evil.example", "/ok%0d%0aX:1"])(
    "a hostile next (%j) falls back to the site root",
    async (next) => {
      h.exchange.mockResolvedValue({ error: null });
      const res = await callbackGet(new Request(`${SITE}/auth/callback?code=abc&next=${encodeURIComponent(next)}`));
      expect(res.headers.get("location")).toBe(`${SITE}/`);
    },
  );

  it("no code or a refused exchange goes to the login page with a fixed error flag, never to next", async () => {
    const none = await callbackGet(new Request(`${SITE}/auth/callback?next=/app/x`));
    expect(none.headers.get("location")).toBe(`${SITE}/login?error=auth_callback_failed`);
    h.exchange.mockResolvedValue({ error: { code: "bad_code", status: 400 } });
    const refused = await callbackGet(new Request(`${SITE}/auth/callback?code=abc&next=/app/x`));
    expect(refused.headers.get("location")).toBe(`${SITE}/login?error=auth_callback_failed`);
  });
});

describe("SR7 /auth/confirm", () => {
  beforeEach(() => h.jar.clear());

  it("a recovery link parks the token for 15 minutes, goes to /reset-password and ignores next", async () => {
    const res = await confirmGet(new Request(`${SITE}/auth/confirm?token_hash=hash123&type=recovery&next=${encodeURIComponent("https://evil.example")}`));
    expect(res.headers.get("location")).toBe(`${SITE}/reset-password`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const parked = h.jar.get("sb-pending-email-confirmation");
    expect(parked).toBeDefined();
    expect(JSON.parse(parked!.value)).toEqual({ tokenHash: "hash123", type: "recovery", next: "/" });
    expect(parked!.options?.maxAge).toBe(15 * 60);
    expect(parked!.options?.httpOnly).toBe(true);
  });

  it("a recovery link ignores even a perfectly SAFE next: the only destination after a reset is the login page", async () => {
    h.jar.clear();
    const res = await confirmGet(new Request(`${SITE}/auth/confirm?token_hash=hash123&type=recovery&next=${encodeURIComponent("/accept-invite")}`));
    expect(res.headers.get("location")).toBe(`${SITE}/reset-password`);
    expect(JSON.parse(h.jar.get("sb-pending-email-confirmation")!.value).next).toBe("/");
  });

  it("a signup link keeps its 5-minute life, goes to /confirm-email and sanitizes next", async () => {
    const res = await confirmGet(new Request(`${SITE}/auth/confirm?token_hash=h&type=signup&next=${encodeURIComponent("/accept-invite")}`));
    expect(res.headers.get("location")).toBe(`${SITE}/confirm-email`);
    const parked = h.jar.get("sb-pending-email-confirmation")!;
    expect(JSON.parse(parked.value).next).toBe("/accept-invite");
    expect(parked.options?.maxAge).toBe(5 * 60);

    h.jar.clear();
    await confirmGet(new Request(`${SITE}/auth/confirm?token_hash=h&type=signup&next=${encodeURIComponent("//evil.example")}`));
    expect(JSON.parse(h.jar.get("sb-pending-email-confirmation")!.value).next).toBe("/");
  });

  it("without a token or with an unknown type nothing is parked and the person lands on the token-free page", async () => {
    const noToken = await confirmGet(new Request(`${SITE}/auth/confirm?type=recovery`));
    expect(noToken.headers.get("location")).toBe(`${SITE}/reset-password`);
    expect(h.jar.size).toBe(0);
    const unknown = await confirmGet(new Request(`${SITE}/auth/confirm?token_hash=h&type=bogus`));
    expect(unknown.headers.get("location")).toBe(`${SITE}/confirm-email`);
    expect(h.jar.size).toBe(0);
  });
});

describe("SR8 one definition", () => {
  it("the confirm route exports only HTTP handlers (a Next route file may export nothing else)", () => {
    const source = readFileSync(path.join(process.cwd(), "app/auth/confirm/route.ts"), "utf8");
    const exported = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map((m) => m[1]);
    expect(exported).toEqual(["GET"]);
    expect(source).not.toMatch(/^export\s*\{/m);
  });

  it("no application source defines its own resolveSafeNext, and none imports it from a route file", () => {
    const root = process.cwd();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (["node_modules", ".next", ".git", "tests"].includes(entry)) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const rel = path.relative(root, full).replaceAll("\\", "/");
        const text = readFileSync(full, "utf8");
        if (/function\s+resolveSafeNext\s*\(/.test(text) && rel !== "lib/auth/safe-redirect.ts") offenders.push(`${rel}: defines resolveSafeNext`);
        if (/from\s+["']@\/app\/auth\/confirm\/route["']/.test(text)) offenders.push(`${rel}: imports from the route file`);
      }
    };
    for (const top of ["app", "lib", "components"]) walk(path.join(root, top));
    expect(offenders).toEqual([]);
  });

  it("the callback route no longer carries its own startsWith('/') guard", () => {
    const text = readFileSync(path.join(process.cwd(), "app/auth/callback/route.ts"), "utf8");
    expect(text).toContain('from "@/lib/auth/safe-redirect"');
    expect(text).not.toMatch(/startsWith\(\s*["']\/["']\s*\)/);
  });
});

describe("SR9 callers pass the SITE origin, never a request-derived one", () => {
  it("the actions use getSiteUrl() for next", () => {
    const text = readFileSync(path.join(process.cwd(), "lib/modules/auth/actions.ts"), "utf8");
    expect(text).toMatch(/resolveSafeNext\(raw, getSiteUrl\(\)\)/);
  });
});
