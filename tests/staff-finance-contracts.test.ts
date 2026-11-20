import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb, createStaffFinanceWorld, destroyStaffFinanceWorld, type StaffFinanceWorld } from "./staff-finance-fixtures";

/**
 * Faz FIN.1C.1 — contract and static tests (matrix groups CT, plus the static rows TR28, S17, VR11, CUR6). These read the
 * catalog and the migration text only (no data is written), so they run on any database that carries M1 and M2.
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to whatever
 * TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV database).
 */

const MIGRATION = path.join(process.cwd(), "supabase/migrations/20261007120100_staff_finance_periods_and_payments.sql");

let world: StaffFinanceWorld;
beforeAll(async () => {
  world = await createStaffFinanceWorld("fin1c1-ct");
});
afterAll(async () => {
  await destroyStaffFinanceWorld(world);
});

/** `-- ...` line comments removed (dollar-quoted bodies keep their code). */
const stripComments = (src: string) => src.replace(/--[^\n]*/g, "");

const WRITE_RPCS = [
  "create_staff_finance_period",
  "update_staff_finance_period",
  "add_staff_period_line",
  "update_staff_period_line",
  "void_staff_period_line",
  "finalize_staff_finance_period",
  "reopen_staff_finance_period",
  "cancel_staff_finance_period",
  "record_staff_payment",
  "void_staff_payment",
];
const TRIGGER_FUNCTIONS = ["enforce_staff_period_invariants", "enforce_staff_line_invariants", "enforce_staff_payment_invariants", "recalculate_staff_period_totals"];
const ALL_PRIVATE = [...WRITE_RPCS, ...TRIGGER_FUNCTIONS, "post_staff_payment", "list_finance_staff", "list_staff_line_kinds", "get_staff_finance_period", "get_staff_finance_overview", "staff_period_live_totals", "normalize_staff_finance_text", "normalize_staff_finance_amount", "normalize_staff_finance_month", "staff_period_create_fingerprint", "staff_line_add_fingerprint", "normalize_staff_payment_input"];

async function bodies(schema: "private" | "public", names: string[]): Promise<Record<string, string>> {
  const rows = await testDb<{ proname: string; prosrc: string }[]>`
    select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schema} and p.proname in ${testDb(names)}`;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.proname] = r.prosrc;
  for (const n of names) expect(out[n], `${schema}.${n} exists`).toBeTruthy();
  return out;
}

describe("CT1 private.tenant_local_date is what FIN.1B.1 defined and the staff ledger relies on", () => {
  it("pins the signature, volatility, security and search path, an owner-only ACL, and the definition", async () => {
    const [row] = await testDb<{ args: string; ret: string; volatile: string; secdef: boolean; config: string[] | null; acl: string[] | null; src: string }[]>`
      select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as ret, p.provolatile::text as volatile,
             p.prosecdef as secdef, p.proconfig as config, p.proacl::text[] as acl, p.prosrc as src
      from pg_proc p where p.oid = 'private.tenant_local_date'::regproc`;
    expect(row!.args).toBe("p_tenant_id uuid");
    expect(row!.ret).toBe("date");
    expect(row!.volatile).toBe("s");
    expect(row!.secdef).toBe(true);
    expect(row!.config).toEqual(['search_path=""']);
    expect((row!.acl ?? []).filter((a) => /^(anon|authenticated|service_role|=)/.test(a))).toEqual([]);
    expect(row!.src.replace(/\s+/g, " ").trim()).toBe("select (now() at time zone t.timezone)::date from public.tenants t where t.id = p_tenant_id;");
  });

  it("behaves as relied on: the local calendar date of now in the tenant's own timezone, for zones on both sides of UTC", async () => {
    for (const tz of ["Europe/Istanbul", "UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York", "Europe/Berlin"]) {
      await testDb`update tenants set timezone = ${tz} where id = ${world.tenant.id}`;
      const [row] = await testDb<{ got: string; want: string }[]>`
        select to_char(private.tenant_local_date(${world.tenant.id}), 'YYYY-MM-DD') as got,
               to_char((now() at time zone ${tz})::date, 'YYYY-MM-DD') as want`;
      expect(row!.got, tz).toBe(row!.want);
    }
    await testDb`update tenants set timezone = 'Europe/Istanbul' where id = ${world.tenant.id}`;
    const [none] = await testDb<{ d: string | null }[]>`select private.tenant_local_date('00000000-0000-4000-8000-0000000000c1') as d`;
    expect(none!.d).toBeNull();
  });
});

describe("TR28 / CT4 lock order: the RPC and trigger bodies lock the period row before any child row (static)", () => {
  /** The tables an explicit `for update` locks, in text order. */
  function explicitLocks(src: string): string[] {
    const code = stripComments(src);
    const out: { at: number; table: string }[] = [];
    const re = /\bfrom\s+public\.(staff_finance_periods|staff_period_lines|staff_payments)\b[^;]*?\bfor\s+update\b/gis;
    for (let m = re.exec(code); m; m = re.exec(code)) out.push({ at: m.index, table: m[1]! });
    return out.sort((a, b) => a.at - b.at).map((x) => x.table);
  }

  it("in every write RPC, helper and trigger function the period lock comes first and no child lock precedes it", async () => {
    const all = { ...(await bodies("private", [...WRITE_RPCS, ...TRIGGER_FUNCTIONS, "post_staff_payment"])) };
    for (const [name, src] of Object.entries(all)) {
      const locks = explicitLocks(src);
      const firstChild = locks.findIndex((t) => t !== "staff_finance_periods");
      const firstPeriod = locks.indexOf("staff_finance_periods");
      if (firstChild !== -1) {
        expect(firstPeriod, `${name} locks a child row without ever locking the period (${locks.join(" -> ")})`).not.toBe(-1);
        expect(firstPeriod, `${name} locks a child row before the period (${locks.join(" -> ")})`).toBeLessThan(firstChild);
      }
    }
  });

  it("the RPCs that take a child id read the period id WITHOUT a lock, then lock the period, then the child", async () => {
    const b = await bodies("private", ["update_staff_period_line", "void_staff_period_line", "void_staff_payment"]);
    for (const [name, src] of Object.entries(b)) {
      const locks = explicitLocks(src);
      expect(locks[0], `${name}: first explicit lock`).toBe("staff_finance_periods");
      expect(locks.length, `${name}: period then child`).toBe(2);
    }
    // and every id-keyed write RPC locks the period before it asks about permission or state
    for (const name of WRITE_RPCS) {
      const src = stripComments((await bodies("private", [name]))[name]!);
      const lock = src.search(/staff_finance_periods[^;]*\bfor\s+update\b/i);
      const perm = src.search(/private\.has_permission/i);
      if (name !== "create_staff_finance_period") expect(lock, `${name} locks the period`).toBeGreaterThan(-1);
      if (name !== "create_staff_finance_period") expect(lock, `${name}: the period lock precedes the permission check`).toBeLessThan(perm);
    }
  });
});

describe("S17 no delete: no DELETE privilege and no function body deleting from the four tables", () => {
  it("no role can delete from the tables and no function body deletes from or truncates them", async () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      for (const table of ["staff_line_kinds", "staff_finance_periods", "staff_period_lines", "staff_payments"]) {
        const [row] = await testDb<{ ok: boolean }[]>`select has_table_privilege(${role}, ${"public." + table}, 'DELETE') as ok`.catch(() => [{ ok: false }]);
        expect(row!.ok, `${role} DELETE on ${table}`).toBe(false);
      }
    }
    const rows = await testDb<{ nspname: string; proname: string; prosrc: string }[]>`
      select n.nspname, p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'private' and p.proname in ${testDb(ALL_PRIVATE)}) or (n.nspname = 'public' and p.proname in ${testDb([...WRITE_RPCS, "list_finance_staff", "list_staff_line_kinds", "get_staff_finance_period", "get_staff_finance_overview"])})`;
    expect(rows.length, "the scan covers the whole function inventory (14 wrappers + 14 private RPCs + 8 helpers + 4 trigger functions)").toBe(40);
    for (const r of rows) {
      const code = stripComments(r.prosrc);
      expect(code, `${r.nspname}.${r.proname}`).not.toMatch(/\bdelete\s+from\s+(public\.)?staff_(finance_periods|period_lines|payments|line_kinds)\b/i);
      expect(code, `${r.nspname}.${r.proname}`).not.toMatch(/\btruncate\b/i);
    }
  });
});

describe("VR11 no RPC assigns version or updated_at", () => {
  it("only the triggers (T1 for periods, T2 for lines) write version and updated_at", async () => {
    const b = await bodies("private", [...WRITE_RPCS, "post_staff_payment"]);
    for (const [name, src] of Object.entries(b)) {
      const code = stripComments(src);
      expect(code, `${name} assigns version`).not.toMatch(/\bset\b[^;]*\bversion\s*=/is);
      expect(code, `${name} assigns updated_at`).not.toMatch(/\bset\b[^;]*\bupdated_at\s*=/is);
      expect(code, `${name} assigns NEW.version`).not.toMatch(/\bnew\.(version|updated_at)\s*:?=/i);
    }
    const triggers = await bodies("private", TRIGGER_FUNCTIONS);
    expect(stripComments(triggers.enforce_staff_period_invariants!)).toMatch(/new\.version\s*:=\s*old\.version\s*\+\s*1/);
  });
});

describe("CUR6 no literal currency code is assumed in the SQL", () => {
  it("the migration text holds no quoted currency code outside comments", () => {
    const code = stripComments(readFileSync(MIGRATION, "utf8"));
    expect(code).not.toMatch(/'(TRY|TL|USD|EUR|GBP)'/);
  });
});
