import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testDb } from "./helpers";

/**
 * Faz SAAS.1C.2a - the exact write surface of the API roles is LOCKED here for SAAS.1C.2c (billing enforcement triggers).
 * Fixture: tests/fixtures/saas1c2a-write-surface.json (generated from the catalog; human-readable inventory in the operator artifacts).
 * A new INSERT/UPDATE/DELETE grant, a changed column list, a new executable public function or a lost guard trigger fails this test: whoever changes the
 * surface must update the fixture AND decide how the new path is covered by enforcement. No enforcement behaviour exists in 1C.2a.
 */

type Loose = Record<string, unknown>;
const ROLES = ["authenticated", "anon", "service_role", "booking_gateway"] as const;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/saas1c2a-write-surface.json", import.meta.url), "utf8")) as {
  tables: Record<string, Record<string, { insert: boolean; delete: boolean; update: false | "all-columns" | string[] }>>;
  rpc: Record<string, string[]>;
  billingTriggers: string[];
};

describe("WS - write surface lock (inventory for SAAS.1C.2c)", () => {
  it("WS1 table write privileges per API role match the locked inventory exactly", async () => {
    const rows = await testDb<Loose[]>`
      select c.relname rel, r.rolname role,
             has_table_privilege(r.rolname, c.oid, 'INSERT') ins, has_table_privilege(r.rolname, c.oid, 'DELETE') del,
             coalesce((select string_agg(a.attname, ',' order by a.attname) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and has_column_privilege(r.rolname, c.oid, a.attnum, 'UPDATE')), '') upd,
             (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::int ncols
        from pg_class c cross join (values ('authenticated'), ('anon'), ('service_role'), ('booking_gateway')) r(rolname)
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1, 2`;
    const live: typeof fixture.tables = {};
    for (const r of rows) {
      const upd = r.upd as string;
      if (!r.ins && !r.del && !upd) continue;
      const all = upd && upd.split(",").length === r.ncols;
      (live[r.rel as string] ??= {})[r.role as string] = { insert: r.ins as boolean, delete: r.del as boolean, update: !upd ? false : all ? "all-columns" : upd.split(",") };
    }
    expect(live).toEqual(fixture.tables);
  });

  it("WS2 the public functions executable per API role match the locked inventory exactly", async () => {
    for (const role of ROLES) {
      const rows = await testDb<{ s: string }[]>`
        select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' s from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and has_function_privilege(${role}, p.oid, 'EXECUTE')
           and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1`;
      expect(rows.map((r) => r.s).sort(), role).toEqual(fixture.rpc[role]);
    }
  });

  it("WS3 the lifecycle / version / event / branch guards are installed", async () => {
    const rows = await testDb<{ s: string }[]>`
      select c.relname || '.' || t.tgname s from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
         and t.tgname in ('tenants_lifecycle_guard', 'subscriptions_bump_version', 'branches_hard_limit', 'subscription_events_append_only') order by 1`;
    expect(rows.map((r) => r.s).sort()).toEqual([...fixture.billingTriggers].sort());
    expect(fixture.billingTriggers).toHaveLength(4);
  });

  it("WS4 the tenants table keeps ONLY the profile columns writable for the API roles", async () => {
    expect(fixture.tables.tenants?.authenticated?.update).toEqual(["currency", "customer_cancellation_cutoff_minutes", "customer_cancellation_enabled", "customer_reschedule_cutoff_minutes", "customer_reschedule_enabled", "name", "timezone"]);
    expect(fixture.tables.tenants?.authenticated?.insert).toBe(false);
    expect(fixture.tables.tenants?.authenticated?.delete).toBe(false);
  });
});
