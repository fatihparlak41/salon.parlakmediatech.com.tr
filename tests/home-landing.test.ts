import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHomeLanding } from "@/lib/modules/home/landing";

/**
 * Faz PERF.3 — "/" sends a person who belongs to exactly one salon straight
 * into it instead of the chooser. Pure decision, so no session or database
 * is involved (this file deliberately imports nothing from ./helpers).
 */

const one = [{ tenantSlug: "salon-a" }];
const two = [{ tenantSlug: "salon-a" }, { tenantSlug: "salon-b" }];

describe("resolveHomeLanding", () => {
  it("one salon, ordinary user -> straight into that salon", () => {
    expect(resolveHomeLanding({ memberships: one, platformAdmin: false, forceChooser: false })).toEqual({
      kind: "redirect",
      href: "/app/salon-a",
    });
  });

  it("no salon -> chooser (it is where 'Salon oluştur' lives)", () => {
    expect(resolveHomeLanding({ memberships: [], platformAdmin: false, forceChooser: false })).toEqual({ kind: "chooser" });
  });

  it("two or more salons -> chooser (a real choice)", () => {
    expect(resolveHomeLanding({ memberships: two, platformAdmin: false, forceChooser: false })).toEqual({ kind: "chooser" });
  });

  it("platform admin with one salon -> chooser (a silent redirect would hide the super-admin entry)", () => {
    expect(resolveHomeLanding({ memberships: one, platformAdmin: true, forceChooser: false })).toEqual({ kind: "chooser" });
  });

  it("?choose escape hatch -> chooser even with exactly one salon", () => {
    expect(resolveHomeLanding({ memberships: one, platformAdmin: false, forceChooser: true })).toEqual({ kind: "chooser" });
  });

  it("the destination is the salon root path, URL-encoded, never an arbitrary or absolute URL", () => {
    const landing = resolveHomeLanding({
      memberships: [{ tenantSlug: "a/b?c=d//e" }],
      platformAdmin: false,
      forceChooser: false,
    });
    expect(landing.kind).toBe("redirect");
    if (landing.kind === "redirect") {
      expect(landing.href.startsWith("/app/")).toBe(true);
      expect(landing.href).not.toContain("//");
      expect(landing.href.slice("/app/".length)).not.toMatch(/[/?#]/);
    }
  });
});

// Same comment-stripping as G1 in profile-name-greeting.test.ts: the page's
// explanatory comment legitimately NAMES user_metadata (to say it is not the
// greeting source), so only executable code may be checked for it.
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("home page wiring (source contract)", () => {
  const src = codeOnly(readFileSync(join(__dirname, "..", "app", "[locale]", "page.tsx"), "utf8"));

  it("redirects only through resolveHomeLanding's own verdict", () => {
    expect(src).toContain("resolveHomeLanding(");
    expect(src).toMatch(/landing\.kind === "redirect"/);
  });

  it("still loads the profile in the same parallel batch (the greeting contract in profile-name-greeting.test.ts must keep holding)", () => {
    expect(src).toContain("getMyAccountProfile()");
    expect(src).not.toMatch(/user_metadata/);
  });
});
