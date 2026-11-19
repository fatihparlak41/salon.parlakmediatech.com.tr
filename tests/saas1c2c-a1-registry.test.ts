import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "./helpers";
import registry from "./fixtures/billing-enforcement-registry.json";
import surface from "./fixtures/saas1c2a-write-surface.json";

/**
 * SAAS.1C.2c-A1 registry completeness gate. The fixture (tests/fixtures/billing-enforcement-registry.json) is the source of truth; the seeded
 * database tables and the live catalog must agree with it, and a NEW API-reachable write path that is not registered must fail here (and in the
 * preflight check registry_complete).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

afterAll(async () => {
  await testDb.end();
}, 60000);

const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { message?: string }).message ?? String(e);
  }
  return "__no_error__";
};

describe("RG registry completeness", () => {
  it("RG1 the fixture is self-consistent (generator check) and every action points to a defined category", () => {
    const out = execFileSync("node", ["scripts/billing-registry.mjs", "check"], { encoding: "utf8" });
    expect(out).toMatch(/ok: 23 categories, 99 actions/);
    const cats = new Set(registry.categories.map((c) => c.category));
    for (const a of registry.actions) expect(cats.has(a.category), a.action_key).toBe(true);
  });
  it("RG2 the seeded tables equal the fixture exactly (categories, policies, first stages, actions)", async () => {
    const c = await testDb<Loose[]>`select category, read_only, blocked, first_stage from private.billing_categories order by category`;
    expect(c).toEqual([...registry.categories].sort((a, b) => a.category.localeCompare(b.category, "en")).map((x) => ({ category: x.category, read_only: x.read_only, blocked: x.blocked, first_stage: x.first_stage })).sort((a, b) => (a.category < b.category ? -1 : 1)));
    const a = await testDb<Loose[]>`select action_key, kind, category from private.billing_action_registry order by action_key`;
    const want = registry.actions.map((x) => ({ action_key: x.action_key, kind: x.kind, category: x.category })).sort((p, q) => (p.action_key < q.action_key ? -1 : 1));
    expect(a.map((x) => ({ ...x })).sort((p, q) => (p.action_key < q.action_key ? -1 : 1))).toEqual(want);
  });
  it("RG3 the counts are the agreed inventory: 75 existing write functions + 2 A1 operator functions, 22 direct table operations on the 12 locked tables", () => {
    const fn = registry.actions.filter((x) => x.kind === "function");
    const tb = registry.actions.filter((x) => x.kind === "table_op");
    expect(fn.length).toBe(77);
    expect(tb.length).toBe(22);
    expect(new Set(tb.map((x) => x.action_key.split(":")[1])).size).toBe(12);
    const locked = new Set(((surface as Loose).tables.authenticated as Loose[] | Record<string, unknown>) ? Object.keys((surface as Loose).tables?.authenticated ?? {}) : []);
    void locked;
    for (const x of fn.filter((f) => f.action_key.includes("billing_enforcement"))) expect(x.category).toBe("PLATFORM_ADMIN");
  });
  it("RG4 the live catalog scan finds nothing unregistered (every exposed write function and every API-granted table operation is in the registry)", async () => {
    expect(await testDb`select action_key from private.billing_registry_unregistered()`).toEqual([]);
  });
  it("RG5 a NEW API-reachable write function that is not registered is detected, by key; then registering it clears the finding", async () => {
    const msg = await fails(
      testDb.begin(async (sql) => {
        await sql`create function public.zz_a1_probe_write() returns void language plpgsql security definer set search_path = '' as $f$ begin update public.customers set full_name = full_name where false; end $f$`;
        await sql`grant execute on function public.zz_a1_probe_write() to authenticated`;
        const un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        if (!un.includes("fn:zz_a1_probe_write")) throw new Error("NOT_DETECTED " + JSON.stringify(un));
        const pf = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
        const ck = (pf.checks as Loose[]).find((c) => c.id === "registry_complete")!;
        if (ck.pass || pf.passed) throw new Error("PREFLIGHT_PASSED");
        await sql`insert into private.billing_action_registry (action_key, kind, category) values ('fn:zz_a1_probe_write', 'function', 'CUSTOMER_EDIT')`;
        if ((await sql`select 1 from private.billing_registry_unregistered()`).length !== 0) throw new Error("STILL_FLAGGED");
        throw new Error("ROLLBACK_OK");
      }),
    );
    expect(msg).toMatch(/ROLLBACK_OK/);
  });
  it("RG6 a write function that reaches a write through a helper (transitive) is also detected", async () => {
    const msg = await fails(
      testDb.begin(async (sql) => {
        await sql`create function private.zz_a1_inner() returns void language plpgsql security definer set search_path = '' as $f$ begin delete from public.staff_services where false; end $f$`;
        await sql`create function public.zz_a1_outer() returns void language plpgsql security definer set search_path = '' as $f$ begin perform private.zz_a1_inner(); end $f$`;
        await sql`grant execute on function public.zz_a1_outer() to authenticated`;
        const un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        if (!un.includes("fn:zz_a1_outer")) throw new Error("NOT_DETECTED " + JSON.stringify(un));
        throw new Error("ROLLBACK_OK");
      }),
    );
    expect(msg).toMatch(/ROLLBACK_OK/);
  });
  it("RG7 a new table that the API roles may write is detected, and so is a new operation grant on a registered table", async () => {
    const msg = await fails(
      testDb.begin(async (sql) => {
        await sql`create table public.zz_a1_probe (id int primary key)`;
        await sql`grant insert on public.zz_a1_probe to authenticated`;
        let un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        if (!un.includes("table:zz_a1_probe:INSERT")) throw new Error("TABLE_NOT_DETECTED " + JSON.stringify(un));
        await sql`grant update (id) on public.zz_a1_probe to authenticated`;
        un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        if (!un.includes("table:zz_a1_probe:UPDATE")) throw new Error("UPDATE_NOT_DETECTED " + JSON.stringify(un));
        await sql`grant delete on public.zz_a1_probe to authenticated`;
        un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        if (!un.includes("table:zz_a1_probe:DELETE")) throw new Error("DELETE_NOT_DETECTED " + JSON.stringify(un));
        await sql`grant delete on public.customers to authenticated`;
        un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        if (!un.includes("table:customers:DELETE") && !registry.actions.some((a) => a.action_key === "table:customers:DELETE")) throw new Error("OP_NOT_DETECTED " + JSON.stringify(un));
        throw new Error("ROLLBACK_OK");
      }),
    );
    expect(msg).toMatch(/ROLLBACK_OK/);
  });
  it("RG8 read-only functions and functions only granted to non-API roles are NOT flagged (no false positives on the real catalog)", async () => {
    const msg = await fails(
      testDb.begin(async (sql) => {
        await sql`create function public.zz_a1_reader() returns int language sql stable security definer set search_path = '' as $f$ select count(*)::int from public.customers $f$`;
        await sql`grant execute on function public.zz_a1_reader() to authenticated`;
        await sql`create function public.zz_a1_hidden() returns void language plpgsql security definer set search_path = '' as $f$ begin delete from public.customers where false; end $f$`;
        await sql`revoke all on function public.zz_a1_hidden() from public, anon, authenticated, service_role`;
        const un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        if (un.length) throw new Error("FALSE_POSITIVE " + JSON.stringify(un));
        throw new Error("ROLLBACK_OK");
      }),
    );
    expect(msg).toMatch(/ROLLBACK_OK/);
  });
});
