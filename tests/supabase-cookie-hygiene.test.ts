import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PENDING_TEAM_INVITATION_COOKIE } from "@/lib/auth/team-invitation-token";
import {
  clearStaleSupabaseAuthCookies,
  isSupabaseAuthCookieName,
  supabaseAuthStorageKey,
} from "@/lib/auth/supabase-auth-cookies";

/**
 * SAAS.1D confirmation-continuity, Part B — cookie namespace hardening.
 *
 * proxy.ts's stale-session cleanup used to delete every cookie whose name
 * started with "sb-", which also matched SalonOS's own application cookies
 * (the pending team invitation, the pending email confirmation, booking-claim
 * secrets). It now uses an exact predicate derived from the installed
 * @supabase/ssr / auth-js. These tests pin that predicate three ways:
 *
 *  1. as a table of real cookie names (Supabase-owned vs application-owned);
 *  2. against the REAL library — a real createServerClient drives signUp,
 *     verifyOtp and signOut over a fake fetch, and every cookie name it
 *     writes or removes must be recognised. A library upgrade that adds a
 *     new cookie name fails here instead of silently leaking a stale cookie
 *     or deleting an application one;
 *  3. through the REAL proxy() function, with only the framework seams
 *     (next-intl, the Supabase client) stubbed.
 */

// vi.mock("@supabase/ssr") further down (hoisted) stubs createServerClient for the
// proxy() tests; the library-derived tests need the REAL one.
const { createServerClient: realCreateServerClient } = await vi.importActual<typeof import("@supabase/ssr")>("@supabase/ssr");

// Synthetic project refs: no real project identifier lives in this repository's tests. The implementation
// derives the real storage key from NEXT_PUBLIC_SUPABASE_URL at runtime (one test below proves that with the
// environment's own configured value). A and B are two distinct 20-letter refs shaped like Supabase's own:
// A stands for "this deployment's project", B for "some other project".
const REF_A = "abcdefghijklmnopqrst";
const REF_B = "tsrqponmlkjihgfedcba";
const URL_A = `https://${REF_A}.supabase.co`;
const URL_B = `https://${REF_B}.supabase.co`;
const KEY_A = `sb-${REF_A}-auth-token`;
const KEY_B = `sb-${REF_B}-auth-token`;

/** What THIS environment is configured with (.env.local): read at runtime, never written down here. */
const CONFIGURED_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
/** supabase-js's own derivation (`sb-${first host label}-auth-token`), written out independently of the implementation. */
const configuredKey = CONFIGURED_URL ? `sb-${new URL(CONFIGURED_URL).hostname.split(".")[0]}-auth-token` : "";

const CLAIM_REF = "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";
const APP_COOKIES = [
  PENDING_TEAM_INVITATION_COOKIE,
  "sb-pending-email-confirmation",
  `sb-booking-claim-${CLAIM_REF}`,
] as const;

const FLOW_ID = "aBcD1234_-xYz789";

describe("supabaseAuthStorageKey", () => {
  it.each([
    [URL_A, KEY_A],
    [URL_B, KEY_B],
    ["http://127.0.0.1:54321", "sb-127-auth-token"],
    ["http://localhost:54321", "sb-localhost-auth-token"],
    ["https://auth.example.com", "sb-auth-auth-token"],
    ["https://abc.supabase.co/", "sb-abc-auth-token"],
  ])("%s -> %s (the key supabase-js derives from the project URL)", (url, key) => {
    expect(supabaseAuthStorageKey(url)).toBe(key);
  });

  it.each([undefined, "", "not a url", "://", "https://"])("returns null for an unusable URL (%j) so nothing is ever cleared", (url) => {
    expect(supabaseAuthStorageKey(url)).toBeNull();
  });
});

describe("isSupabaseAuthCookieName — the cookies Supabase Auth genuinely owns", () => {
  const owned = (key: string) => [
    key,
    `${key}.0`,
    `${key}.1`,
    `${key}.12`,
    `${key}-code-verifier`,
    `${key}-code-verifier.0`,
    `${key}-code-verifier.3`,
    `${key}-flows-code-verifier`,
    `${key}-flows-code-verifier.0`,
    `${key}-flow-${FLOW_ID}-code-verifier`,
    `${key}-flow-${FLOW_ID}-code-verifier.0`,
    `${key}-flow-${"a".repeat(8)}-code-verifier`,
    `${key}-flow-${"a".repeat(64)}-code-verifier`,
  ];

  it.each([KEY_A, KEY_B, "sb-127-auth-token", "sb-auth-auth-token"])("recognises every cookie shape for storage key %s", (key) => {
    for (const name of owned(key)) {
      expect(isSupabaseAuthCookieName(name, key), name).toBe(true);
    }
  });

  it.each(APP_COOKIES)("never claims the application cookie %s, for any project", (name) => {
    for (const key of [KEY_A, KEY_B, "sb-127-auth-token", "sb-pending-auth-token", "sb-booking-auth-token"]) {
      expect(isSupabaseAuthCookieName(name, key), `${name} vs ${key}`).toBe(false);
    }
  });

  it("does not claim another project's Supabase cookies", () => {
    for (const name of owned(KEY_B)) {
      expect(isSupabaseAuthCookieName(name, KEY_A), name).toBe(false);
    }
    for (const name of owned(KEY_A)) {
      expect(isSupabaseAuthCookieName(name, KEY_B), name).toBe(false);
    }
  });

  it.each([
    ["the bare prefix", "sb-"],
    ["an unrelated locale cookie", "NEXT_LOCALE"],
    ["something merely containing the key", `x${KEY_A}`],
    ["the key with a trailing word", `${KEY_A}-extra`],
    ["the key with an unknown suffix", `${KEY_A}-verifier`],
    ["a near-miss of the verifier suffix", `${KEY_A}-code-verifiers`],
    ["a near-miss of the flows suffix", `${KEY_A}-flow-code-verifier`],
    ["an empty chunk suffix", `${KEY_A}.`],
    ["a non-numeric chunk suffix", `${KEY_A}.abc`],
    ["a chunk index with a leading zero", `${KEY_A}.01`],
    ["a negative chunk index", `${KEY_A}.-1`],
    ["a flow slot with an empty flow id", `${KEY_A}-flow--code-verifier`],
    ["a flow id that is too short", `${KEY_A}-flow-abc-code-verifier`],
    ["a flow id that is too long", `${KEY_A}-flow-${"a".repeat(65)}-code-verifier`],
    ["a flow id with a forbidden character", `${KEY_A}-flow-abcd.efgh1-code-verifier`],
    ["a flow id with a space", `${KEY_A}-flow-abcd efgh1-code-verifier`],
    ["a flow slot missing its verifier suffix", `${KEY_A}-flow-${FLOW_ID}`],
    ["a stacked chunk suffix", `${KEY_A}.0.1`],
    ["a different first label", "sb-other-auth-token"],
    ["a supabase-looking name without the sb- prefix", "supabase-auth-token"],
  ])("does not claim %s", (_label, name) => {
    expect(isSupabaseAuthCookieName(name, KEY_A), name).toBe(false);
  });

  it("can never claim an application cookie even for an adversarial project label", () => {
    // The storage key always ends in "-auth-token"; no application cookie
    // does, and none ends in a verifier suffix either.
    for (const label of ["pending", "booking", "claim", "team", "invitation", "pending-team-invitation"]) {
      const key = supabaseAuthStorageKey(`https://${label}.supabase.co`)!;
      for (const name of APP_COOKIES) {
        expect(isSupabaseAuthCookieName(name, key), `${name} vs ${key}`).toBe(false);
      }
    }
  });
});

describe("clearStaleSupabaseAuthCookies", () => {
  it("clears exactly the Supabase-owned cookies and reports counts only", () => {
    const removed: string[] = [];
    const names = [
      KEY_A,
      `${KEY_A}.0`,
      `${KEY_A}.1`,
      `${KEY_A}-code-verifier`,
      `${KEY_A}-flows-code-verifier`,
      `${KEY_A}-flow-${FLOW_ID}-code-verifier`,
      ...APP_COOKIES,
      "NEXT_LOCALE",
      KEY_B,
    ];

    const outcome = clearStaleSupabaseAuthCookies({ cookieNames: names, supabaseUrl: URL_A, remove: (n) => removed.push(n) });

    expect(removed.sort()).toEqual(
      [KEY_A, `${KEY_A}.0`, `${KEY_A}.1`, `${KEY_A}-code-verifier`, `${KEY_A}-flows-code-verifier`, `${KEY_A}-flow-${FLOW_ID}-code-verifier`].sort(),
    );
    expect(outcome).toEqual({ sweptCount: 6, preservedCount: 5 });
    expect(Object.keys(outcome).sort()).toEqual(["preservedCount", "sweptCount"]);
  });

  it("fails safe: with an unusable project URL it clears nothing at all", () => {
    const remove = vi.fn();
    for (const supabaseUrl of [undefined, "", "not a url"]) {
      const outcome = clearStaleSupabaseAuthCookies({ cookieNames: [KEY_A, ...APP_COOKIES], supabaseUrl, remove });
      expect(outcome).toEqual({ sweptCount: 0, preservedCount: 1 + APP_COOKIES.length });
    }
    expect(remove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The predicate against the REAL installed library — nothing guessed.
// ---------------------------------------------------------------------------

type JarWrite = { name: string; value: string; deleted: boolean };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function authUser(extra: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    aud: "authenticated",
    role: "authenticated",
    email: "someone@example.com",
    created_at: "2026-01-01T00:00:00Z",
    app_metadata: { provider: "email" },
    user_metadata: { full_name: "Test", ...extra },
  };
}

/** A real createServerClient over a fake network and an in-memory cookie jar. */
function libraryHarness(supabaseUrl: string, metadataPadding = 0) {
  const jar = new Map<string, string>();
  const writes: JarWrite[] = [];

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.pathname.endsWith("/signup")) return jsonResponse(200, authUser());
    if (method === "POST" && url.pathname.endsWith("/verify")) {
      return jsonResponse(200, {
        access_token: "header.payload.signature",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "refresh-token-value",
        // Pad the user so the serialized session exceeds one cookie's
        // capacity and @supabase/ssr chunks it into <key>.0, <key>.1, ...
        user: authUser({ padding: "x".repeat(metadataPadding) }),
      });
    }
    if (method === "POST" && url.pathname.endsWith("/logout")) return new Response(null, { status: 204 });
    return jsonResponse(404, { code: "not_found", msg: `unexpected ${method} ${url.pathname}` });
  };

  const client = realCreateServerClient(supabaseUrl, "publishable-key-for-tests", {
    global: { fetch: fakeFetch },
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          const deleted = value === "" || options?.maxAge === 0;
          writes.push({ name, value, deleted });
          if (deleted) jar.delete(name);
          else jar.set(name, value);
        }
      },
    },
  });

  return { client, jar, writes };
}

const libraryCases: Array<[string, string, string]> = [
  ["project A's URL", URL_A, KEY_A],
  ["project B's URL", URL_B, KEY_B],
  ["a local stack URL", "http://127.0.0.1:54321", "sb-127-auth-token"],
  ["a custom domain URL", "https://auth.example.com", "sb-auth-auth-token"],
];
if (CONFIGURED_URL) libraryCases.push(["the URL this environment is configured with (no ref written down)", CONFIGURED_URL, configuredKey]);

describe.each(libraryCases)("the real @supabase/ssr client, %s", (_label, url, key) => {
  it("derives the storage key the predicate is anchored to", () => {
    expect(supabaseAuthStorageKey(url)).toBe(key);
  });

  it("every cookie a PKCE sign-up writes is recognised — legacy verifier, flow index and flow slot", async () => {
    const { client, writes } = libraryHarness(url);
    await client.auth.signUp({ email: "someone@example.com", password: "Password-123456!", options: { emailRedirectTo: "https://salon.example.com/accept-invite" } });

    const names = [...new Set(writes.map((w) => w.name))];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(isSupabaseAuthCookieName(name, key), name).toBe(true);

    // The three verifier families were really exercised (not a vacuous pass).
    expect(names).toContain(`${key}-code-verifier`);
    expect(names).toContain(`${key}-flows-code-verifier`);
    expect(names.some((n) => new RegExp(`^${key}-flow-[A-Za-z0-9_-]{8,64}-code-verifier$`).test(n))).toBe(true);
  });

  it("every cookie a successful verifyOtp writes is recognised — including the chunked session", async () => {
    const { client, writes, jar } = libraryHarness(url, 6000);
    const { error } = await client.auth.verifyOtp({ type: "signup", token_hash: "hashed-token-for-tests" });
    expect(error).toBeNull();

    const names = [...new Set(writes.map((w) => w.name))];
    for (const name of names) expect(isSupabaseAuthCookieName(name, key), name).toBe(true);

    expect(names).toContain(`${key}.0`);
    expect(names).toContain(`${key}.1`);
    expect([...jar.keys()].every((n) => isSupabaseAuthCookieName(n, key))).toBe(true);
  });

  it("every cookie the library REMOVES on sign-out is recognised, so the predicate really covers cleanup", async () => {
    const { client, writes, jar } = libraryHarness(url, 6000);
    await client.auth.signUp({ email: "someone@example.com", password: "Password-123456!" });
    await client.auth.verifyOtp({ type: "signup", token_hash: "hashed-token-for-tests" });
    expect(jar.size).toBeGreaterThan(0);
    writes.length = 0;

    await client.auth.signOut();

    const removed = [...new Set(writes.filter((w) => w.deleted).map((w) => w.name))];
    expect(removed.length).toBeGreaterThan(0);
    for (const name of removed) expect(isSupabaseAuthCookieName(name, key), name).toBe(true);
  });

  it("the library never touches an application cookie that sits in the same jar", async () => {
    const { client, writes, jar } = libraryHarness(url, 6000);
    for (const name of APP_COOKIES) jar.set(name, "app-value");

    await client.auth.signUp({ email: "someone@example.com", password: "Password-123456!" });
    await client.auth.verifyOtp({ type: "signup", token_hash: "hashed-token-for-tests" });
    await client.auth.signOut();

    for (const name of APP_COOKIES) {
      expect(jar.get(name), name).toBe("app-value");
      expect(writes.some((w) => w.name === name), name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Through the REAL proxy(): only next-intl and the Supabase client are stubbed.
// ---------------------------------------------------------------------------

const seams = vi.hoisted(() => ({ getUser: vi.fn() }));

// proxy() cannot be imported natively under Vitest: next-intl's ESM
// middleware imports "next/server" extension-less (see accept-invite-capture
// .test.ts). Stubbing it — and the routing config it needs — leaves proxy.ts
// itself, including its stale-session branch, as the code under test.
vi.mock("next-intl/middleware", async () => {
  const { NextResponse } = await import("next/server");
  return { default: () => () => NextResponse.next() };
});
vi.mock("@/lib/i18n/routing", () => ({ routing: {} }));
vi.mock("@supabase/ssr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/ssr")>();
  return { ...actual, createServerClient: () => ({ auth: { getUser: seams.getUser } }) };
});

function requestWithCookies(names: readonly string[], url = "https://salon.parlakmediatech.com.tr/") {
  const header = names.map((name) => `${name}=value-of-${name.length}`).join("; ");
  return new NextRequest(url, { headers: header ? { cookie: header } : {} });
}

function staleError(code = "refresh_token_not_found") {
  return Object.assign(new Error("stale"), { code, status: 400 });
}

/** Names the proxy response deletes (empty value) — i.e. what a browser would clear. */
function deletedNames(response: Response & { cookies: { getAll(): { name: string; value: string }[] } }) {
  return response.cookies
    .getAll()
    .filter((c) => c.value === "")
    .map((c) => c.name)
    .sort();
}

describe("proxy() stale-session cleanup", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", URL_A);
    seams.getUser.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const cookiesInBrowser = [
    KEY_A,
    `${KEY_A}.0`,
    `${KEY_A}.1`,
    `${KEY_A}-code-verifier`,
    `${KEY_A}-flows-code-verifier`,
    `${KEY_A}-flow-${FLOW_ID}-code-verifier`,
    ...APP_COOKIES,
    "NEXT_LOCALE",
    "some-analytics-cookie",
    KEY_B,
  ];

  it("clears the stale Supabase auth cookies (session, chunks, PKCE verifiers)", async () => {
    seams.getUser.mockRejectedValue(staleError());
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies(cookiesInBrowser));

    expect(deletedNames(response)).toEqual(
      [KEY_A, `${KEY_A}.0`, `${KEY_A}.1`, `${KEY_A}-code-verifier`, `${KEY_A}-flows-code-verifier`, `${KEY_A}-flow-${FLOW_ID}-code-verifier`].sort(),
    );
  });

  it("clears the same for every stale-session error code", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    for (const code of ["refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired"]) {
      seams.getUser.mockRejectedValue(staleError(code));
      const response = await proxy(requestWithCookies([KEY_A, `${KEY_A}-code-verifier`, PENDING_TEAM_INVITATION_COOKIE]));
      expect(deletedNames(response), code).toEqual([KEY_A, `${KEY_A}-code-verifier`].sort());
    }
  });

  it("clears project B's cookies (and only those) when the deployment points at project B", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", URL_B);
    seams.getUser.mockRejectedValue(staleError());
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies([KEY_B, `${KEY_B}.0`, KEY_A, ...APP_COOKIES]));

    expect(deletedNames(response)).toEqual([KEY_B, `${KEY_B}.0`].sort());
  });

  it.skipIf(!CONFIGURED_URL)("derives the key from the environment's own NEXT_PUBLIC_SUPABASE_URL at runtime, with no project ref written down", async () => {
    vi.unstubAllEnvs(); // back to the real configured value
    seams.getUser.mockRejectedValue(staleError());
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies([configuredKey, `${configuredKey}.0`, `${configuredKey}-code-verifier`, KEY_A, KEY_B, ...APP_COOKIES]));

    expect(deletedNames(response)).toEqual([configuredKey, `${configuredKey}.0`, `${configuredKey}-code-verifier`].sort());
  });

  it("the pending team-invitation cookie survives the cleanup", async () => {
    seams.getUser.mockRejectedValue(staleError());
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies(cookiesInBrowser));

    expect(deletedNames(response)).not.toContain(PENDING_TEAM_INVITATION_COOKIE);
    expect(response.cookies.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(false);
  });

  it("the pending email-confirmation cookie survives the cleanup", async () => {
    seams.getUser.mockRejectedValue(staleError());
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies(cookiesInBrowser));

    expect(deletedNames(response)).not.toContain("sb-pending-email-confirmation");
  });

  it("booking-claim cookies survive the cleanup", async () => {
    seams.getUser.mockRejectedValue(staleError());
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");
    const second = "11111111-2222-4333-8444-555555555555";

    const response = await proxy(requestWithCookies([...cookiesInBrowser, `sb-booking-claim-${second}`]));

    const deleted = deletedNames(response);
    expect(deleted.some((n) => n.startsWith("sb-booking-claim-"))).toBe(false);
  });

  it("leaves unrelated cookies and another project's Supabase cookies alone", async () => {
    seams.getUser.mockRejectedValue(staleError());
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies(cookiesInBrowser));

    const deleted = deletedNames(response);
    expect(deleted).not.toContain("NEXT_LOCALE");
    expect(deleted).not.toContain("some-analytics-cookie");
    expect(deleted).not.toContain(KEY_B);
  });

  it("does nothing to any cookie when getUser succeeds", async () => {
    seams.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies(cookiesInBrowser));

    expect(deletedNames(response)).toEqual([]);
  });

  it("does nothing to any cookie for an error that is NOT a stale session, and logs only code/status", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    seams.getUser.mockRejectedValue(Object.assign(new Error("boom: someone@example.com"), { code: "unexpected_failure", status: 500 }));
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies(cookiesInBrowser));

    expect(deletedNames(response)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("someone@example.com");
  });

  it("with an unusable project URL the cleanup clears nothing rather than guessing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not a url");
    seams.getUser.mockRejectedValue(staleError());
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    const response = await proxy(requestWithCookies(cookiesInBrowser));

    expect(deletedNames(response)).toEqual([]);
  });

  it("emits one presence-only sweep line: counts and a boolean, never a cookie name or value", async () => {
    seams.getUser.mockRejectedValue(staleError());
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    await proxy(requestWithCookies(cookiesInBrowser));

    const lines = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("invite-continuity"));
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toEqual({
      tag: "invite-continuity",
      hop: "proxy-stale-session-sweep",
      sweptCookieCount: 6,
      preservedCookieCount: cookiesInBrowser.length - 6,
      pendingInvitationCookiePreserved: true,
    });
    for (const name of cookiesInBrowser) expect(lines[0]).not.toContain(name);
    expect(lines[0]).not.toContain("value-of-");
  });
});

// ---------------------------------------------------------------------------
// Source-level guards: the bare-prefix sweep must not come back.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
/** Source with comments removed, for assertions about what the CODE does. */
const codeOnly = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const relative = `${dir}/${entry}`;
    const stat = statSync(path.join(ROOT, relative));
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      sourceFiles(relative, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(relative);
    }
  }
  return out;
}

describe("no bare `sb-` prefix matching anywhere in application code", () => {
  const files = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components"), "proxy.ts"];

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no source file matches cookies by the `sb-` prefix", () => {
    const offenders = files.filter((file) => /startsWith\(\s*["'`]sb-/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("proxy.ts delegates cleanup to the exact predicate and never deletes by prefix", () => {
    // Code only: proxy.ts explains the old behavior in a comment.
    const code = codeOnly("proxy.ts");
    expect(code).toContain("clearStaleSupabaseAuthCookies");
    expect(code).not.toMatch(/startsWith\(/);
    expect(code).not.toContain('"sb-"');
    expect(code).not.toMatch(/name\.startsWith|\.forEach\(\(\{\s*name\s*\}\)/);
  });

  it("the predicate module is an inclusion list anchored on the storage key, with no application cookie names in it", () => {
    // Code only: the header comment names the application cookies to explain them.
    const code = codeOnly("lib/auth/supabase-auth-cookies.ts");
    expect(code).not.toContain("pending-team-invitation");
    expect(code).not.toContain("pending-email-confirmation");
    expect(code).not.toContain("booking-claim");
    expect(code).toContain("isChunkLike");
  });

  it("the application cookie names are unchanged — the predicate made renaming unnecessary", () => {
    expect(PENDING_TEAM_INVITATION_COOKIE).toBe("sb-pending-team-invitation");
    expect(read("lib/auth/pending-confirmation.ts")).toContain('const COOKIE_NAME = "sb-pending-email-confirmation";');
    expect(read("lib/auth/booking-claim-cookie.ts")).toContain('const COOKIE_PREFIX = "sb-booking-claim-";');
  });
});
