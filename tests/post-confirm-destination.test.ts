import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POST_CONFIRM_NEXT_METADATA_KEY,
  chooseConfirmationDestination,
  readPostConfirmHint,
  resolvePostConfirmHintForWrite,
} from "@/lib/auth/post-confirm-destination";
import { resolveSafeNext } from "@/app/auth/confirm/route";

/**
 * SAAS.1D confirmation-continuity, Part A — the pure rules for the
 * durable post-confirmation destination hint (post_confirm_next).
 *
 * The real PROD template forwards no `next`, so the invited team member's
 * return to /accept-invite has to travel with the ACCOUNT. These tests pin
 * the security model: only ONE exact route is ever storable, both on write
 * and on read; the read side treats user_metadata (user-editable) as
 * untrusted; only signup confirmations may use it; an explicit destination
 * always wins.
 */

const SITE = "https://salon.parlakmediatech.com.tr";
const KEY = POST_CONFIRM_NEXT_METADATA_KEY;

const HOSTILE = [
  ["protocol-relative", "//evil.example"],
  ["protocol-relative + invite path", "//evil.example/accept-invite"],
  ["absolute foreign https", "https://evil.example/accept-invite"],
  ["absolute foreign http", "http://evil.example"],
  ["backslash host", "/\\evil.example"],
  ["double backslash", "\\\\evil.example"],
  ["javascript:", "javascript:alert(1)"],
  ["data:", "data:text/html,<script>alert(1)</script>"],
  ["userinfo trick", "https://salon.parlakmediatech.com.tr@evil.example/accept-invite"],
  ["look-alike host", "https://salon.parlakmediatech.com.tr.evil.example/accept-invite"],
  ["tab inside slashes", "/\t/evil.example"],
  ["newline inside slashes", "/\n/evil.example"],
  ["malformed URL", "http://[::1"],
  ["path traversal out of the route", "/accept-invite/../app/other"],
] as const;

describe("write side: resolvePostConfirmHintForWrite", () => {
  it("stores exactly the invitation route for the validated /accept-invite", () => {
    expect(resolvePostConfirmHintForWrite("/accept-invite", SITE)).toBe("/accept-invite");
  });

  it("stores nothing for an ordinary sign-up (no next, or the site root)", () => {
    expect(resolvePostConfirmHintForWrite(null, SITE)).toBeNull();
    expect(resolvePostConfirmHintForWrite(undefined, SITE)).toBeNull();
    expect(resolvePostConfirmHintForWrite("", SITE)).toBeNull();
    expect(resolvePostConfirmHintForWrite("/", SITE)).toBeNull();
  });

  it.each(["/app", "/app/some-salon", "/app/some-salon/team", "/account", "/account/claim/complete/abc", "/login", "/onboarding"])(
    "does not widen beyond the invitation route: %s is a valid local route but not storable",
    (route) => {
      expect(resolvePostConfirmHintForWrite(route, SITE)).toBeNull();
    },
  );

  it.each(["/accept-invite?x=1", "/accept-invite#frag", "/accept-invite/", "/accept-invite/extra", "/Accept-Invite"])(
    "stores only the bare route, never a variant of it: %s",
    (variant) => {
      expect(resolvePostConfirmHintForWrite(variant, SITE)).toBeNull();
    },
  );

  it.each(HOSTILE)("rejects a hostile value (%s)", (_label, value) => {
    expect(resolvePostConfirmHintForWrite(value, SITE)).toBeNull();
  });

  it("can only ever return null or the one allowlisted route, whatever it is given", () => {
    const inputs = [
      "/accept-invite",
      "https://salon.parlakmediatech.com.tr/accept-invite",
      "x".repeat(500),
      "0123456789abcdef".repeat(4),
      "person@example.com",
      "/accept-invite?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      ...HOSTILE.map(([, v]) => v),
    ];
    for (const input of inputs) {
      const out = resolvePostConfirmHintForWrite(input, SITE);
      expect([null, "/accept-invite"]).toContain(out);
    }
  });

  it("cannot express an invitation token, id or email — by construction the value is a route", () => {
    const out = resolvePostConfirmHintForWrite("/accept-invite?token=" + "a".repeat(64), SITE);
    expect(out).toBeNull();
    const ok = resolvePostConfirmHintForWrite("/accept-invite", SITE);
    expect(ok).not.toMatch(/[0-9a-f]{32,}|@|[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe("read side: readPostConfirmHint treats user_metadata as untrusted", () => {
  it("returns the hint when it is the allowlisted route", () => {
    expect(readPostConfirmHint({ [KEY]: "/accept-invite" }, SITE)).toBe("/accept-invite");
  });

  it("ignores every other metadata key", () => {
    expect(readPostConfirmHint({ full_name: "Ayşe", email: "x@example.com", next: "/accept-invite" }, SITE)).toBeNull();
  });

  it.each([null, undefined, "/accept-invite", 42, true, [], ["/accept-invite"]])(
    "returns null when user_metadata itself is %j",
    (metadata) => {
      expect(readPostConfirmHint(metadata, SITE)).toBeNull();
    },
  );

  it.each([null, undefined, 42, true, {}, ["/accept-invite"], ""])(
    "returns null when the hint value is not a usable string (%j)",
    (value) => {
      expect(readPostConfirmHint({ [KEY]: value }, SITE)).toBeNull();
    },
  );

  it.each(HOSTILE)("re-validates on read: rejects a tampered value (%s)", (_label, value) => {
    expect(readPostConfirmHint({ [KEY]: value }, SITE)).toBeNull();
  });

  it.each(["/app/other-tenant", "/app/some-salon/settings", "/", "/login", "/account"])(
    "re-checks the allowlist on read: a valid local route (%s) that a user edited in is still rejected",
    (route) => {
      expect(readPostConfirmHint({ [KEY]: route }, SITE)).toBeNull();
    },
  );

  it("rejects an oversized value outright", () => {
    expect(readPostConfirmHint({ [KEY]: "/accept-invite" + "x".repeat(300) }, SITE)).toBeNull();
  });
});

describe("chooseConfirmationDestination: explicit > validated metadata > /", () => {
  const meta = { [KEY]: "/accept-invite" };
  const choose = (over: Partial<Parameters<typeof chooseConfirmationDestination>[0]>) =>
    chooseConfirmationDestination({ confirmType: "signup", pendingNext: "/", userMetadata: meta, siteOrigin: SITE, ...over });

  it("the real PROD case: signup confirmation, link carried no next, hint present -> /accept-invite", () => {
    expect(choose({})).toMatchObject({ destination: "/accept-invite", source: "metadata" });
  });

  it("an explicit valid destination from the link always wins over the hint", () => {
    expect(choose({ pendingNext: "/account/claim/complete/abc" })).toMatchObject({
      destination: "/account/claim/complete/abc",
      source: "explicit",
    });
    expect(choose({ pendingNext: "/app/some-salon" })).toMatchObject({ destination: "/app/some-salon", source: "explicit" });
  });

  it("the site root counts as 'no explicit destination' (it is what the bare-site RedirectTo produces)", () => {
    expect(choose({ pendingNext: "/" })).toMatchObject({ source: "metadata" });
  });

  it("an ordinary sign-up (no hint) is unchanged: lands on /", () => {
    expect(choose({ userMetadata: { full_name: "Ayşe" } })).toMatchObject({
      destination: "/",
      source: "default",
    });
  });

  it.each(HOSTILE)("a hostile hint (%s) is rejected and the destination stays /", (_label, value) => {
    expect(choose({ userMetadata: { [KEY]: value } })).toMatchObject({ destination: "/", source: "default" });
  });

  it.each(["magiclink", "recovery", "email_change", "email", "invite"])(
    "a %s confirmation NEVER inherits the hint, even when one is present and valid",
    (confirmType) => {
      expect(choose({ confirmType })).toMatchObject({ destination: "/", source: "default" });
    },
  );

  it("an unknown confirmation type never inherits it either (fails closed)", () => {
    expect(choose({ confirmType: "something_new" })).toMatchObject({ destination: "/", source: "default" });
    expect(choose({ confirmType: "" })).toMatchObject({ destination: "/", source: "default" });
  });

  it("re-validates the stored pending next too: a tampered one is treated as no explicit destination", () => {
    expect(choose({ pendingNext: "//evil.example" })).toMatchObject({ destination: "/accept-invite", source: "metadata" });
    expect(choose({ pendingNext: "https://evil.example/x" })).toMatchObject({ destination: "/accept-invite", source: "metadata" });
    expect(choose({ pendingNext: "javascript:alert(1)", userMetadata: {} })).toMatchObject({ destination: "/", source: "default" });
  });

  it("never returns anything but a local path", () => {
    for (const pendingNext of ["/", "/x", "//evil.example", "https://evil.example", "javascript:1", "x".repeat(400)]) {
      for (const userMetadata of [meta, {}, null, { [KEY]: "//evil.example" }]) {
        for (const confirmType of ["signup", "magiclink", "recovery"]) {
          const { destination } = choose({ pendingNext, userMetadata, confirmType });
          expect(destination.startsWith("/")).toBe(true);
          expect(destination.startsWith("//")).toBe(false);
        }
      }
    }
  });
});

/**
 * Release-review findings F3 and F4 (open redirect). resolveSafeNext — the guard
 * /auth/confirm applies before storing `next` — used to return protocol-relative
 * paths ("/.//evil.example" -> "//evil.example") and was not idempotent
 * ("//<this-site>//evil.example" -> "//evil.example" on a second pass). That is now
 * fixed at the source (tests/redirect-safety.test.ts). confirmEmailAction still feeds
 * the STORED value — client-influenced state, a cookie — through
 * chooseConfirmationDestination, which keeps its own plain-path check as defense in
 * depth. This file pins that layer two ways: with the fixed guard, and (vi.doMock)
 * with the guard substituted by its 747ea33 behavior, so the layer is proven on its
 * own instead of being hidden behind the fix.
 */

/** resolveSafeNext exactly as it was in 747ea33 — the dangerous behavior the layer must survive. */
function legacyResolveSafeNext(next: string, origin: string): string {
  try {
    const resolved = new URL(next, origin);
    return resolved.origin === origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : "/";
  } catch {
    return "/";
  }
}

const HOST = new URL(SITE).host;
const isPlainLocalPath = (path: string) => path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
const staysOnSite = (destination: string, origin: string) => new URL(destination, origin).origin === origin;

const DOT_SEGMENT_PAYLOADS = [
  "/.//evil.example",
  "/..//evil.example",
  "/a/..//evil.example",
  "/.//evil.example/accept-invite",
  `/.//${HOST}//evil.example`,
  `/..//${HOST}//evil.example`,
  `/a/..//${HOST}//evil.example/x?y=1#z`,
  `/.//${HOST}///evil.example`,
  `/.//${HOST}/\\evil.example`,
];

type DestinationModule = {
  chooseConfirmationDestination: typeof chooseConfirmationDestination;
  resolvePostConfirmHintForWrite: typeof resolvePostConfirmHintForWrite;
  readPostConfirmHint: typeof readPostConfirmHint;
};
const fixedModule: DestinationModule = { chooseConfirmationDestination, resolvePostConfirmHintForWrite, readPostConfirmHint };

/** Every confirmation type, every metadata shape: the destination must be a plain same-site path. */
function assertSafeForPayload(mod: DestinationModule, normalize: (next: string, origin: string) => string, raw: string) {
  const stored = normalize(raw, SITE); // what GET /auth/confirm stores for this link
  for (const pendingNext of [stored, raw]) {
    for (const confirmType of ["signup", "magiclink", "recovery", "email_change", "invite", "email"]) {
      for (const userMetadata of [{}, { [KEY]: "/accept-invite" }, { [KEY]: raw }]) {
        const { destination } = mod.chooseConfirmationDestination({ confirmType, pendingNext, userMetadata, siteOrigin: SITE });
        expect(isPlainLocalPath(destination), `${confirmType} ${JSON.stringify(pendingNext)} -> ${destination}`).toBe(true);
        expect(staysOnSite(destination, SITE), destination).toBe(true);
      }
    }
  }
}

function assertOffSiteStoredNextIsDiscarded(mod: DestinationModule) {
  const stored = `//${HOST}//evil.example`; // what 747ea33's GET route stored for /.//<site>//evil.example
  expect(mod.chooseConfirmationDestination({ confirmType: "signup", pendingNext: stored, userMetadata: { [KEY]: "/accept-invite" }, siteOrigin: SITE })).toMatchObject({
    destination: "/accept-invite",
    source: "metadata",
  });
  expect(mod.chooseConfirmationDestination({ confirmType: "magiclink", pendingNext: stored, userMetadata: { [KEY]: "/accept-invite" }, siteOrigin: SITE })).toMatchObject({
    destination: "/",
    source: "default",
  });
}

/**
 * 60,000 deterministic URL-ish inputs: no destination is ever off-site or
 * protocol-relative, and the hint is only ever /accept-invite. Returns how many
 * inputs the given normalizer turned into a "//…" path on the first pass (0 for
 * the fixed guard; large for the 747ea33 one, which proves the corpus reaches the
 * dangerous class).
 */
function checkDestinationProperty(mod: DestinationModule, normalize: (next: string, origin: string) => string): number {
  // Deterministic PRNG (mulberry32) so a failure is reproducible.
  let seed = 0x5eed1234;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const fragments = [
    "/", "//", "///", "\\", "/\\", "\\/", ".", "..", "./", "../", "/.", "/..", "%2f", "%2F", "%5c", "%5C", "%2e", "%2E", "%00",
    "@", ":", "?", "#", "&", "=", " ", "\t", "\n", "\r", "evil.example", HOST, `${HOST}.evil.example`, "http:", "https:",
    "javascript:", "data:", "accept-invite", "account", "app", "x", "a", "0", String.fromCharCode(0x2215), String.fromCharCode(0xff0f), String.fromCharCode(0x3002), "?next=", "#/", "[", "]", "::1",
    "127.0.0.1", "0x7f000001",
  ];
  const generate = () => {
    const count = 1 + Math.floor(random() * 8);
    let out = random() < 0.6 ? "/" : "";
    for (let i = 0; i < count; i++) out += fragments[Math.floor(random() * fragments.length)];
    return out;
  };

  const origins = [SITE, "http://localhost:3000"];
  let protocolRelativeAfterOnePass = 0;
  for (let n = 0; n < 60000; n++) {
    const raw = generate();
    const origin = origins[n % origins.length]!;
    const stored = normalize(raw, origin);
    if (stored.startsWith("//")) protocolRelativeAfterOnePass++;

    const hintWritten = mod.resolvePostConfirmHintForWrite(raw, origin);
    const hintRead = mod.readPostConfirmHint({ [KEY]: raw }, origin);
    if (hintWritten !== null && hintWritten !== "/accept-invite") throw new Error(`hint written for ${JSON.stringify(raw)}: ${hintWritten}`);
    if (hintRead !== null && hintRead !== "/accept-invite") throw new Error(`hint read for ${JSON.stringify(raw)}: ${hintRead}`);

    for (const pendingNext of [stored, raw]) {
      const confirmType = n % 2 === 0 ? "signup" : "magiclink";
      const chosen = mod.chooseConfirmationDestination({ confirmType, pendingNext, userMetadata: { [KEY]: raw }, siteOrigin: origin });
      if (!isPlainLocalPath(chosen.destination) || !staysOnSite(chosen.destination, origin)) {
        throw new Error(`unsafe destination ${JSON.stringify(chosen.destination)} for next=${JSON.stringify(raw)} pendingNext=${JSON.stringify(pendingNext)} origin=${origin}`);
      }
      if (chosen.source === "metadata" && (chosen.destination !== "/accept-invite" || confirmType !== "signup")) {
        throw new Error(`metadata used wrongly for ${JSON.stringify(raw)}`);
      }
    }
  }
  return protocolRelativeAfterOnePass;
}

describe("open-redirect hardening: the destination is always a plain same-site path", () => {
  it.each(DOT_SEGMENT_PAYLOADS)("a link carrying next=%s cannot redirect off-site (the stored value is re-checked)", (raw) => {
    assertSafeForPayload(fixedModule, resolveSafeNext, raw);
  });

  it("an off-site stored next is discarded, so a signup falls back to the validated hint and everything else to /", () => {
    assertOffSiteStoredNextIsDiscarded(fixedModule);
  });

  it("legitimate destinations are untouched: what the GET route stored is exactly where the person lands", () => {
    const legitimate = [
      "/account",
      "/account/appointments?tab=upcoming#next",
      "/account/claim/complete/0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0",
      "/account/link-salon/some-salon",
      "/app/some-salon",
      "/app/some-salon/team",
      "/accept-invite",
      "/x//y",
      "/login?next=%2Faccept-invite",
    ];
    for (const raw of legitimate) {
      const stored = resolveSafeNext(raw, SITE);
      for (const confirmType of ["signup", "magiclink"]) {
        expect(chooseConfirmationDestination({ confirmType, pendingNext: stored, userMetadata: {}, siteOrigin: SITE }), raw).toMatchObject({
          destination: stored,
          source: "explicit",
        });
      }
    }
  });

  it("property (fixed guard): over 60,000 generated URL-ish inputs no destination is ever off-site or protocol-relative, and the first pass never yields a // path", () => {
    expect(checkDestinationProperty(fixedModule, resolveSafeNext)).toBe(0);
  });
});

describe("defense in depth: the destination stays a plain same-site path even if resolveSafeNext regressed to its 747ea33 behavior", () => {
  afterEach(() => {
    vi.doUnmock("@/app/auth/confirm/route");
    vi.resetModules();
  });

  /** A fresh copy of the destination module whose resolveSafeNext IS the 747ea33 one. */
  async function withRegressedGuard(): Promise<DestinationModule> {
    vi.resetModules();
    vi.doMock("@/app/auth/confirm/route", () => ({ resolveSafeNext: legacyResolveSafeNext }));
    return import("@/lib/auth/post-confirm-destination");
  }

  it("the 747ea33 guard really is dangerous, so this layer is genuinely being exercised", () => {
    const protocolRelativeAfterOnePass = DOT_SEGMENT_PAYLOADS.filter((raw) => legacyResolveSafeNext(raw, SITE).startsWith("//"));
    expect(protocolRelativeAfterOnePass.length).toBeGreaterThanOrEqual(6);
    // ...and the second normalization the confirm path performs can turn an on-site "//<host>//x" into an off-site "//x".
    const flipsOffSiteOnSecondPass = protocolRelativeAfterOnePass.filter((raw) => !staysOnSite(legacyResolveSafeNext(legacyResolveSafeNext(raw, SITE), SITE), SITE));
    expect(flipsOffSiteOnSecondPass.length).toBeGreaterThanOrEqual(2);
  });

  it.each(DOT_SEGMENT_PAYLOADS)("a link carrying next=%s cannot redirect off-site", async (raw) => {
    assertSafeForPayload(await withRegressedGuard(), legacyResolveSafeNext, raw);
  });

  it("an off-site stored next is discarded", async () => {
    assertOffSiteStoredNextIsDiscarded(await withRegressedGuard());
  });

  it("property (regressed guard): 60,000 generated inputs still never yield an off-site or protocol-relative destination", async () => {
    const protocolRelativeAfterOnePass = checkDestinationProperty(await withRegressedGuard(), legacyResolveSafeNext);
    // The corpus does reach the dangerous class (otherwise this proves nothing).
    expect(protocolRelativeAfterOnePass).toBeGreaterThan(50);
  });
});
