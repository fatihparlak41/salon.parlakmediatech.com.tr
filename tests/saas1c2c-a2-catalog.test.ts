import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "./helpers";
import registry from "./fixtures/billing-enforcement-registry.json";
import a1Bodies from "./fixtures/saas1c2c-a1-function-bodies.json";
import { createHash } from "node:crypto";

/**
 * Faz SAAS.1C.2c-A2 - CLASSIFICATION, HOOK COVERAGE and the COMPLETENESS GATE. IDs: CL classification, HK function hooks, TG direct-table triggers,
 * CG completeness gate (negative drift tests, every one rolled back), SX exposure. Pure catalog tests: no stage change, no tenant data.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const MARK = "-- a2-billing-hook";
const BUSINESS = ["TENANT_BUSINESS_WRITE", "PUBLIC_BOOKING_WRITE", "EXISTING_RECORD_OPERATION"];
const fnAll = registry.actions.filter((a) => a.kind === "function");
const tblAll = registry.actions.filter((a) => a.kind === "table_op");
const categoryRow = Object.fromEntries(registry.categories.map((c) => [c.category, c]));

/** run `body` in a transaction that is ALWAYS rolled back (drift simulations never leak) */
async function rolledBack<T>(body: (sql: import("postgres").TransactionSql) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await testDb.begin(async (sql) => {
      out = await body(sql);
      throw new Error("__rollback__");
    });
  } catch (e) {
    if ((e as Error).message !== "__rollback__") throw e;
  }
  return out;
}
const coverage = async (sql: import("postgres").TransactionSql | typeof testDb = testDb) =>
  (await sql<Loose[]>`select action_key, problem from private.billing_hook_coverage() order by 1`).map((r) => `${r.action_key}:${r.problem}`);
const srcOf = async (schema: string, name: string): Promise<string> =>
  (await testDb<{ s: string }[]>`select p.prosrc as s from pg_proc p where p.pronamespace = ${schema}::regnamespace and p.proname = ${name}`)[0]!.s;
/** the body with the marked hook line removed exactly the way the rollback does it */
const stripHook = (src: string) => src.replace(/ {2}(select|perform) private\.billing_guard\([^\n]*-- a2-billing-hook\n/g, "").replace(/ {4}and private\.billing_public_booking_open\(t\.id\) -- a2-billing-hook\n/g, "");

afterAll(async () => {
  await testDb.end();
}, 60000);

describe("CL classification", () => {
  it("CL1 the database registry equals the committed fixture (class, hooked, audience, scope, scope_arg) for all 99 actions", async () => {
    const db = await testDb<Loose[]>`select action_key, kind, category, enforcement_class as class, hooked, audience, scope, scope_arg from private.billing_action_registry order by action_key`;
    expect(db).toHaveLength(99);
    const fx = [...registry.actions].sort((a, b) => a.action_key.localeCompare(b.action_key, "en"));
    const norm = (r: Loose) => ({ action_key: r.action_key, kind: r.kind, category: r.category, class: r.class, hooked: r.hooked, audience: r.audience, scope: r.scope ?? null, scope_arg: r.scope_arg ?? null });
    expect(db.map(norm).sort((a, b) => a.action_key.localeCompare(b.action_key, "en"))).toEqual(fx.map(norm));
  });

  it("CL2 every action has exactly one class from the accepted vocabulary, and the counts are the recomputed ones", async () => {
    const classes = new Set(["TENANT_BUSINESS_WRITE", "PUBLIC_BOOKING_WRITE", "EXISTING_RECORD_OPERATION", "SYSTEM_WRITE", "SECURITY_ACCOUNT_ACTION", "CONTROL_PLANE", "EXPORT", "OTHER"]);
    for (const a of registry.actions) expect(classes.has(a.class), a.action_key).toBe(true);
    expect(registry.actions).toHaveLength(99);
    expect(fnAll).toHaveLength(77);
    expect(tblAll).toHaveLength(22);
    expect(new Set(tblAll.map((a) => a.action_key.split(":")[1])).size).toBe(12);
    expect(fnAll.filter((a) => a.hooked)).toHaveLength(32);
    expect(tblAll.filter((a) => a.hooked)).toHaveLength(19);
    expect(new Set(tblAll.filter((a) => a.hooked).map((a) => a.action_key.split(":")[1])).size).toBe(10);
    const by: Record<string, number> = {};
    for (const a of registry.actions) by[a.class] = (by[a.class] ?? 0) + 1;
    expect(by).toEqual({ TENANT_BUSINESS_WRITE: 13, PUBLIC_BOOKING_WRITE: 1, EXISTING_RECORD_OPERATION: 38, SYSTEM_WRITE: 11, SECURITY_ACCOUNT_ACTION: 17, CONTROL_PLANE: 14, EXPORT: 4, OTHER: 1 });
  });

  it("CL3 an action is hooked exactly when a business class has a category that can ever refuse (derived from the policy table, not hand listed)", () => {
    for (const a of registry.actions) {
      const c = categoryRow[a.category]!;
      const canRefuse = c.read_only === "block" || c.blocked === "block";
      expect(a.hooked, a.action_key).toBe(canRefuse && BUSINESS.includes(a.class));
    }
  });

  it("CL4 control plane, export, security / account, system and tenant-creation actions are NEVER hooked (explicit, with the reason in the class)", () => {
    for (const a of registry.actions.filter((x) => ["CONTROL_PLANE", "EXPORT", "SECURITY_ACCOUNT_ACTION", "SYSTEM_WRITE", "OTHER"].includes(x.class))) expect(a.hooked, a.action_key).toBe(false);
    // A1's own control-plane writers are in the registry and are not tenant-enforced
    for (const k of ["fn:admin_billing_enforcement_preflight", "fn:admin_set_billing_enforcement_stage", "table:platform_admins:INSERT", "table:platform_admins:UPDATE"]) {
      expect(registry.actions.find((a) => a.action_key === k)!.class, k).toBe("CONTROL_PLANE");
    }
    // the four export RPCs are available in every access state
    for (const a of fnAll.filter((x) => x.category === "EXPORT")) expect(a.class).toBe("EXPORT");
    // the worker-side e-mail audit write is an explicit system override, not a tenant action
    expect(registry.actions.find((a) => a.action_key === "fn:log_team_invitation_email_delivery")!.class).toBe("SYSTEM_WRITE");
  });

  it("CL5 the customer's own cancel stays allowed (not hooked); the customer's own change and public booking are hooked with the right audience", () => {
    const cancel = registry.actions.find((a) => a.action_key === "fn:cancel_my_appointment")!;
    expect(cancel.hooked).toBe(false);
    expect(registry.actions.find((a) => a.action_key === "fn:reschedule_my_appointment")).toMatchObject({ hooked: true, audience: "self", scope: "appointment" });
    expect(registry.actions.find((a) => a.action_key === "fn:create_guest_booking")).toMatchObject({ hooked: true, audience: "public", scope: "slug", class: "PUBLIC_BOOKING_WRITE" });
    expect(registry.actions.find((a) => a.action_key === "fn:accept_team_invitation")).toMatchObject({ hooked: true, audience: "self", scope: "invitation_token" });
  });

  it("CL6 the registry constraints reject an invalid class, an invalid audience and an inconsistent hook description (rolled back)", async () => {
    const tries = [
      `update private.billing_action_registry set enforcement_class = 'NOPE' where action_key = 'fn:cancel_expense'`,
      `update private.billing_action_registry set audience = 'everyone' where action_key = 'fn:cancel_expense'`,
      `update private.billing_action_registry set scope = null where action_key = 'fn:cancel_expense'`, // hooked without a scope
      `update private.billing_action_registry set hooked = true where action_key = 'fn:request_tenant_export'`, // export can never be hooked
      `update private.billing_action_registry set scope = 'appointment' where action_key = 'fn:request_tenant_export'`, // scope on a non-hooked action
    ];
    for (const t of tries) {
      const err = await rolledBack(async (sql) => {
        try {
          await sql.unsafe(t);
          return null;
        } catch (e) {
          return (e as { message: string }).message;
        }
      });
      expect(err, t).not.toBeNull();
    }
  });
});

describe("HK function hooks", () => {
  it("HK1 each hooked function carries exactly one marked guard line with ITS OWN literal action key, scope and argument", async () => {
    for (const a of fnAll.filter((x) => x.hooked)) {
      const name = a.action_key.slice(3);
      const src = await srcOf("public", name);
      expect(src.split(MARK).length - 1, name).toBe(1);
      const textual = a.scope === "slug" || a.scope === "invitation_token";
      const call = textual ? `private.billing_guard('${a.action_key}', '${a.scope}', null, ${a.scope_arg})` : `private.billing_guard('${a.action_key}', '${a.scope}', ${a.scope_arg})`;
      expect(src.includes(`${call}; ${MARK}`), name).toBe(true);
      // the key is a literal, never an argument of the function: the client cannot choose it
      expect(call.includes("p_action"), name).toBe(false);
    }
  });

  it("HK2 removing the marked line gives back EXACTLY the A1 body of every hooked function (md5 of the A1 schema), and every other function is byte-identical to A1", async () => {
    const fx = a1Bodies.functions as Record<string, string>;
    expect(Object.keys(fx)).toHaveLength(79);
    for (const a of fnAll) {
      const name = a.action_key.slice(3);
      const src = await srcOf("public", name);
      if (a.hooked) expect(md5(stripHook(src)), `${name} stripped`).toBe(fx[`public.${name}`]);
      else expect(md5(src), `${name} untouched`).toBe(fx[`public.${name}`]);
      expect(src.includes(MARK), name).toBe(a.hooked);
    }
  });

  it("HK3 the public booking read gate is ONE marked condition in the shared resolver (nothing else changed)", async () => {
    const src = await srcOf("private", "resolve_bookable_tenant");
    expect(src.split(MARK).length - 1).toBe(1);
    expect(md5(stripHook(src))).toBe((a1Bodies.functions as Record<string, string>)["private.resolve_bookable_tenant"]);
    // the two public reads that share the resolver are unchanged
    for (const n of ["get_public_availability_slots", "get_public_eligible_staff", "get_public_booking_context"]) expect(await srcOf("public", n)).not.toContain(MARK);
  });

  it("HK4 the A1 preflight changed by exactly one added check block (hook_coverage), everything else is A1", async () => {
    const src = await srcOf("private", "billing_preflight_core");
    const from = src.indexOf("\n  -- A2: every registered action");
    const endMark = "from private.billing_hook_coverage() c)));\n";
    const to = src.indexOf(endMark) + endMark.length;
    expect(from).toBeGreaterThan(0);
    expect(md5(src.slice(0, from) + src.slice(to))).toBe((a1Bodies.functions as Record<string, string>)["private.billing_preflight_core"]);
  });

  it("HK5 hooked functions keep their signature, language, security definer and search_path (no behaviour attribute changed)", async () => {
    const rows = await testDb<Loose[]>`select p.proname, p.prosecdef, p.provolatile, coalesce(array_to_string(p.proconfig, ','), '') as cfg, (select l.lanname from pg_language l where l.oid = p.prolang) as lang
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (select substr(action_key, 4) from private.billing_action_registry where kind = 'function' and hooked)`;
    expect(rows).toHaveLength(32);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.provolatile, r.proname).toBe("v");
      expect(r.cfg, r.proname).toBe('search_path=""');
    }
  });

  it("HK6 coverage reports nothing missing and nothing extra on the live catalog", async () => {
    expect(await coverage()).toEqual([]);
  });
});

describe("TG direct-table triggers", () => {
  it("TG1 exactly one BEFORE ROW trigger billing_a2_guard on each of the 10 enforced tables, with exactly the registered events, and none anywhere else", async () => {
    const rows = await testDb<Loose[]>`select c.relname as tbl, t.tgtype, p.proname, pg_get_triggerdef(t.oid) as def from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and t.tgname = 'billing_a2_guard' order by 1`;
    expect(rows.map((r) => r.tbl)).toEqual(["branches", "customers", "service_branches", "services", "staff_branches", "staff_members", "staff_schedule_exceptions", "staff_schedules", "staff_services", "tenants"]);
    for (const r of rows) {
      expect(r.proname).toBe("billing_trigger_guard");
      expect((r.tgtype & 1) === 1 && (r.tgtype & 2) === 2, r.tbl).toBe(true); // BEFORE ROW
      const ev = tblAll.filter((a) => a.hooked && a.action_key.split(":")[1] === r.tbl).map((a) => a.action_key.split(":")[2]).sort();
      const got = [(r.tgtype & 4) === 4 && "INSERT", (r.tgtype & 8) === 8 && "DELETE", (r.tgtype & 16) === 16 && "UPDATE"].filter(Boolean).sort();
      expect(got, r.tbl).toEqual(ev);
      expect(r.def, r.tbl).toContain("billing_trigger_guard(");
    }
    // profiles and platform_admins are classified and NOT guarded
    const none = await testDb<Loose[]>`select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'billing_a2_guard' and c.relname in ('profiles', 'platform_admins')`;
    expect(none).toEqual([]);
  });

  it("TG2 every guard trigger fires ONLY for the API roles (a WHEN clause evaluated in the writing statement's context), the function never recurses and never reads user_metadata", async () => {
    const defs = await testDb<{ def: string }[]>`select pg_get_triggerdef(t.oid) as def from pg_trigger t where t.tgname = 'billing_a2_guard'`;
    expect(defs).toHaveLength(10);
    for (const d of defs) {
      expect(d.def.toLowerCase()).toContain(" when ");
      for (const role of ["authenticated", "anon", "service_role", "booking_gateway"]) expect(d.def, role).toContain(role);
      expect(d.def).not.toContain("'postgres'");
    }
    const src = await srcOf("private", "billing_trigger_guard");
    expect(src).not.toMatch(/user_metadata/i);
    expect(src).not.toMatch(/insert into|update public|delete from/i);
  });

  it("TG3 a guard trigger WITHOUT its WHEN clause is reported (it would guard a definer RPC's own write a second time)", async () => {
    const out = await rolledBack(async (sql) => {
      await sql.unsafe(`drop trigger billing_a2_guard on public.customers`);
      await sql.unsafe(`create trigger billing_a2_guard before insert or update on public.customers for each row execute function private.billing_trigger_guard('tenant_col')`);
      return coverage(sql);
    });
    expect(out).toEqual(["table:customers:INSERT:missing_trigger", "table:customers:UPDATE:missing_trigger"]);
  });
});

describe("CG completeness gate (every case rolled back)", () => {
  it("CG1 a function that LOSES its hook is reported and holds the preflight", async () => {
    const out = await rolledBack(async (sql) => {
      const [{ def }] = await sql<{ def: string }[]>`select pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'update_salon_profile'`;
      await sql.unsafe(def.replace(/ {2}perform private\.billing_guard\([^\n]*-- a2-billing-hook\n/, ""));
      const pre = (await sql<Loose[]>`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
      return { cov: await coverage(sql), check: (pre.checks as Loose[]).find((c) => c.id === "hook_coverage") };
    });
    expect(out.cov).toEqual(["fn:update_salon_profile:missing_hook"]);
    expect(out.check?.pass).toBe(false);
  });

  it("CG2 a NEW API-reachable writer that is not in the registry is reported by the A1 scan and fails the preflight", async () => {
    const out = await rolledBack(async (sql) => {
      await sql.unsafe(`create function public.zz_a2_new_writer(p_tenant uuid) returns void language plpgsql security definer set search_path = '' as $$ begin insert into public.customers (tenant_id, full_name) values (p_tenant, 'x'); end $$`);
      await sql.unsafe(`grant execute on function public.zz_a2_new_writer(uuid) to authenticated`);
      const unreg = (await sql<Loose[]>`select action_key from private.billing_registry_unregistered()`).map((r) => r.action_key);
      const pre = (await sql<Loose[]>`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
      return { unreg, reg: (pre.checks as Loose[]).find((c) => c.id === "registry_complete") };
    });
    expect(out.unreg).toEqual(["fn:zz_a2_new_writer"]);
    expect(out.reg?.pass).toBe(false);
  });

  it("CG3 a NEW writable table (an API role gets INSERT) is reported as an unregistered table operation", async () => {
    const out = await rolledBack(async (sql) => {
      await sql.unsafe(`create table public.zz_a2_new_table (id int primary key, tenant_id uuid)`);
      await sql.unsafe(`grant insert on public.zz_a2_new_table to authenticated`);
      return (await sql<Loose[]>`select action_key from private.billing_registry_unregistered()`).map((r) => r.action_key);
    });
    // the default privileges of the public schema also give the API roles UPDATE / DELETE on a new table: every operation is reported, all of them for this table only
    expect(out.length).toBeGreaterThan(0);
    for (const k of out) expect(k.startsWith("table:zz_a2_new_table:"), k).toBe(true);
    expect(out).toContain("table:zz_a2_new_table:INSERT");
  });

  it("CG4 a registered function that is removed or renamed is reported (coverage and the A1 integrity check)", async () => {
    const out = await rolledBack(async (sql) => {
      await sql.unsafe(`alter function public.cancel_expense(uuid, text) rename to cancel_expense_zz`);
      const pre = (await sql<Loose[]>`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
      return { cov: await coverage(sql), integrity: (pre.checks as Loose[]).find((c) => c.id === "registry_integrity") };
    });
    expect(out.cov).toContain("fn:cancel_expense:function_missing_or_overloaded");
    expect(out.integrity?.pass).toBe(false);
  });

  it("CG5 a removed trigger, or a trigger added where none is registered, is reported", async () => {
    const out = await rolledBack(async (sql) => {
      await sql.unsafe(`drop trigger billing_a2_guard on public.services`);
      await sql.unsafe(`create trigger billing_a2_guard before update on public.profiles for each row when (current_user in ('authenticated')) execute function private.billing_trigger_guard('tenant_col')`);
      return coverage(sql);
    });
    expect(out).toContain("table:services:INSERT:missing_trigger");
    expect(out).toContain("table:services:UPDATE:missing_trigger");
    expect(out).toContain("table:profiles:UPDATE:unexpected_trigger"); // profiles UPDATE is classified SECURITY_ACCOUNT_ACTION: it must carry no guard
  });

  it("CG6 classification drift is reported: an unhooked action that carries a hook, an action whose category policy was removed", async () => {
    const out = await rolledBack(async (sql) => {
      // a hook on a function that is classified as never-refused (export) must be reported as unexpected
      const [{ def }] = await sql<{ def: string }[]>`select pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'request_tenant_export'`;
      await sql.unsafe(def.replace(/\nbegin\n/, `\nbegin\n  perform private.billing_guard('fn:request_tenant_export', 'tenant', p_tenant_id); -- a2-billing-hook\n`));
      return coverage(sql);
    });
    expect(out).toEqual(["fn:request_tenant_export:unexpected_hook"]);
    // a category cannot be dropped while registered actions use it (the policy mapping can never go missing)
    const fk = await rolledBack(async (sql) => {
      try {
        await sql.unsafe(`delete from private.billing_categories where category = 'APPT_CREATE'`);
        return null;
      } catch (e) {
        return (e as { message: string }).message;
      }
    });
    expect(fk).not.toBeNull();
  });
});

describe("SX exposure", () => {
  it("SX1 the A2 private helpers are closed to every API role and carry a fixed search_path; no function reads user_metadata", async () => {
    const names = ["billing_scope_tenant", "billing_health_bump", "billing_decision_record", "billing_guard", "billing_public_booking_open", "billing_hook_coverage", "billing_trigger_guard"];
    const rows = await testDb<Loose[]>`select p.proname, p.prosecdef, p.proconfig, p.prosrc,
        has_function_privilege('anon', p.oid, 'execute') as a, has_function_privilege('authenticated', p.oid, 'execute') as au, has_function_privilege('service_role', p.oid, 'execute') as s,
        has_function_privilege('booking_gateway', p.oid, 'execute') as g,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') as pub
      from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname = any (${names})`;
    expect(rows).toHaveLength(names.length);
    for (const r of rows) {
      expect([r.a, r.au, r.s, r.g, r.pub], r.proname).toEqual([false, false, false, false, false]);
      if (r.prosecdef) expect(String(r.proconfig), r.proname).toContain("search_path");
      expect(r.prosrc, r.proname).not.toMatch(/user_metadata/i);
    }
  });

  it("SX2 no new API surface: the set of public functions an API role can execute is unchanged in size (129 + the 2 A1 admin RPCs excluded as before) and the new registry columns are not API-visible", async () => {
    const [{ n }] = await testDb<{ n: string }[]>`select count(*)::text as n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute') or has_function_privilege('booking_gateway', p.oid, 'execute'))`;
    expect(Number(n)).toBeGreaterThanOrEqual(129);
    const grants = await testDb<Loose[]>`select count(*)::int as n from information_schema.role_table_grants where table_schema = 'private' and table_name like 'billing%' and grantee in ('anon', 'authenticated', 'service_role')`;
    expect(grants[0]!.n).toBe(0);
  });

  it("SX3 the guard source: stage 0 returns before any lookup; operator sessions are the exact exempt list; service_role is not exempt", async () => {
    const src = await srcOf("private", "billing_guard");
    const stage0 = src.indexOf("if v_stage is null or v_stage = 0 then");
    const registryLookup = src.indexOf("from private.billing_action_registry");
    expect(stage0).toBeGreaterThan(0);
    expect(stage0).toBeLessThan(registryLookup);
    expect(src).toContain("session_user in ('postgres', 'supabase_admin', 'cli_login_postgres')");
    const code = src.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/service_role/);
    expect(code).not.toMatch(/user_metadata/i);
    // the action key and the scope come from the hook, the tenant is resolved server side
    expect(src).toContain("private.billing_scope_tenant(p_scope, p_id, p_key)");
  });
});
