import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DEP.1 - the dependency security posture that was reached on purpose and must not regress silently. Pure file / config reads: no database, no network.
 * The version floors are the lowest releases for which the GitHub advisory database lists 0 advisories at the time of DEP.1 (2026-11-20); raising a
 * floor later is fine, lowering one is a security regression.
 * IDs: DV dependency floors, SC shadcn classification, IM effective image-optimization settings.
 */

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");

const parse = (v: string): number[] => v.replace(/^[^0-9]*/, "").split(/[.-]/).slice(0, 3).map((n) => Number(n));
const gte = (a: string, b: string): boolean => {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
};
/** the versions of a package that the lockfile resolves (packages section keys "name@version") */
const locked = (name: string): string[] => {
  const section = lock.slice(lock.indexOf("\npackages:\n"), lock.indexOf("\nsnapshots:\n"));
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return [...section.matchAll(new RegExp(`^ {2}'?${escaped}@([^':\\s(]+)`, "gm"))].map((m) => m[1]!);
};

/** the version the lockfile resolves for a DIRECT dependency of the app (importers section), whichever of dependencies / devDependencies holds it */
const direct = (name: string): string | null => {
  const section = lock.slice(lock.indexOf("\nimporters:\n"), lock.indexOf("\npackages:\n"));
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const m = section.match(new RegExp(`^ {6}'?${escaped}'?:\\r?\\n {8}specifier: [^\\r\\n]+\\r?\\n {8}version: ([^\\s(]+)`, "m"));
  return m ? m[1]! : null;
};

describe("DV dependency floors", () => {
  // direct dependencies: the version the app itself resolves (a dev-only transitive copy of another major, e.g. zod 3.x inside tooling, is not the app's zod)
  const directFloors: Record<string, string> = { next: "16.4.5", "eslint-config-next": "16.4.5", zod: "4.6.6", nodemailer: "10.1.4" };
  for (const [name, floor] of Object.entries(directFloors)) {
    it(`DV-${name}: the app's resolved version is >= ${floor}`, () => {
      const v = direct(name);
      expect(v, `${name} must be a direct dependency in the lockfile importers`).not.toBeNull();
      expect(gte(v!, floor), `${name}@${v} is below the patched floor ${floor}`).toBe(true);
    });
  }
  // transitive packages that sit in the production graph: EVERY resolved copy must be at or above the floor
  const transitiveFloors: Record<string, string> = { "source-map-js": "1.2.2", sharp: "0.35.5" };
  for (const [name, floor] of Object.entries(transitiveFloors)) {
    it(`DV-${name}: every resolved version is >= ${floor}`, () => {
      const versions = locked(name);
      expect(versions.length, `${name} must be in the lockfile`).toBeGreaterThan(0);
      for (const v of versions) expect(gte(v, floor), `${name}@${v} is below the patched floor ${floor}`).toBe(true);
    });
  }

  it("DV-next-pin: next is pinned exactly (no range) and matches eslint-config-next", () => {
    expect(pkg.dependencies.next).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["eslint-config-next"]).toBe(pkg.dependencies.next);
  });

  it("DV-react: React and React DOM stay on the same version and inside Next's ^19 peer range", () => {
    expect(pkg.dependencies.react).toBe(pkg.dependencies["react-dom"]);
    expect(pkg.dependencies.react).toMatch(/^19\./);
  });
});

describe("SC shadcn classification", () => {
  it("SC1 shadcn is a development dependency only (its sole use is the build-time CSS import), never a production one", () => {
    expect(pkg.dependencies.shadcn).toBeUndefined();
    expect(pkg.devDependencies.shadcn).toBeDefined();
  });

  it("SC2 the build-time CSS import still exists (so the dev dependency is really needed) and nothing imports shadcn at runtime", () => {
    expect(readFileSync(path.join(root, "app/globals.css"), "utf8")).toContain('@import "shadcn/tailwind.css"');
    const sources = ["app", "components", "lib"].flatMap((d) => walk(path.join(root, d)));
    const runtimeImports = sources.filter((f) => /from\s+["']shadcn(\/|["'])/.test(readFileSync(f, "utf8")));
    expect(runtimeImports).toEqual([]);
  });
});

describe("IM effective image-optimization settings (SSRF / SVG / local-IP / remote-trust boundary)", () => {
  it("IM1 the app does not widen the image endpoint: remote patterns empty, SVG off, local-IP off, no unsafe overrides", async () => {
    const source = readFileSync(path.join(root, "next.config.ts"), "utf8");
    for (const risky of ["remotePatterns", "dangerouslyAllowSVG", "dangerouslyAllowLocalIP", "domains:"]) expect(source, `next.config.ts must not set ${risky}`).not.toContain(risky);
    const { defaultConfig } = (await import("next/dist/server/config-shared.js")) as { defaultConfig: { images: Record<string, unknown> } };
    const images = defaultConfig.images;
    expect(images.remotePatterns).toEqual([]);
    expect(images.dangerouslyAllowSVG).toBe(false);
    expect(images.dangerouslyAllowLocalIP).toBe(false);
    expect(images.formats).toEqual(["image/webp"]); // AVIF (the vector of one of the 2026 RCE advisories) is not enabled
  });

  it("IM2 server actions keep Next's same-origin default: no allowedOrigins and no raised body limit in next.config.ts", () => {
    const source = readFileSync(path.join(root, "next.config.ts"), "utf8");
    expect(source).not.toContain("allowedOrigins");
    expect(source).not.toContain("bodySizeLimit");
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
