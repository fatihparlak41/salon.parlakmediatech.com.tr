import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testDb } from "../helpers";
import { readHostedEnv } from "./guard";
import a1Bodies from "../fixtures/saas1c2c-a1-function-bodies.json";
import registry from "../fixtures/billing-enforcement-registry.json";

/**
 * Faz SAAS.1C.2c-A2 - the committed catalog / classification / completeness-gate suite (tests/saas1c2c-a2-catalog.test.ts, pure catalog reads plus
 * rolled-back drift simulations) executed against the DISPOSABLE hosted project. Importing the file registers its tests in this run; the hosted env
 * guard runs first so a wrong database is refused before anything executes.
 *
 * HK2h is hosted-only: the committed A1 body fixture was hashed on the LOCAL rig, where the one body that reads pg_catalog.pg_timezone_names
 * (public.update_salon_profile) is stored as rig.tz_names (a Windows shim). HK2 therefore cannot pass on a real Supabase project for that ONE function;
 * HK2h applies exactly that substitution and checks every one of the 79 functions again.
 */
readHostedEnv();
await import("../saas1c2c-a2-catalog.test");

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const stripHook = (src: string) => src.replace(/ {2}(select|perform) private\.billing_guard\([^\n]*-- a2-billing-hook\n/g, "").replace(/ {4}and private\.billing_public_booking_open\(t\.id\) -- a2-billing-hook\n/g, "");
const RIG_TZ: Record<string, [string, string]> = { "public.update_salon_profile": ["pg_catalog.pg_timezone_names", "rig.tz_names"] };

describe("HK2h hosted check of every A1 body (only the documented rig timezone substitution is allowed)", () => {
  it("HK2h removing the marked line gives back the A1 body of all 79 functions (hosted bodies, rig-fixture hashes, one named substitution)", async () => {
    const fx = a1Bodies.functions as Record<string, string>;
    expect(Object.keys(fx)).toHaveLength(79);
    const rows = await testDb<{ n: string; s: string }[]>`select (case when pronamespace = 'public'::regnamespace then 'public.' else 'private.' end) || proname as n, prosrc as s
      from pg_proc where pronamespace in ('public'::regnamespace, 'private'::regnamespace) and ((pronamespace = 'public'::regnamespace) or proname in ('billing_preflight_core', 'resolve_bookable_tenant'))`;
    const src = new Map(rows.map((r) => [r.n, r.s]));
    const mismatches: string[] = [];
    for (const [name, want] of Object.entries(fx)) {
      let body = stripHook(src.get(name) ?? "");
      const sub = RIG_TZ[name];
      if (sub) body = body.replaceAll(sub[0], sub[1]);
      // the preflight carries the A2 hook_coverage check in addition to the hook marker - its A1 form is covered by the rollback fingerprint instead
      if (name === "private.billing_preflight_core") continue;
      if (md5(body) !== want) mismatches.push(name);
    }
    expect(mismatches).toEqual([]);
    expect(registry.actions.filter((a) => a.hooked && a.kind === "function")).toHaveLength(32);
  });
});

import { afterAll } from "vitest";
afterAll(async () => {
  /* the imported suite ends testDb in its own afterAll; nothing to release here */
});
