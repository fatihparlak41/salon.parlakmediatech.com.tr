import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createStaffFinanceWorld,
  destroyStaffFinanceWorld,
  callRpc,
  callRpcNoJwt,
  callRpcAsAnon,
  callRpcAsRole,
  makePeriod,
  makeLine,
  makePayment,
  finalizePeriod,
  getOverview,
  getPeriod,
  listStaff,
  listKinds,
  newKey,
  newStaff,
  instantAgo,
  expectOk,
  periodRow,
  counts,
  tenantDigest,
  STAFF_FINANCE_WRAPPERS,
  STAFF_FINANCE_READ_WRAPPERS,
  STAFF_FINANCE_WRITE_WRAPPERS,
  KIND_CATALOG,
  type StaffFinanceWorld,
  type RpcOutcome,
  type RpcArg,
} from "./staff-finance-fixtures";
import {
  MANAGER_KEYS,
  RECEPTION_KEYS,
  PERSONEL_KEYS,
} from "./default-role-matrix";

/**
 * Faz FIN.1C.1 — catalog, grants, RLS, permissions and privacy (matrix groups S, CAT, P, CUR). These assertions are
 * UNCONDITIONAL on purpose: they fail loudly when an expected FIN.1C.1 object is missing, which the schema-era-aware
 * global grants regression test (security-grants-regression.test.ts) deliberately does not.
 *
 * NOTE for whoever runs this file next: it needs migrations 20261007120000 (M1) and 20261007120100 (M2) applied to
 * whatever TEST_DATABASE_URL points at (a disposable PROD-derived branch or the local rig, never the shared DEV
 * database).
 */

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const M1 = path.join(MIGRATIONS, "20261007120000_staff_finance_permission_keys.sql");
const M2 = path.join(MIGRATIONS, "20261007120100_staff_finance_periods_and_payments.sql");
const FIN1A_MIGRATION = path.join(MIGRATIONS, "20260929120000_appointment_checkout_and_payments.sql");
const FIN1B1_MIGRATION = path.join(MIGRATIONS, "20261003090000_expense_obligations_and_settlements.sql");
const FIN1A_SHA256 = "28d8a74aec16feaa878ee0c28a0e0999b23a9e03775ab9b5164f2c871f1f2731";
const FIN1B1_SHA256 = "50ac6cd0de7774d601f72ac4c392b26aa931f8cd96776ce2d19db4f64165db97";

let world: StaffFinanceWorld;

beforeAll(async () => {
  world = await createStaffFinanceWorld("fin1c1-sec");
});

afterAll(async () => {
  await destroyStaffFinanceWorld(world);
});

const T = () => world.tenant.id;

function failure(out: RpcOutcome<unknown>): string | undefined {
  expect(out.ok, `expected a failure, got ${JSON.stringify(out)}`).toBe(false);
  return out.ok ? undefined : out.code;
}

/**
 * The REQUIRED named arguments (those without a default) of a public wrapper, read from the catalog and filled with
 * harmless dummy values. A call that names an argument the function does not have resolves to no function at all
 * (SQLSTATE 42883) and would hide the grant check, so the id-based wrappers (p_period_id, p_line_id, p_payment_id) must
 * not be probed with p_tenant_id.
 */
async function requiredArgsOf(fn: string): Promise<RpcArg[]> {
  const [row] = await testDb<{ names: string[]; types: string[]; n: number; d: number }[]>`
    select p.proargnames as names,
           array(select format_type(t, null) from unnest(p.proargtypes::oid[]) as t) as types,
           p.pronargs::int as n,
           p.pronargdefaults::int as d
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = ${fn}`;
  expect(row, `wrapper ${fn} exists`).toBeTruthy();
  const dummy = (type: string): unknown => {
    switch (type) {
      case "uuid":
        return T();
      case "text":
        return "probe";
      case "numeric":
        return 1;
      case "integer":
        return 1;
      case "date":
        return "2026-01-01";
      case "timestamp with time zone":
        return "2026-01-01T00:00:00Z";
      default:
        throw new Error(`no dummy value for argument type ${type} of ${fn}`);
    }
  };
  return row!.names.slice(0, row!.n - row!.d).map((name, i) => [name, dummy(row!.types[i]!), row!.types[i]!] as const);
}

/**
 * Splits a migration into top-level statements: skips line comments, keeps single-quoted literals (with '' escapes)
 * whole and collapses dollar-quoted bodies to $$. A semicolon inside a `comment on ... is '...'` text is not a split.
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const flush = () => {
    const s = cur.replace(/\s+/g, " ").trim();
    if (s) out.push(s);
    cur = "";
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        const q = sql.indexOf("'", j);
        if (q === -1) throw new Error("unterminated string literal in the migration");
        if (sql[q + 1] === "'") {
          j = q + 2;
          continue;
        }
        j = q + 1;
        break;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end === -1) throw new Error("unterminated dollar-quoted body in the migration");
        cur += "$$";
        i = end + m[0].length;
        continue;
      }
    }
    if (ch === ";") {
      flush();
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  flush();
  return out;
}

const STAFF_TABLES = ["staff_line_kinds", "staff_finance_periods", "staff_period_lines", "staff_payments"] as const;
const FIN1A_TABLES = ["appointment_sales", "appointment_sale_items", "payments"] as const;
const FIN1B1_TABLES = ["expense_categories", "expenses", "expense_payments"] as const;

// =================================================================================================================
// S — schema, catalog, grants, RLS
// =================================================================================================================
describe("S schema, catalog, grants, RLS", () => {
  it("S0 preflight: both migrations are applied, the four tables, the M1 keys and the FIN.1A and FIN.1B.1 tables exist", async () => {
    const [head] = await testDb<{ head: string | null; m1: boolean; m2: boolean }[]>`
      select (select max(version) from supabase_migrations.schema_migrations) as head,
             exists (select 1 from supabase_migrations.schema_migrations where version = '20261007120000') as m1,
             exists (select 1 from supabase_migrations.schema_migrations where version = '20261007120100') as m2`;
    expect(head!.m1, "migration 20261007120000 is not recorded: apply it to the target database first").toBe(true);
    expect(head!.m2, "migration 20261007120100 is not recorded: apply it to the target database first").toBe(true);
    expect(head!.head! >= "20261007120100").toBe(true);
    for (const table of [...STAFF_TABLES, ...FIN1A_TABLES, ...FIN1B1_TABLES]) {
      const [row] = await testDb<{ present: boolean }[]>`select to_regclass(${`public.${table}`}) is not null as present`;
      expect(row!.present, `table public.${table} must exist`).toBe(true);
    }
    const keys = await testDb<{ key: string }[]>`select key from permissions where key like 'finance.staff_%' order by key`;
    expect(keys.map((k) => k.key)).toEqual(["finance.staff_manage", "finance.staff_view"]);
  });

  const columnSpec: Record<string, [string, string, boolean, string | null, string][]> = {
    staff_line_kinds: [
      ["code", "text", false, null, ""],
      ["line_group", "text", false, null, ""],
      ["institution", "text", true, null, ""],
      ["is_adjustment", "boolean", false, "false", ""],
      ["display_order", "smallint", false, null, ""],
      ["is_active", "boolean", false, "true", ""],
      ["created_at", "timestamp with time zone", false, "now()", ""],
    ],
    staff_finance_periods: [
      ["id", "uuid", false, "gen_random_uuid()", ""],
      ["tenant_id", "uuid", false, null, ""],
      ["staff_member_id", "uuid", false, null, ""],
      ["staff_display_name", "text", false, null, ""],
      ["period_month", "date", false, null, ""],
      ["currency", "text", false, null, ""],
      ["lifecycle", "text", false, "'open'::text", ""],
      ["due_date", "date", true, null, ""],
      ["earning_total", "numeric(12,2)", false, "0", ""],
      ["employee_deduction_total", "numeric(12,2)", false, "0", ""],
      ["employer_cost_total", "numeric(12,2)", false, "0", ""],
      ["paid_total", "numeric(12,2)", false, "0", ""],
      ["advance_total", "numeric(12,2)", false, "0", ""],
      ["content_revision", "integer", false, "0", ""],
      ["net_payable", "numeric(12,2)", true, "GENERATED", "s"],
      ["payment_state", "text", true, "GENERATED", "s"],
      ["finalized_earning_total", "numeric(12,2)", true, null, ""],
      ["finalized_deduction_total", "numeric(12,2)", true, null, ""],
      ["finalized_net_payable", "numeric(12,2)", true, null, ""],
      ["version", "integer", false, "1", ""],
      ["idempotency_key", "uuid", false, null, ""],
      ["idempotency_fingerprint", "text", false, null, ""],
      ["finalized_at", "timestamp with time zone", true, null, ""],
      ["finalized_by", "uuid", true, null, ""],
      ["cancelled_at", "timestamp with time zone", true, null, ""],
      ["cancelled_by", "uuid", true, null, ""],
      ["cancel_reason", "text", true, null, ""],
      ["created_by", "uuid", true, null, ""],
      ["created_at", "timestamp with time zone", false, "now()", ""],
      ["updated_at", "timestamp with time zone", false, "now()", ""],
    ],
    staff_period_lines: [
      ["id", "uuid", false, "gen_random_uuid()", ""],
      ["tenant_id", "uuid", false, null, ""],
      ["period_id", "uuid", false, null, ""],
      ["currency", "text", false, null, ""],
      ["kind", "text", false, null, ""],
      ["line_group", "text", false, null, ""],
      ["institution", "text", true, null, ""],
      ["amount", "numeric(12,2)", false, null, ""],
      ["description", "text", true, null, ""],
      ["calculation_source", "text", false, "'manual'::text", ""],
      ["status", "text", false, "'active'::text", ""],
      ["post_finalization", "boolean", false, "false", ""],
      ["idempotency_key", "uuid", false, null, ""],
      ["idempotency_fingerprint", "text", false, null, ""],
      ["created_by", "uuid", true, null, ""],
      ["created_at", "timestamp with time zone", false, "now()", ""],
      ["updated_at", "timestamp with time zone", false, "now()", ""],
      ["voided_by", "uuid", true, null, ""],
      ["voided_at", "timestamp with time zone", true, null, ""],
      ["void_reason", "text", true, null, ""],
    ],
    staff_payments: [
      ["id", "uuid", false, "gen_random_uuid()", ""],
      ["tenant_id", "uuid", false, null, ""],
      ["period_id", "uuid", false, null, ""],
      ["currency", "text", false, null, ""],
      ["purpose", "text", false, null, ""],
      ["method", "text", false, null, ""],
      ["amount", "numeric(12,2)", false, null, ""],
      ["paid_at", "timestamp with time zone", false, "now()", ""],
      ["note", "text", true, null, ""],
      ["status", "text", false, "'posted'::text", ""],
      ["post_finalization", "boolean", false, "false", ""],
      ["idempotency_key", "uuid", false, null, ""],
      ["created_by", "uuid", true, null, ""],
      ["created_at", "timestamp with time zone", false, "now()", ""],
      ["voided_by", "uuid", true, null, ""],
      ["voided_at", "timestamp with time zone", true, null, ""],
      ["void_reason", "text", true, null, ""],
    ],
  };

  it.each(STAFF_TABLES)("S1 columns of %s: exact names, types, nullability, defaults and generated flags", async (table) => {
    const rows = await testDb<{ name: string; type: string; nullable: boolean; def: string | null; gen: string }[]>`
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
             pg_get_expr(d.adbin, d.adrelid) as def, a.attgenerated::text as gen
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = 'public' and c.relname = ${table} and a.attnum > 0 and not a.attisdropped
      order by a.attnum`;
    // the text of a generated expression is version-dependent: the S19 / HLP9 / TR tests pin its behaviour instead
    const actual = rows.map((r) => [r.name, r.type, r.nullable, r.gen === "s" ? "GENERATED" : r.def, r.gen]);
    expect(actual).toEqual(columnSpec[table]);
    // a payment carries no line reference; a period carries the snapshot columns; lines and payments carry post_finalization
    if (table === "staff_payments") expect(rows.map((r) => r.name)).not.toContain("line_id");
    if (table === "staff_finance_periods") expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["content_revision", "finalized_net_payable"]));
    // no institution or rule objects exist in FIN.1C.1
    for (const forbidden of ["staff_institution_obligations", "staff_institution_payments", "statutory_rules", "staff_statutory_profiles"]) {
      const [row] = await testDb<{ present: boolean }[]>`select to_regclass(${`public.${forbidden}`}) is not null as present`;
      expect(row!.present, `${forbidden} must not exist in FIN.1C.1`).toBe(false);
    }
  });

  const constraintSpec: Record<string, string[]> = {
    staff_line_kinds: [
      "staff_line_kinds_adjustment_shape",
      "staff_line_kinds_code_format",
      "staff_line_kinds_display_order_positive",
      "staff_line_kinds_group_check",
      "staff_line_kinds_institution_check",
      "staff_line_kinds_institution_group",
      "staff_line_kinds_pkey",
    ],
    staff_finance_periods: [
      "staff_finance_periods_cancelled_by_fkey",
      "staff_finance_periods_created_by_fkey",
      "staff_finance_periods_finalized_by_fkey",
      "staff_finance_periods_pkey",
      "staff_finance_periods_tenant_id_fkey",
      "staff_periods_advance_within_paid",
      "staff_periods_cancel_reason_length",
      "staff_periods_cancel_state",
      "staff_periods_content_revision_nonneg",
      "staff_periods_currency_not_blank",
      "staff_periods_deductions_within_earning",
      "staff_periods_due_date_range",
      "staff_periods_fingerprint_format",
      "staff_periods_finalize_state",
      "staff_periods_finalized_paid_within_net",
      "staff_periods_id_tenant_currency_unique",
      "staff_periods_id_tenant_unique",
      "staff_periods_idempotency_key_unique",
      "staff_periods_lifecycle_check",
      "staff_periods_month_first_day",
      "staff_periods_month_range",
      "staff_periods_name_length",
      "staff_periods_snapshot_state",
      "staff_periods_staff_fk",
      "staff_periods_totals_nonneg",
      "staff_periods_version_positive",
    ],
    staff_period_lines: [
      "staff_lines_amount_positive",
      "staff_lines_description_length",
      "staff_lines_fingerprint_format",
      "staff_lines_group_check",
      "staff_lines_id_tenant_unique",
      "staff_lines_idempotency_key_unique",
      "staff_lines_institution_check",
      "staff_lines_institution_group",
      "staff_lines_period_fk",
      "staff_lines_source_check",
      "staff_lines_status_check",
      "staff_lines_void_reason_length",
      "staff_lines_void_state",
      "staff_period_lines_created_by_fkey",
      "staff_period_lines_kind_fkey",
      "staff_period_lines_pkey",
      "staff_period_lines_tenant_id_fkey",
      "staff_period_lines_voided_by_fkey",
    ],
    staff_payments: [
      "staff_payments_amount_positive",
      "staff_payments_created_by_fkey",
      "staff_payments_idempotency_key_unique",
      "staff_payments_method_check",
      "staff_payments_note_length",
      "staff_payments_paid_at_floor",
      "staff_payments_period_fk",
      "staff_payments_pkey",
      "staff_payments_purpose_check",
      "staff_payments_status_check",
      "staff_payments_tenant_id_fkey",
      "staff_payments_void_reason_length",
      "staff_payments_void_state",
      "staff_payments_voided_by_fkey",
    ],
  };

  it.each(STAFF_TABLES)("S2 constraints of %s: the exact named set, every FK is NO ACTION, the composite FKs as specified", async (table) => {
    const rows = await testDb<{ name: string; type: string; del: string; upd: string; def: string }[]>`
      select conname as name, contype::text as type, confdeltype::text as del, confupdtype::text as upd, pg_get_constraintdef(oid) as def
      from pg_constraint where conrelid = ${`public.${table}`}::regclass and contype <> 'n' order by conname`;
    expect(rows.map((r) => r.name).sort()).toEqual([...constraintSpec[table]!].sort());
    for (const fk of rows.filter((r) => r.type === "f")) {
      expect([fk.del, fk.upd], fk.name).toEqual(["a", "a"]);
    }
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.def]));
    if (table === "staff_finance_periods") {
      expect(byName.staff_periods_staff_fk).toBe("FOREIGN KEY (staff_member_id, tenant_id) REFERENCES staff_members(id, tenant_id)");
      expect(byName.staff_periods_idempotency_key_unique).toBe("UNIQUE (tenant_id, idempotency_key)");
      expect(byName.staff_periods_id_tenant_unique).toBe("UNIQUE (id, tenant_id)");
      expect(byName.staff_periods_id_tenant_currency_unique).toBe("UNIQUE (id, tenant_id, currency)");
      expect(byName.staff_periods_finalized_paid_within_net).toContain("'open'");
      expect(byName.staff_periods_snapshot_state).toContain("'finalized'");
    }
    if (table === "staff_period_lines") {
      expect(byName.staff_lines_period_fk).toBe("FOREIGN KEY (period_id, tenant_id, currency) REFERENCES staff_finance_periods(id, tenant_id, currency)");
      expect(byName.staff_lines_idempotency_key_unique).toBe("UNIQUE (tenant_id, idempotency_key)");
      expect(byName.staff_period_lines_kind_fkey).toContain("REFERENCES staff_line_kinds(code)");
      expect(byName.staff_lines_source_check).toContain("'manual'");
    }
    if (table === "staff_payments") {
      expect(byName.staff_payments_period_fk).toBe("FOREIGN KEY (period_id, tenant_id, currency) REFERENCES staff_finance_periods(id, tenant_id, currency)");
      expect(byName.staff_payments_idempotency_key_unique).toBe("UNIQUE (tenant_id, idempotency_key)");
      expect(byName.staff_payments_purpose_check).toContain("'advance'");
      expect(byName.staff_payments_method_check).toContain("'bank_transfer'");
    }
  });

  it("S3 indexes: exactly the planned set (plus the implicit primary-key and unique ones), none missing, no extras", async () => {
    const rows = await testDb<{ table: string; name: string; def: string }[]>`
      select tablename as table, indexname as name, indexdef as def from pg_indexes
      where schemaname = 'public' and tablename in ('staff_line_kinds', 'staff_finance_periods', 'staff_period_lines', 'staff_payments')
      order by indexname`;
    expect(rows.map((r) => r.name).sort()).toEqual(
      [
        "staff_finance_periods_pkey",
        "staff_line_kinds_pkey",
        "staff_lines_id_tenant_unique",
        "staff_lines_idempotency_key_unique",
        "staff_lines_institution_idx",
        "staff_lines_period_idx",
        "staff_payments_idempotency_key_unique",
        "staff_payments_period_idx",
        "staff_payments_pkey",
        "staff_payments_tenant_paid_at_idx",
        "staff_period_lines_pkey",
        "staff_periods_id_tenant_currency_unique",
        "staff_periods_id_tenant_unique",
        "staff_periods_idempotency_key_unique",
        "staff_periods_one_active_per_month",
        "staff_periods_tenant_month_idx",
        "staff_periods_tenant_open_idx",
      ].sort(),
    );
    const def = Object.fromEntries(rows.map((r) => [r.name, r.def.replace(/\s+/g, " ")]));
    expect(def.staff_periods_one_active_per_month).toContain("UNIQUE INDEX");
    expect(def.staff_periods_one_active_per_month).toContain("(tenant_id, staff_member_id, period_month)");
    expect(def.staff_periods_one_active_per_month).toMatch(/WHERE \(?lifecycle\)?(::text)? <> 'cancelled'/);
    expect(def.staff_periods_tenant_month_idx).toContain("(tenant_id, period_month DESC, staff_member_id)");
    expect(def.staff_periods_tenant_open_idx).toContain("(tenant_id, period_month)");
    expect(def.staff_lines_period_idx).toContain("(period_id, status, created_at, id)");
    expect(def.staff_lines_institution_idx).toContain("(tenant_id, institution)");
    expect(def.staff_lines_institution_idx).toMatch(/institution IS NOT NULL\)? AND \(?status\)?(::text)? = 'active'/);
    expect(def.staff_payments_period_idx).toContain("(period_id, paid_at, id)");
    expect(def.staff_payments_tenant_paid_at_idx).toContain("(tenant_id, paid_at)");
    expect(def.staff_payments_tenant_paid_at_idx).toMatch(/WHERE \(?status\)?(::text)? = 'posted'/);
  });

  it.each(STAFF_TABLES)("S4 RLS: enabled on %s with zero policies", async (table) => {
    const [row] = await testDb<{ rls: boolean; policies: string }[]>`
      select c.relrowsecurity as rls,
             (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::text as policies
      from pg_class c where c.oid = ${`public.${table}`}::regclass`;
    expect(row!.rls).toBe(true);
    expect(Number(row!.policies)).toBe(0);
  });

  it.each(STAFF_TABLES)("S5 table privileges: %s grants nothing to public, anon, authenticated or service_role", async (table) => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
        const [row] = await testDb<{ ok: boolean }[]>`select has_table_privilege(${role}, ${`public.${table}`}, ${privilege}) as ok`;
        expect(row!.ok, `${role} ${privilege} on ${table}`).toBe(false);
      }
    }
    const [acl] = await testDb<{ others: string }[]>`
      select count(*)::text as others from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where c.oid = ${`public.${table}`}::regclass and a.grantee <> c.relowner`;
    expect(Number(acl!.others), "the ACL must be owner-only (no PUBLIC entry either)").toBe(0);
  });

  /** [schema, name, identity arguments, volatility, security definer]. */
  const FUNCTIONS: [string, string, string, "i" | "s" | "v", boolean][] = [
    // public wrappers (14)
    ["public", "list_finance_staff", "p_tenant_id uuid", "s", true],
    ["public", "list_staff_line_kinds", "p_tenant_id uuid", "s", true],
    ["public", "get_staff_finance_overview", "p_tenant_id uuid, p_month date, p_reference_date date", "s", true],
    ["public", "get_staff_finance_period", "p_period_id uuid, p_reference_date date", "s", true],
    ["public", "create_staff_finance_period", "p_tenant_id uuid, p_staff_member_id uuid, p_period_month date, p_idempotency_key uuid, p_due_date date", "v", true],
    ["public", "update_staff_finance_period", "p_period_id uuid, p_due_date date, p_expected_version integer", "v", true],
    ["public", "add_staff_period_line", "p_period_id uuid, p_kind text, p_amount numeric, p_description text, p_idempotency_key uuid", "v", true],
    ["public", "update_staff_period_line", "p_line_id uuid, p_amount numeric, p_description text, p_expected_version integer", "v", true],
    ["public", "void_staff_period_line", "p_line_id uuid, p_reason text, p_expected_version integer", "v", true],
    ["public", "finalize_staff_finance_period", "p_period_id uuid, p_expected_version integer", "v", true],
    ["public", "reopen_staff_finance_period", "p_period_id uuid, p_reason text, p_expected_version integer", "v", true],
    ["public", "cancel_staff_finance_period", "p_period_id uuid, p_reason text", "v", true],
    ["public", "record_staff_payment", "p_period_id uuid, p_purpose text, p_amount numeric, p_method text, p_paid_at timestamp with time zone, p_note text, p_idempotency_key uuid", "v", true],
    ["public", "void_staff_payment", "p_payment_id uuid, p_reason text", "v", true],
    // private RPC implementations (14)
    ["private", "list_finance_staff", "p_tenant_id uuid", "s", true],
    ["private", "list_staff_line_kinds", "p_tenant_id uuid", "s", true],
    ["private", "get_staff_finance_overview", "p_tenant_id uuid, p_month date, p_reference_date date", "s", true],
    ["private", "get_staff_finance_period", "p_period_id uuid, p_reference_date date", "s", true],
    ["private", "create_staff_finance_period", "p_tenant_id uuid, p_staff_member_id uuid, p_period_month date, p_idempotency_key uuid, p_due_date date", "v", true],
    ["private", "update_staff_finance_period", "p_period_id uuid, p_due_date date, p_expected_version integer", "v", true],
    ["private", "add_staff_period_line", "p_period_id uuid, p_kind text, p_amount numeric, p_description text, p_idempotency_key uuid", "v", true],
    ["private", "update_staff_period_line", "p_line_id uuid, p_amount numeric, p_description text, p_expected_version integer", "v", true],
    ["private", "void_staff_period_line", "p_line_id uuid, p_reason text, p_expected_version integer", "v", true],
    ["private", "finalize_staff_finance_period", "p_period_id uuid, p_expected_version integer", "v", true],
    ["private", "reopen_staff_finance_period", "p_period_id uuid, p_reason text, p_expected_version integer", "v", true],
    ["private", "cancel_staff_finance_period", "p_period_id uuid, p_reason text", "v", true],
    ["private", "record_staff_payment", "p_period_id uuid, p_purpose text, p_amount numeric, p_method text, p_paid_at timestamp with time zone, p_note text, p_idempotency_key uuid", "v", true],
    ["private", "void_staff_payment", "p_payment_id uuid, p_reason text", "v", true],
    // helpers (8)
    ["private", "staff_period_live_totals", "p_period_id uuid", "s", true],
    ["private", "normalize_staff_finance_text", "p_text text", "i", false],
    ["private", "normalize_staff_finance_amount", "p_amount numeric", "i", false],
    ["private", "normalize_staff_finance_month", "p_month date", "i", false],
    ["private", "staff_period_create_fingerprint", "p_staff_member_id uuid, p_period_month date, p_due_date date", "i", false],
    ["private", "staff_line_add_fingerprint", "p_period_id uuid, p_kind text, p_amount numeric, p_description text", "i", false],
    ["private", "normalize_staff_payment_input", "p_amount numeric, p_purpose text, p_method text, p_paid_at timestamp with time zone, p_note text", "s", false],
    ["private", "post_staff_payment", "p_tenant_id uuid, p_period_id uuid, p_purpose text, p_amount numeric, p_method text, p_paid_at timestamp with time zone, p_note text, p_idempotency_key uuid", "v", true],
    // trigger functions (4)
    ["private", "enforce_staff_period_invariants", "", "v", true],
    ["private", "enforce_staff_line_invariants", "", "v", true],
    ["private", "enforce_staff_payment_invariants", "", "v", true],
    ["private", "recalculate_staff_period_totals", "", "v", true],
  ];

  const NEW_FUNCTION_FILTER = `(p.proname ~ '(staff_finance|staff_period|staff_line|staff_payment|finance_staff|staff_finance_)' )`;

  it("S6 functions: exactly 40 new ones with the planned identity arguments, volatility, security definer and a pinned empty search_path", async () => {
    expect(FUNCTIONS).toHaveLength(40);
    const rows = await testDb<
      { schema: string; name: string; args: string; volatility: string; definer: boolean; config: string[] | null; owner: string }[]
    >`
      select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args, p.provolatile::text as volatility,
             p.prosecdef as definer, p.proconfig as config, pg_get_userbyid(p.proowner) as owner
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and ${testDb.unsafe(NEW_FUNCTION_FILTER)}
      order by n.nspname, p.proname`;
    const actual = rows
      .map((r) => [r.schema, r.name, r.args])
      .sort((a, b) => `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`));
    const expected = FUNCTIONS.map(([s, n, a]) => [s, n, a]).sort((a, b) => `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`));
    expect(actual).toEqual(expected);
    for (const [schema, name, , volatility, definer] of FUNCTIONS) {
      const row = rows.find((r) => r.schema === schema && r.name === name)!;
      expect(row.volatility, `${schema}.${name} volatility`).toBe(volatility);
      expect(row.definer, `${schema}.${name} security definer`).toBe(definer);
      if (definer) expect(row.config, `${schema}.${name} search_path`).toContain('search_path=""');
      expect(row.owner).toBe("postgres");
    }
  });

  it("S7 execute grants: the 14 wrappers are executable by authenticated only (anon, service_role and PUBLIC never); the other 26 functions have no API-role or PUBLIC grant", async () => {
    for (const [schema, name, args] of FUNCTIONS) {
      const [row] = await testDb<{ oid: string }[]>`
        select p.oid::text as oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = ${schema} and p.proname = ${name} and pg_get_function_identity_arguments(p.oid) = ${args}`;
      const oid = row!.oid;
      const can = async (role: string) =>
        (await testDb<{ ok: boolean }[]>`select has_function_privilege(${role}, ${oid}::oid, 'EXECUTE') as ok`)[0]!.ok;
      const isWrapper = schema === "public";
      expect(await can("authenticated"), `${schema}.${name} authenticated`).toBe(isWrapper);
      expect(await can("anon"), `${schema}.${name} anon`).toBe(false);
      expect(await can("service_role"), `${schema}.${name} service_role`).toBe(false);
      const [acl] = await testDb<{ public_entries: string }[]>`
        select count(*)::text as public_entries from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = ${oid}::oid and a.grantee = 0`;
      expect(Number(acl!.public_entries), `${schema}.${name} PUBLIC execute`).toBe(0);
    }
  });

  it("S8 comments: every new table, function and trigger carries a comment; the five triggers are exactly the planned ones", async () => {
    for (const table of STAFF_TABLES) {
      const [row] = await testDb<{ c: string | null }[]>`select obj_description(${`public.${table}`}::regclass, 'pg_class') as c`;
      expect(row!.c, `table ${table}`).toMatch(/^Faz FIN\.1C\.1/);
    }
    for (const [schema, name, args] of FUNCTIONS) {
      const [row] = await testDb<{ c: string | null }[]>`
        select obj_description(p.oid, 'pg_proc') as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = ${schema} and p.proname = ${name} and pg_get_function_identity_arguments(p.oid) = ${args}`;
      expect(row!.c, `${schema}.${name}`).toMatch(/^Faz FIN\.1C\.1/);
    }
    const rows = await testDb<{ name: string; table: string; def: string; comment: string | null }[]>`
      select t.tgname as name, c.relname as table, pg_get_triggerdef(t.oid) as def, obj_description(t.oid, 'pg_trigger') as comment
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname in ('staff_line_kinds', 'staff_finance_periods', 'staff_period_lines', 'staff_payments')
      order by t.tgname`;
    const norm = (s: string) => s.replace(/\s+/g, " ");
    expect(rows.map((r) => [r.name, r.table, norm(r.def)])).toEqual([
      ["enforce_staff_line_invariants_trg", "staff_period_lines", "CREATE TRIGGER enforce_staff_line_invariants_trg BEFORE INSERT OR UPDATE ON public.staff_period_lines FOR EACH ROW EXECUTE FUNCTION private.enforce_staff_line_invariants()"],
      ["enforce_staff_payment_invariants_trg", "staff_payments", "CREATE TRIGGER enforce_staff_payment_invariants_trg BEFORE INSERT OR UPDATE ON public.staff_payments FOR EACH ROW EXECUTE FUNCTION private.enforce_staff_payment_invariants()"],
      ["enforce_staff_period_invariants_trg", "staff_finance_periods", "CREATE TRIGGER enforce_staff_period_invariants_trg BEFORE INSERT OR UPDATE ON public.staff_finance_periods FOR EACH ROW EXECUTE FUNCTION private.enforce_staff_period_invariants()"],
      ["recalculate_staff_totals_after_line_trg", "staff_period_lines", "CREATE TRIGGER recalculate_staff_totals_after_line_trg AFTER INSERT OR UPDATE ON public.staff_period_lines FOR EACH ROW EXECUTE FUNCTION private.recalculate_staff_period_totals()"],
      ["recalculate_staff_totals_after_payment_trg", "staff_payments", "CREATE TRIGGER recalculate_staff_totals_after_payment_trg AFTER INSERT OR UPDATE OF status ON public.staff_payments FOR EACH ROW EXECUTE FUNCTION private.recalculate_staff_period_totals()"],
    ]);
    for (const r of rows) expect(r.comment, r.name).toMatch(/^Faz FIN\.1C\.1/);
  });

  it("S9 / CAT1-CAT4 / CAT7 the kind seed: 16 kinds (7 earning, 5 employee deduction, 4 employer cost), exact classification, all active; paye is manual and untagged", async () => {
    const rows = await testDb<{ code: string; line_group: string; institution: string | null; is_adjustment: boolean; display_order: number; is_active: boolean }[]>`
      select code, line_group, institution, is_adjustment, display_order, is_active from staff_line_kinds order by display_order, code`;
    expect(rows.map((r) => [r.code, r.line_group, r.institution, r.is_adjustment, r.display_order])).toEqual(
      KIND_CATALOG.map((k) => [k[0], k[1], k[2], k[3], k[4]]),
    );
    expect(rows.every((r) => r.is_active)).toBe(true);
    const groups = Object.fromEntries(
      ["earning", "employee_deduction", "employer_cost"].map((g) => [g, rows.filter((r) => r.line_group === g).length]),
    );
    expect(groups).toEqual({ earning: 7, employee_deduction: 5, employer_cost: 4 });
    expect(rows.filter((r) => r.institution !== null).map((r) => [r.code, r.institution])).toEqual([
      ["employee_social_insurance", "social_insurance"],
      ["employee_provident_fund", "provident_fund"],
      ["employer_social_insurance", "social_insurance"],
      ["employer_provident_fund", "provident_fund"],
    ]);
    expect(rows.filter((r) => r.is_adjustment).map((r) => r.code)).toEqual(["adjustment_credit", "adjustment_debit"]);
    const paye = rows.find((r) => r.code === "paye")!;
    expect([paye.line_group, paye.institution, paye.is_adjustment, paye.is_active]).toEqual(["employee_deduction", null, false, true]);
    // re-running the seed is idempotent and never rewrites classification or is_active
    const sql = readFileSync(M2, "utf8");
    const seed = sql.match(/insert into public\.staff_line_kinds \(code, line_group, institution, is_adjustment, display_order\) values[\s\S]*?on conflict \(code\) do nothing;/);
    expect(seed, "the seed statement must be in the migration").not.toBeNull();
    class Rollback extends Error {}
    await expect(
      testDb.begin(async (tx) => {
        await tx`update staff_line_kinds set is_active = false where code = 'bonus'`;
        await tx.unsafe(seed![0]);
        const after = await tx<{ code: string; line_group: string; is_active: boolean }[]>`select code, line_group, is_active from staff_line_kinds order by display_order`;
        expect(after.find((r) => r.code === "bonus")!.is_active, "a retired kind stays retired").toBe(false);
        expect(after).toHaveLength(16);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it("S10 FIN.1A and FIN.1B.1 are untouched: the frozen migration hashes, and every FIN.1A and FIN.1B.1 function body in this database equals its file", async () => {
    for (const [file, hash] of [[FIN1A_MIGRATION, FIN1A_SHA256], [FIN1B1_MIGRATION, FIN1B1_SHA256]] as const) {
      const text = readFileSync(file);
      expect(createHash("sha256").update(text).digest("hex"), file).toBe(hash);
      const sql = text.toString("utf8");
      for (const chunk of sql.split(/\ncreate function /).slice(1)) {
        const name = chunk.slice(0, chunk.indexOf("("));
        const body = chunk.match(/\bas \$\$([\s\S]*?)\$\$;/)![1]!;
        const [schema, fn] = name.split(".") as [string, string];
        const [row] = await testDb<{ prosrc: string }[]>`
          select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ${schema} and p.proname = ${fn}`;
        expect(row?.prosrc, `${name} must exist and be byte-identical to its frozen migration`).toBe(body);
      }
    }
  });

  it("S11 additions only: the permission catalog gained exactly the two keys, the Owner template equals the catalog, and the other templates are unchanged", async () => {
    const [perms] = await testDb<{ n: string; fin: string }[]>`
      select count(*)::text as n, count(*) filter (where key in ('finance.view', 'finance.manage', 'reports.financial', 'finance.staff_view', 'finance.staff_manage'))::text as fin from permissions`;
    expect(Number(perms!.n)).toBe(25);
    expect(Number(perms!.fin)).toBe(5);
    const [owner] = await testDb<{ n: string }[]>`
      select count(*)::text as n from role_template_permissions rtp join role_templates rt on rt.id = rtp.role_template_id where rt.key = 'SALON_OWNER'`;
    expect(Number(owner!.n)).toBe(25);
    const templates = await testDb<{ key: string }[]>`select key from role_templates order by key`;
    expect(templates.map((t) => t.key)).toEqual(["ACCOUNTANT", "CASHIER", "RECEPTIONIST", "SALON_MANAGER", "SALON_OWNER", "STOCK_MANAGER", "STYLIST"]);
    // the optional CASHIER and ACCOUNTANT templates do not gain the staff keys either
    const others = await testDb<{ key: string }[]>`
      select rt.key from role_template_permissions rtp
      join role_templates rt on rt.id = rtp.role_template_id join permissions p on p.id = rtp.permission_id
      where p.key in ('finance.staff_view', 'finance.staff_manage') order by rt.key`;
    expect([...new Set(others.map((r) => r.key))]).toEqual(["SALON_OWNER"]);
    expect(others).toHaveLength(2);
  });

  it("S13 function-body identity: every live function body equals the migration text", async () => {
    const sql = readFileSync(M2, "utf8");
    const chunks = sql.split(/\ncreate function /).slice(1);
    expect(chunks.length).toBe(40);
    for (const chunk of chunks) {
      const name = chunk.slice(0, chunk.indexOf("("));
      const body = chunk.match(/\bas \$\$([\s\S]*?)\$\$;/)![1]!;
      const [schema, fn] = name.split(".") as [string, string];
      const [row] = await testDb<{ prosrc: string }[]>`
        select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ${schema} and p.proname = ${fn}`;
      expect(row?.prosrc, `${name} must be byte-identical to the migration text`).toBe(body);
    }
  });

  it("S12 migration hygiene: M1 holds only the permission rows, the template rows and the sync call; M2 only create, insert on conflict, comment, RLS, revoke, grant and trigger statements on new objects; both wrapped in begin and commit", () => {
    const m1 = splitSqlStatements(readFileSync(M1, "utf8"));
    expect(m1[0]).toBe("begin");
    expect(m1[m1.length - 1]).toBe("commit");
    const m1Allowed: RegExp[] = [
      /^begin$/,
      /^commit$/,
      /^insert into public\.permissions \(key, name, category, description\) values /,
      /^insert into public\.role_template_permissions \(role_template_id, permission_id\) select /,
      /^select \* from private\.sync_pristine_default_roles\(\)$/,
    ];
    expect(m1.filter((s) => !m1Allowed.some((re) => re.test(s)))).toEqual([]);

    const raw = readFileSync(M2, "utf8");
    expect(raw).not.toContain("\r");
    const statements = splitSqlStatements(raw);
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
    const tables = "(staff_line_kinds|staff_finance_periods|staff_period_lines|staff_payments)";
    const allowed: RegExp[] = [
      /^begin$/,
      /^commit$/,
      new RegExp(`^create table public\\.${tables} \\(`),
      new RegExp(`^create (unique )?index [a-z_]+ on public\\.${tables} `),
      new RegExp(`^alter table public\\.${tables} enable row level security$`),
      new RegExp(`^revoke all on public\\.${tables} from public, anon, authenticated, service_role$`),
      /^insert into public\.staff_line_kinds \(code, line_group, institution, is_adjustment, display_order\) values .* on conflict \(code\) do nothing$/,
      /^comment on (table|function|trigger) /,
      /^create function (public|private)\.[a-z_]+\(/,
      /^create trigger [a-z_]+ (before|after) /,
      /^revoke execute on function (public|private)\.[a-z_]+\(.*\) from (public|public, anon, service_role)$/,
      /^grant execute on function public\.[a-z_]+\(.*\) to authenticated$/,
    ];
    expect(statements.filter((s) => !allowed.some((re) => re.test(s)))).toEqual([]);
    for (const s of statements) expect(s).not.toMatch(/^(drop|truncate|delete|update)\b/i);
    expect(raw.replace(/\$\$[\s\S]*?\$\$/g, "$$$$")).not.toMatch(/\bdrop\b/i);
    // no statement touches an object that existed before (no alter of FIN.1A / FIN.1B.1 / identity tables)
    expect(statements.some((s) => /^alter table public\.(?!staff_)/.test(s))).toBe(false);
  });

  it("S17 no delete: no DELETE privilege on any of the four tables and no function body deletes from them (scan of the live bodies)", async () => {
    const rows = await testDb<{ name: string; prosrc: string }[]>`
      select p.proname as name, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and ${testDb.unsafe(NEW_FUNCTION_FILTER)}`;
    expect(rows).toHaveLength(40);
    for (const r of rows) {
      expect(r.prosrc.replace(/--[^\n]*/g, ""), r.name).not.toMatch(/\bdelete\s+from\s+(public\.)?(staff_|private\.)/i);
      expect(r.prosrc, r.name).not.toMatch(/\btruncate\b/i);
    }
    for (const table of STAFF_TABLES) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const [row] = await testDb<{ ok: boolean }[]>`select has_table_privilege(${role}, ${`public.${table}`}, 'DELETE') as ok`;
        expect(row!.ok).toBe(false);
      }
    }
  });

  it("S19 generated columns: an INSERT or UPDATE that sets net_payable or payment_state fails", async () => {
    const p = await makePeriod(world);
    for (const col of ["net_payable", "payment_state"]) {
      await expect(
        testDb.unsafe(`update staff_finance_periods set ${col} = ${col === "net_payable" ? "5" : "'paid'"} where id = '${p.periodId}'`),
      ).rejects.toMatchObject({ code: "428C9" });
    }
    const staff = await newStaff(world);
    await expect(
      testDb.unsafe(
        `insert into staff_finance_periods (tenant_id, staff_member_id, staff_display_name, period_month, currency, net_payable, idempotency_key, idempotency_fingerprint)
         values ('${T()}', '${staff.id}', 'x', '2026-02-01', 'TRY', 5, '${newKey()}', '${"a".repeat(32)}')`,
      ),
    ).rejects.toMatchObject({ code: "428C9" });
  });

  it("S20 / CUR3 composite FKs: a line or payment whose currency or tenant differs from its period is rejected by the schema; a period for another tenant's staff member is rejected", async () => {
    const p = await makePeriod(world);
    const base = (extra: string, vals: string) =>
      `insert into staff_period_lines (tenant_id, period_id, currency, kind, line_group, amount, idempotency_key, idempotency_fingerprint${extra})
       values ('${T()}', '${p.periodId}', 'TRY', 'bonus', 'earning', 1, '${newKey()}', '${"a".repeat(32)}'${vals})`;
    // currency differs
    await expect(testDb.unsafe(base("", "").replace("'TRY'", "'USD'"))).rejects.toMatchObject({ code: "23503" });
    // tenant differs
    await expect(testDb.unsafe(base("", "").replace(`('${T()}'`, `('${world.otherTenant.id}'`))).rejects.toMatchObject({ code: "23503" });
    await expect(
      testDb.unsafe(
        `insert into staff_payments (tenant_id, period_id, currency, purpose, method, amount, idempotency_key)
         values ('${T()}', '${p.periodId}', 'USD', 'salary', 'cash', 1, '${newKey()}')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      testDb.unsafe(
        `insert into staff_payments (tenant_id, period_id, currency, purpose, method, amount, idempotency_key)
         values ('${world.otherTenant.id}', '${p.periodId}', 'TRY', 'salary', 'cash', 1, '${newKey()}')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    // a period for another tenant's staff member
    await expect(
      testDb.unsafe(
        `insert into staff_finance_periods (tenant_id, staff_member_id, staff_display_name, period_month, currency, idempotency_key, idempotency_fingerprint)
         values ('${T()}', '${world.otherStaff.id}', 'x', '2026-02-01', 'TRY', '${newKey()}', '${"a".repeat(32)}')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("S21 one active period: a second non-cancelled period for the same staff member and month is rejected by the partial unique index; after a cancel a new one is accepted", async () => {
    const staff = await newStaff(world);
    const first = await makePeriod(world, { staffMemberId: staff.id });
    const raw = () =>
      testDb.unsafe(
        `insert into staff_finance_periods (tenant_id, staff_member_id, staff_display_name, period_month, currency, idempotency_key, idempotency_fingerprint)
         values ('${T()}', '${staff.id}', 'x', '2026-09-01', 'TRY', '${newKey()}', '${"a".repeat(32)}')`,
      );
    await expect(raw()).rejects.toMatchObject({ code: "23505" });
    await testDb.unsafe(
      `update staff_finance_periods set lifecycle = 'cancelled', cancelled_at = now(), cancel_reason = 'x' where id = '${first.periodId}'`,
    );
    await expect(raw()).resolves.toBeTruthy();
  });

  it("S22 M1 on a pre-M1-like state (re-run in a rolled-back transaction): a pristine Owner role regains both keys, a customized role and every other role do not gain them, drift stays clean", async () => {
    // M1 carries its own begin/commit; inside this test's outer transaction they would end it early, so they are removed
    // (everything between them runs unchanged).
    const m1sql = readFileSync(M1, "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
    class Rollback extends Error {}
    await expect(
      testDb.begin(async (tx) => {
        // simulate "before M1": the keys are not in the Owner template nor in any role
        await tx`delete from role_permissions where permission_id in (select id from permissions where key like 'finance.staff_%')`;
        await tx`delete from role_template_permissions where permission_id in (select id from permissions where key like 'finance.staff_%')`;
        // a customized Owner role: another tenant's Owner changed it on purpose (a second Owner-keyed role cannot live in the
        // same tenant: roles_tenant_key_live_uidx), so the sync must leave it alone
        const [custom] = await tx<{ id: string }[]>`
          update roles set customized_at = now() where tenant_id = ${world.otherTenant.id} and key = 'SALON_OWNER' returning id`;
        await tx.unsafe(m1sql);
        const keysOf = async (roleId: string) =>
          (await tx<{ key: string }[]>`select p.key from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = ${roleId} and p.key like 'finance.staff_%' order by p.key`).map((r) => r.key);
        const ownerRole = world.owner && (await tx<{ id: string }[]>`select ownerrole.id from (select role_id as id from tenant_memberships where tenant_id = ${T()} and user_id = ${world.owner.id}) ownerrole`)[0]!.id;
        expect(await keysOf(ownerRole as string), "the pristine Owner role").toEqual(["finance.staff_manage", "finance.staff_view"]);
        expect(await keysOf(custom!.id), "a customized role").toEqual([]);
        for (const user of [world.manager, world.receptionist, world.stylist, world.accountant, world.financeOnly, world.viewOnly, world.manageOnly]) {
          const [m] = await tx<{ role_id: string }[]>`select role_id from tenant_memberships where tenant_id = ${T()} and user_id = ${user.id}`;
          const expected = user === world.viewOnly ? [] : []; // custom roles keep exactly their own keys (created without the staff keys here)
          expect(await keysOf(m!.role_id), user.email).toEqual(expected);
        }
        const [tpl] = await tx<{ n: string }[]>`select count(*)::text as n from role_template_permissions rtp join role_templates rt on rt.id = rtp.role_template_id join permissions p on p.id = rtp.permission_id where p.key like 'finance.staff_%' and rt.key <> 'SALON_OWNER'`;
        expect(Number(tpl!.n)).toBe(0);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it("S23 the snapshot constraint: the three snapshot columns are present exactly while finalized and net equals earning minus deduction (the schema backstop, trigger T1 disabled in a rolled-back transaction)", async () => {
    class Rollback extends Error {}
    const staff = await newStaff(world);
    await expect(
      testDb.begin(async (tx) => {
        await tx`alter table staff_finance_periods disable trigger enforce_staff_period_invariants_trg`;
        const ins = (cols: string, vals: string) =>
          tx.unsafe(
            `insert into staff_finance_periods (tenant_id, staff_member_id, staff_display_name, period_month, currency, idempotency_key, idempotency_fingerprint${cols})
             values ('${T()}', '${staff.id}', 'x', '2001-0${Math.floor(Math.random() * 9) + 1}-01', 'TRY', '${newKey()}', '${"a".repeat(32)}'${vals})`,
          );
        const code = async (p: Promise<unknown>) => {
          await tx`savepoint s`;
          try {
            await p;
            await tx`release savepoint s`;
            return undefined;
          } catch (e) {
            await tx`rollback to savepoint s`;
            return (e as { code?: string }).code;
          }
        };
        // finalized without a snapshot
        expect(await code(ins(", lifecycle, finalized_at", ", 'finalized', now()"))).toBe("23514");
        // open with a snapshot
        expect(await code(ins(", finalized_earning_total, finalized_deduction_total, finalized_net_payable", ", 1, 0, 1"))).toBe("23514");
        // finalized with inconsistent net
        expect(
          await code(ins(", earning_total, lifecycle, finalized_at, finalized_earning_total, finalized_deduction_total, finalized_net_payable", ", 10, 'finalized', now(), 10, 0, 9")),
        ).toBe("23514");
        // finalized with a deduction above the earning
        expect(
          await code(ins(", lifecycle, finalized_at, finalized_earning_total, finalized_deduction_total, finalized_net_payable", ", 'finalized', now(), 1, 2, -1")),
        ).toBe("23514");
        // a consistent finalized row is accepted
        expect(
          await code(ins(", earning_total, lifecycle, finalized_at, finalized_earning_total, finalized_deduction_total, finalized_net_payable", ", 10, 'finalized', now(), 10, 0, 10")),
        ).toBeUndefined();
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it("S24 overpaid at schema level: an open period may hold paid_total above the net; a finalized or cancelled row with paid_total above the net is rejected by the CHECK (trigger T1 disabled, rolled back)", async () => {
    class Rollback extends Error {}
    const staff = await newStaff(world);
    await expect(
      testDb.begin(async (tx) => {
        await tx`alter table staff_finance_periods disable trigger enforce_staff_period_invariants_trg`;
        const code = async (cols: string, vals: string, month: string) => {
          await tx`savepoint s`;
          try {
            await tx.unsafe(
              `insert into staff_finance_periods (tenant_id, staff_member_id, staff_display_name, period_month, currency, idempotency_key, idempotency_fingerprint${cols})
               values ('${T()}', '${staff.id}', 'x', '${month}', 'TRY', '${newKey()}', '${"a".repeat(32)}'${vals})`,
            );
            await tx`release savepoint s`;
            return undefined;
          } catch (e) {
            await tx`rollback to savepoint s`;
            return (e as { code?: string }).code;
          }
        };
        expect(await code(", earning_total, paid_total", ", 10, 50", "2001-01-01")).toBeUndefined();
        expect(
          await code(", earning_total, paid_total, lifecycle, finalized_at, finalized_earning_total, finalized_deduction_total, finalized_net_payable", ", 10, 50, 'finalized', now(), 10, 0, 10", "2001-02-01"),
        ).toBe("23514");
        expect(
          await code(", earning_total, paid_total, lifecycle, cancelled_at, cancel_reason", ", 10, 50, 'cancelled', now(), 'x'", "2001-03-01"),
        ).toBe("23514");
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});

// =================================================================================================================
// CAT — the kind catalog through the read RPC
// =================================================================================================================
describe("CAT kind catalog", () => {
  it("CAT5 list_staff_line_kinds returns the active kinds ordered by display_order then code, behind finance.staff_view", async () => {
    const out = await expectOk(await listKinds(world.owner.id, T()));
    expect(out).toHaveLength(16);
    expect(out.map((k) => k.code)).toEqual(KIND_CATALOG.map((k) => k[0]));
    expect(out[0]).toEqual({ code: "salary", lineGroup: "earning", institution: null, isAdjustment: false, displayOrder: 10 });
    expect(Object.keys(out[0]!).sort()).toEqual(["code", "displayOrder", "institution", "isAdjustment", "lineGroup"]);
    expect((await expectOk(await listKinds(world.viewOnly.id, T()))).length).toBe(16);
    for (const who of [world.manageOnly, world.neither, world.stranger, world.otherOwner, world.financeOnly]) {
      expect(failure(await listKinds(who.id, T()))).toBe("FN002");
    }
    // an inactive kind is excluded (rolled back so no other test sees it)
    class Rollback extends Error {}
    await expect(
      testDb.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: world.owner.id, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${world.owner.id}, true)`;
        await tx`update staff_line_kinds set is_active = false where code = 'other_earning'`;
        const [r] = await tx<{ r: { code: string }[] }[]>`select public.list_staff_line_kinds(${T()}::uuid) as r`;
        expect(r!.r.map((k) => k.code)).not.toContain("other_earning");
        expect(r!.r).toHaveLength(15);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it("CAT6 the catalog cannot be written from any API role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(
        testDb.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx.unsafe(`update staff_line_kinds set is_active = false where code = 'salary'`);
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        testDb.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx.unsafe(`select * from staff_line_kinds`);
        }),
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect((await testDb<{ n: string }[]>`select count(*)::text as n from staff_line_kinds where is_active`)[0]!.n).toBe("16");
  });
});

// =================================================================================================================
// P — permissions, tenant boundaries and privacy
// =================================================================================================================
describe("P permissions and tenant boundaries", () => {
  /** Fresh preconditions (made as the owner) and the argument list of one wrapper call. */
  async function argsFor(fn: string): Promise<RpcArg[]> {
    const owner = world.owner;
    const finalized = async () => {
      const p = await makePeriod(world);
      await makeLine(p.periodId, "salary", 1000, {}, owner);
      const v = (await periodRow(p.periodId)).version;
      await expectOk(await finalizePeriod(owner.id, { periodId: p.periodId, expectedVersion: v }));
      return p.periodId;
    };
    switch (fn) {
      case "list_finance_staff":
      case "list_staff_line_kinds":
        return [["p_tenant_id", T(), "uuid"]];
      case "get_staff_finance_overview":
        return [["p_tenant_id", T(), "uuid"]];
      case "get_staff_finance_period": {
        const p = await makePeriod(world);
        return [["p_period_id", p.periodId, "uuid"]];
      }
      case "create_staff_finance_period": {
        const s = await newStaff(world);
        return [["p_tenant_id", T(), "uuid"], ["p_staff_member_id", s.id, "uuid"], ["p_period_month", "2026-04-01", "date"], ["p_idempotency_key", newKey(), "uuid"]];
      }
      case "update_staff_finance_period": {
        const p = await makePeriod(world);
        return [["p_period_id", p.periodId, "uuid"], ["p_due_date", "2026-10-05", "date"], ["p_expected_version", 1, "integer"]];
      }
      case "add_staff_period_line": {
        const p = await makePeriod(world);
        return [["p_period_id", p.periodId, "uuid"], ["p_kind", "salary", "text"], ["p_amount", 100, "numeric"], ["p_idempotency_key", newKey(), "uuid"]];
      }
      case "update_staff_period_line": {
        const p = await makePeriod(world);
        const l = await makeLine(p.periodId, "salary", 100, {}, owner);
        return [["p_line_id", l.lineId, "uuid"], ["p_amount", 200, "numeric"], ["p_expected_version", l.version, "integer"]];
      }
      case "void_staff_period_line": {
        const p = await makePeriod(world);
        const l = await makeLine(p.periodId, "salary", 100, {}, owner);
        return [["p_line_id", l.lineId, "uuid"], ["p_reason", "x", "text"], ["p_expected_version", l.version, "integer"]];
      }
      case "finalize_staff_finance_period": {
        const p = await makePeriod(world);
        const l = await makeLine(p.periodId, "salary", 100, {}, owner);
        return [["p_period_id", p.periodId, "uuid"], ["p_expected_version", l.version, "integer"]];
      }
      case "reopen_staff_finance_period": {
        const id = await finalized();
        return [["p_period_id", id, "uuid"], ["p_reason", "x", "text"], ["p_expected_version", (await periodRow(id)).version, "integer"]];
      }
      case "cancel_staff_finance_period": {
        const p = await makePeriod(world);
        return [["p_period_id", p.periodId, "uuid"], ["p_reason", "x", "text"]];
      }
      case "record_staff_payment": {
        const p = await makePeriod(world);
        return [["p_period_id", p.periodId, "uuid"], ["p_purpose", "salary", "text"], ["p_amount", 10, "numeric"], ["p_method", "cash", "text"], ["p_paid_at", instantAgo(1), "timestamptz"], ["p_idempotency_key", newKey(), "uuid"]];
      }
      case "void_staff_payment": {
        const p = await makePeriod(world);
        const y = await makePayment(p.periodId, 10, {}, owner);
        return [["p_payment_id", y.paymentId, "uuid"], ["p_reason", "x", "text"]];
      }
      default:
        throw new Error(`no argument builder for ${fn}`);
    }
  }

  type Caller = { name: string; who: () => { id: string } | null; reads: string | null; writes: string | null };
  const CALLERS: Caller[] = [
    { name: "owner (SALON_OWNER template: both keys)", who: () => world.owner, reads: null, writes: null },
    { name: "finance.staff_view only", who: () => world.viewOnly, reads: null, writes: "FN002" },
    { name: "finance.staff_manage only", who: () => world.manageOnly, reads: "FN002", writes: null },
    { name: "finance.view + finance.manage only (the expense keys: no inheritance)", who: () => world.financeOnly, reads: "FN002", writes: "FN002" },
    { name: "reports.financial only", who: () => world.reportsOnly, reads: "FN002", writes: "FN002" },
    { name: "ACCOUNTANT template", who: () => world.accountant, reads: "FN002", writes: "FN002" },
    { name: "appointments.view only", who: () => world.neither, reads: "FN002", writes: "FN002" },
    { name: "default Yönetici", who: () => world.manager, reads: "FN002", writes: "FN002" },
    { name: "default Resepsiyon", who: () => world.receptionist, reads: "FN002", writes: "FN002" },
    { name: "default Personel", who: () => world.stylist, reads: "FN002", writes: "FN002" },
    { name: "no membership", who: () => world.stranger, reads: "FN002", writes: "FN002" },
    { name: "another tenant's owner", who: () => world.otherOwner, reads: "FN002", writes: "FN002" },
    { name: "no JWT (auth.uid() is null)", who: () => null, reads: "FN001", writes: "FN001" },
  ];

  async function run(who: { id: string } | null, fn: string, args: RpcArg[]) {
    return who ? callRpc(who.id, fn, args) : callRpcNoJwt(fn, args);
  }

  describe.each(CALLERS)("P1-P4 / P7 callers: $name", (caller) => {
    it.each(STAFF_FINANCE_WRAPPERS.map((fn) => [fn]))("%s", async (fn) => {
      const isRead = (STAFF_FINANCE_READ_WRAPPERS as readonly string[]).includes(fn);
      const expected = isRead ? caller.reads : caller.writes;
      const args = await argsFor(fn);
      const out = await run(caller.who(), fn, args);
      if (expected === null) {
        expect(out.ok, `${fn} must be allowed: ${JSON.stringify(out)}`).toBe(true);
      } else {
        expect(failure(out), fn).toBe(expected);
      }
    });
  });

  it("P5 cross-tenant: id-based RPCs on another tenant's row are FN002, random ids FN020, FN021 and FN022, and the three list-tenant cases give an identical FN002", async () => {
    const p = await makePeriod(world);
    const line = await makeLine(p.periodId, "salary", 100, {}, world.owner);
    const pay = await makePayment(p.periodId, 10, {}, world.owner);
    const foreign = world.otherOwner.id;
    const digest = await tenantDigest(T());
    expect(failure(await callRpc(foreign, "get_staff_finance_period", [["p_period_id", p.periodId, "uuid"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "update_staff_finance_period", [["p_period_id", p.periodId, "uuid"], ["p_due_date", null, "date"], ["p_expected_version", 1, "integer"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "add_staff_period_line", [["p_period_id", p.periodId, "uuid"], ["p_kind", "salary", "text"], ["p_amount", 1, "numeric"], ["p_idempotency_key", newKey(), "uuid"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "update_staff_period_line", [["p_line_id", line.lineId, "uuid"], ["p_amount", 5, "numeric"], ["p_expected_version", 9, "integer"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "void_staff_period_line", [["p_line_id", line.lineId, "uuid"], ["p_reason", "x", "text"], ["p_expected_version", 9, "integer"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "finalize_staff_finance_period", [["p_period_id", p.periodId, "uuid"], ["p_expected_version", 9, "integer"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "reopen_staff_finance_period", [["p_period_id", p.periodId, "uuid"], ["p_reason", "x", "text"], ["p_expected_version", 9, "integer"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "cancel_staff_finance_period", [["p_period_id", p.periodId, "uuid"], ["p_reason", "x", "text"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "record_staff_payment", [["p_period_id", p.periodId, "uuid"], ["p_purpose", "salary", "text"], ["p_amount", 1, "numeric"], ["p_method", "cash", "text"], ["p_paid_at", instantAgo(1), "timestamptz"], ["p_idempotency_key", newKey(), "uuid"]]))).toBe("FN002");
    expect(failure(await callRpc(foreign, "void_staff_payment", [["p_payment_id", pay.paymentId, "uuid"], ["p_reason", "x", "text"]]))).toBe("FN002");
    expect(await tenantDigest(T())).toBe(digest);
    const rnd = "00000000-0000-4000-8000-000000000e01";
    expect(failure(await callRpc(world.owner.id, "get_staff_finance_period", [["p_period_id", rnd, "uuid"]]))).toBe("FN020");
    expect(failure(await callRpc(world.owner.id, "finalize_staff_finance_period", [["p_period_id", rnd, "uuid"], ["p_expected_version", 1, "integer"]]))).toBe("FN020");
    expect(failure(await callRpc(world.owner.id, "update_staff_period_line", [["p_line_id", rnd, "uuid"], ["p_amount", 5, "numeric"], ["p_expected_version", 1, "integer"]]))).toBe("FN021");
    expect(failure(await callRpc(world.owner.id, "void_staff_period_line", [["p_line_id", rnd, "uuid"], ["p_reason", "x", "text"], ["p_expected_version", 1, "integer"]]))).toBe("FN021");
    expect(failure(await callRpc(world.owner.id, "void_staff_payment", [["p_payment_id", rnd, "uuid"], ["p_reason", "x", "text"]]))).toBe("FN022");
    const tenantCases = [
      await callRpc(foreign, "list_finance_staff", [["p_tenant_id", T(), "uuid"]]),
      await callRpc(world.stranger.id, "list_finance_staff", [["p_tenant_id", T(), "uuid"]]),
      await callRpc(world.owner.id, "list_finance_staff", [["p_tenant_id", "00000000-0000-4000-8000-000000000e02", "uuid"]]),
    ];
    const messages = tenantCases.map((c) => {
      expect(failure(c)).toBe("FN002");
      return c.ok ? "" : c.message;
    });
    expect(new Set(messages).size).toBe(1);
  });

  it("P6 / E3-style the anon role and the service_role are denied (42501) on all 14 wrappers", async () => {
    for (const fn of STAFF_FINANCE_WRAPPERS) {
      const args = await requiredArgsOf(fn);
      expect(args.length, `${fn} has at least one required argument to probe with`).toBeGreaterThan(0);
      expect(failure(await callRpcAsAnon(fn, args)), `anon ${fn}`).toBe("42501");
      expect(failure(await callRpcAsRole("service_role", fn, args)), `service_role ${fn}`).toBe("42501");
    }
  });

  it("P8 revoking a key from a role makes the very next call FN002 (no caching)", async () => {
    const [role] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where tenant_id = ${T()} and user_id = ${world.viewOnly.id}`;
    const [perm] = await testDb<{ id: string }[]>`select id from permissions where key = 'finance.staff_view'`;
    expect((await listStaff(world.viewOnly.id, T())).ok).toBe(true);
    await testDb`delete from role_permissions where role_id = ${role!.role_id} and permission_id = ${perm!.id}`;
    try {
      expect(failure(await listStaff(world.viewOnly.id, T()))).toBe("FN002");
    } finally {
      await testDb`insert into role_permissions (role_id, permission_id) values (${role!.role_id}, ${perm!.id}) on conflict do nothing`;
    }
    expect((await listStaff(world.viewOnly.id, T())).ok).toBe(true);
  });

  it("P9 / P10 / R16 the read models carry no forbidden field, no user id and no staff member id inside a period, line or payment model; the staff lists carry exactly three keys", async () => {
    const staff = await newStaff(world);
    const p = await makePeriod(world, { staffMemberId: staff.id });
    await makeLine(p.periodId, "salary", 1000, { description: "Maaş" }, world.owner);
    await makeLine(p.periodId, "employee_social_insurance", 100, {}, world.owner);
    const pay = await makePayment(p.periodId, 50, { note: "Not" }, world.owner);
    const v = (await periodRow(p.periodId)).version;
    await expectOk(await finalizePeriod(world.owner.id, { periodId: p.periodId, expectedVersion: v }));
    void pay;
    const overview = await expectOk(await getOverview(world.owner.id, { tenantId: T(), month: "2026-09-01" }));
    const detail = await expectOk(await getPeriod(world.owner.id, p.periodId));
    const staffList = await expectOk(await listStaff(world.owner.id, T()));
    const kinds = await expectOk(await listKinds(world.owner.id, T()));
    const FORBIDDEN = [
      "created_by", "createdBy", "voided_by", "voidedBy", "cancelled_by", "cancelledBy", "finalized_by", "finalizedBy",
      "idempotency_key", "idempotencyKey", "idempotency_fingerprint", "idempotencyFingerprint", "tenant_id", "tenantId",
      "email", "phone", "membership", "tenantMembershipId", "tenant_membership_id", "color", "branch", "branchId", "customer",
      "staff_member_id", "staffMemberId", "user_id", "userId", "auth",
    ];
    const keysOf = (value: unknown, out: string[] = []): string[] => {
      if (Array.isArray(value)) value.forEach((x) => keysOf(x, out));
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          out.push(k);
          keysOf(v, out);
        }
      }
      return out;
    };
    const stringsOf = (value: unknown, out: string[] = []): string[] => {
      if (Array.isArray(value)) value.forEach((x) => stringsOf(x, out));
      else if (value && typeof value === "object") Object.values(value).forEach((v) => stringsOf(v, out));
      else if (typeof value === "string") out.push(value);
      return out;
    };
    const userIds = new Set(world.users.map((u) => u.id));
    // the period models: overview.periods (rows), the detail (lines, payments)
    for (const [name, model] of [["overview.periods", overview.periods], ["detail", detail], ["overview.byCurrency", overview.byCurrency], ["kinds", kinds]] as const) {
      const keys = keysOf(model);
      for (const forbidden of FORBIDDEN) expect(keys, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      for (const s of stringsOf(model)) expect(userIds.has(s), `${name} leaks a user id`).toBe(false);
    }
    // no staff member id of any staff member anywhere in the period models
    const staffIds = [world.staffA, world.staffB, world.staffInactive, world.staffDeleted, world.otherStaff, staff].map((s) => s.id);
    for (const s of stringsOf([overview.periods, detail])) expect(staffIds, "a staff member id leaked into a period model").not.toContain(s);
    // the staff lists: exactly three keys per entry
    for (const entry of [...staffList, ...overview.staffWithoutPeriod]) {
      expect(Object.keys(entry).sort()).toEqual(["fullName", "staffMemberId", "status"]);
    }
    expect(Object.keys(overview).sort()).toEqual(["byCurrency", "month", "periods", "primaryCurrency", "referenceDate", "staffWithoutPeriod"]);
  });

  it("P13 the non-Owner template key lists after M1 are byte-identical to the locked matrix and the Owner template equals the catalog", async () => {
    const keysOfTemplate = async (key: string) =>
      (await testDb<{ key: string }[]>`
        select p.key from role_template_permissions rtp join role_templates rt on rt.id = rtp.role_template_id
        join permissions p on p.id = rtp.permission_id where rt.key = ${key} order by p.key`).map((r) => r.key);
    expect(await keysOfTemplate("SALON_MANAGER")).toEqual([...MANAGER_KEYS].sort());
    expect(await keysOfTemplate("RECEPTIONIST")).toEqual([...RECEPTION_KEYS].sort());
    expect(await keysOfTemplate("STYLIST")).toEqual([...PERSONEL_KEYS].sort());
    const catalog = (await testDb<{ key: string }[]>`select key from permissions order by key`).map((r) => r.key);
    expect(await keysOfTemplate("SALON_OWNER")).toEqual(catalog);
    expect(catalog).toEqual(expect.arrayContaining(["finance.staff_view", "finance.staff_manage"]));
  });
});

describe("CUR currency", () => {
  it("CUR2 updating a period's currency is FN032", async () => {
    const p = await makePeriod(world);
    await expect(testDb.unsafe(`update staff_finance_periods set currency = 'USD' where id = '${p.periodId}'`)).rejects.toMatchObject({ code: "FN032" });
  });

  it("CUR5 a mixed-currency tenant never sums across currencies", async () => {
    const [orig] = await testDb<{ currency: string }[]>`select currency from tenants where id = ${T()}`;
    const month = "2026-05-01";
    const a = await makePeriod(world, { periodMonth: month });
    await makeLine(a.periodId, "salary", 1000, {}, world.owner);
    await testDb`update tenants set currency = 'EUR' where id = ${T()}`;
    try {
      const b = await makePeriod(world, { periodMonth: month });
      await makeLine(b.periodId, "salary", 7, {}, world.owner);
      const ov = await expectOk(await getOverview(world.owner.id, { tenantId: T(), month }));
      const byCur = Object.fromEntries(ov.byCurrency.map((c) => [c.currency, c]));
      expect(byCur["EUR"]!.grossEntitlement).toBe(7);
      expect(byCur[orig!.currency]!.grossEntitlement).toBe(1000);
      expect(ov.byCurrency).toHaveLength(2);
      expect(ov.byCurrency[0]!.currency).toBe("EUR"); // the primary (tenant) currency first
      for (const row of ov.periods) expect(["EUR", orig!.currency]).toContain(row.currency);
      const detail = await expectOk(await getPeriod(world.owner.id, b.periodId));
      expect(detail.currency).toBe("EUR");
    } finally {
      await testDb`update tenants set currency = ${orig!.currency} where id = ${T()}`;
    }
    expect((await counts(T())).periods).toBeGreaterThan(1);
  });
});
