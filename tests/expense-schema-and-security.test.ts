import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createExpenseWorld,
  destroyExpenseWorld,
  callRpc,
  callRpcAsAnon,
  callRpcNoJwt,
  createExpense,
  updateExpense,
  cancelExpense,
  recordPayment,
  voidPayment,
  getExpense,
  getOverview,
  listExpenses,
  listCategories,
  makeExpense,
  makePayment,
  validCreate,
  expectOk,
  expenseRow,
  counts,
  tenantDigest,
  newKey,
  instantAgo,
  EXPENSE_WRAPPERS,
  type ExpenseWorld,
  type RpcOutcome,
  type RpcArg,
} from "./expense-fixtures";
import { asAuthenticatedUser } from "./helpers";

/**
 * Faz FIN.1B.1 — catalog, grants, RLS, permissions (matrix groups S, CAT, P and A10). These assertions are
 * UNCONDITIONAL on purpose: they fail loudly when an expected FIN.1B.1 object is missing, which the schema-era-aware
 * global grants regression test (security-grants-regression.test.ts) deliberately does not.
 *
 * NOTE for whoever runs this file next: it needs migration 20261003090000 applied to whatever TEST_DATABASE_URL points
 * at (a disposable PROD-derived branch or the local rig, never the shared DEV database).
 */

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20261003090000_expense_obligations_and_settlements.sql",
);
const FIN1A_MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260929120000_appointment_checkout_and_payments.sql",
);
const FIN1A_SHA256 =
  "28d8a74aec16feaa878ee0c28a0e0999b23a9e03775ab9b5164f2c871f1f2731";

let world: ExpenseWorld;

beforeAll(async () => {
  world = await createExpenseWorld("fin1b1-sec");
});

afterAll(async () => {
  await destroyExpenseWorld(world);
});

const T = () => world.tenant.id;

function failure(out: RpcOutcome<unknown>): string | undefined {
  expect(out.ok, `expected a failure, got ${JSON.stringify(out)}`).toBe(false);
  return out.ok ? undefined : out.code;
}

// ---------------------------------------------------------------------------------------------------------------
// S — schema, catalog, grants, RLS
// ---------------------------------------------------------------------------------------------------------------
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
        if (q === -1)
          throw new Error("unterminated string literal in the migration");
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
        if (end === -1)
          throw new Error("unterminated dollar-quoted body in the migration");
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

const EXPENSE_TABLES = [
  "expense_categories",
  "expenses",
  "expense_payments",
] as const;
const FIN1A_TABLES = [
  "appointment_sales",
  "appointment_sale_items",
  "payments",
] as const;

describe("S schema, catalog, grants, RLS", () => {
  it("S0 preflight: the migration is applied, the three FIN.1B.1 tables and the FIN.1A tables exist", async () => {
    const [head] = await testDb<{ head: string | null; has_row: boolean }[]>`
      select (select max(version) from supabase_migrations.schema_migrations) as head,
             exists (select 1 from supabase_migrations.schema_migrations where version = '20261003090000') as has_row`;
    expect(
      head!.has_row,
      "migration 20261003090000 is not recorded: apply it to the target database first",
    ).toBe(true);
    expect(head!.head! >= "20261003090000").toBe(true);
    for (const table of [...EXPENSE_TABLES, ...FIN1A_TABLES]) {
      const [row] = await testDb<
        { present: boolean }[]
      >`select to_regclass(${`public.${table}`}) is not null as present`;
      expect(row!.present, `table public.${table} must exist`).toBe(true);
    }
  });

  const columnSpec: Record<string, [string, string, boolean, string | null][]> =
    {
      expense_categories: [
        ["key", "text", false, null],
        ["kind", "text", false, null],
        ["display_order", "smallint", false, null],
        ["is_active", "boolean", false, "true"],
        ["created_at", "timestamp with time zone", false, "now()"],
      ],
      expenses: [
        ["id", "uuid", false, "gen_random_uuid()"],
        ["tenant_id", "uuid", false, null],
        ["branch_id", "uuid", true, null],
        ["category_key", "text", false, null],
        ["description", "text", false, null],
        ["vendor_name", "text", true, null],
        ["note", "text", true, null],
        ["expense_date", "date", false, null],
        ["due_date", "date", true, null],
        ["amount", "numeric(12,2)", false, null],
        ["currency", "text", false, null],
        ["status", "text", false, "'open'::text"],
        ["version", "integer", false, "1"],
        ["settlement_events", "integer", false, "0"],
        ["idempotency_key", "uuid", true, null],
        ["idempotency_fingerprint", "text", true, null],
        ["cancelled_at", "timestamp with time zone", true, null],
        ["cancelled_by", "uuid", true, null],
        ["cancel_reason", "text", true, null],
        ["created_by", "uuid", true, null],
        ["created_at", "timestamp with time zone", false, "now()"],
        ["updated_at", "timestamp with time zone", false, "now()"],
      ],
      expense_payments: [
        ["id", "uuid", false, "gen_random_uuid()"],
        ["tenant_id", "uuid", false, null],
        ["expense_id", "uuid", false, null],
        ["amount", "numeric(12,2)", false, null],
        ["method", "text", false, null],
        ["paid_at", "timestamp with time zone", false, "now()"],
        ["note", "text", true, null],
        ["status", "text", false, "'posted'::text"],
        ["idempotency_key", "uuid", false, null],
        ["created_by", "uuid", true, null],
        ["created_at", "timestamp with time zone", false, "now()"],
        ["voided_by", "uuid", true, null],
        ["voided_at", "timestamp with time zone", true, null],
        ["void_reason", "text", true, null],
      ],
    };

  it.each(EXPENSE_TABLES)(
    "S1 columns of %s: exact names, types, nullability and defaults (and no recurring columns)",
    async (table) => {
      const rows = await testDb<
        { name: string; type: string; nullable: boolean; def: string | null }[]
      >`
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as def
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = 'public' and c.relname = ${table} and a.attnum > 0 and not a.attisdropped
      order by a.attnum`;
      expect(rows.map((r) => [r.name, r.type, r.nullable, r.def])).toEqual(
        columnSpec[table],
      );
      expect(rows.map((r) => r.name)).not.toContain("template_id");
      expect(rows.map((r) => r.name)).not.toContain("period_start");
      const [recurring] = await testDb<
        { present: boolean }[]
      >`select to_regclass('public.recurring_expense_templates') is not null as present`;
      expect(
        recurring!.present,
        "no recurring object may exist in FIN.1B.1",
      ).toBe(false);
    },
  );

  const constraintSpec: Record<string, string[]> = {
    expense_categories: [
      "expense_categories_display_order_positive",
      "expense_categories_key_format",
      "expense_categories_kind_check",
      "expense_categories_pkey",
    ],
    expenses: [
      "expenses_amount_positive",
      "expenses_cancel_reason_length",
      "expenses_cancel_state_consistent",
      "expenses_cancelled_by_fkey",
      "expenses_category_key_fkey",
      "expenses_created_by_fkey",
      "expenses_currency_not_blank",
      "expenses_description_length",
      "expenses_due_date_range",
      "expenses_expense_date_range",
      "expenses_fingerprint_format",
      "expenses_id_tenant_unique",
      "expenses_idempotency_coherent",
      "expenses_idempotency_key_unique",
      "expenses_note_length",
      "expenses_pkey",
      "expenses_settlement_events_nonnegative",
      "expenses_status_check",
      "expenses_tenant_id_fkey",
      "expenses_vendor_name_length",
      "expenses_version_positive",
      "expenses_branch_id_fkey",
    ],
    expense_payments: [
      "expense_payments_amount_positive",
      "expense_payments_created_by_fkey",
      "expense_payments_expense_fk",
      "expense_payments_idempotency_key_unique",
      "expense_payments_method_check",
      "expense_payments_note_length",
      "expense_payments_paid_at_floor",
      "expense_payments_pkey",
      "expense_payments_status_check",
      "expense_payments_tenant_id_fkey",
      "expense_payments_void_reason_length",
      "expense_payments_void_state_consistent",
      "expense_payments_voided_by_fkey",
    ],
  };

  it.each(EXPENSE_TABLES)(
    "S2 constraints of %s: the exact named set, every FK is NO ACTION",
    async (table) => {
      const rows = await testDb<
        { name: string; type: string; del: string; upd: string; def: string }[]
      >`
      select conname as name, contype::text as type, confdeltype::text as del, confupdtype::text as upd, pg_get_constraintdef(oid) as def
      from pg_constraint where conrelid = ${`public.${table}`}::regclass and contype <> 'n' order by conname`;
      expect(rows.map((r) => r.name).sort()).toEqual(
        [...constraintSpec[table]!].sort(),
      );
      for (const fk of rows.filter((r) => r.type === "f")) {
        expect([fk.del, fk.upd], fk.name).toEqual(["a", "a"]);
      }
      const byName = Object.fromEntries(rows.map((r) => [r.name, r.def]));
      if (table === "expenses") {
        expect(byName.expenses_idempotency_key_unique).toBe(
          "UNIQUE (tenant_id, idempotency_key)",
        );
        expect(byName.expenses_id_tenant_unique).toBe("UNIQUE (id, tenant_id)");
        expect(byName.expenses_amount_positive).toMatch(/amount > \(?0/);
        expect(byName.expenses_category_key_fkey).toContain(
          "REFERENCES expense_categories(key)",
        );
        expect(byName.expenses_cancel_state_consistent).toContain(
          "'cancelled'",
        );
      }
      if (table === "expense_payments") {
        expect(byName.expense_payments_expense_fk).toBe(
          "FOREIGN KEY (expense_id, tenant_id) REFERENCES expenses(id, tenant_id)",
        );
        expect(byName.expense_payments_idempotency_key_unique).toBe(
          "UNIQUE (tenant_id, idempotency_key)",
        );
        expect(byName.expense_payments_method_check).toContain(
          "'bank_transfer'",
        );
        expect(byName.expense_payments_void_state_consistent).toContain(
          "'voided'",
        );
      }
    },
  );

  it("S3 indexes: exactly the planned set, none missing, no extras", async () => {
    const rows = await testDb<{ table: string; name: string; def: string }[]>`
      select tablename as table, indexname as name, indexdef as def from pg_indexes
      where schemaname = 'public' and tablename in ('expense_categories', 'expenses', 'expense_payments') order by indexname`;
    expect(rows.map((r) => r.name).sort()).toEqual(
      [
        "expense_categories_pkey",
        "expense_payments_expense_idx",
        "expense_payments_idempotency_key_unique",
        "expense_payments_pkey",
        "expense_payments_tenant_paid_at_idx",
        "expenses_id_tenant_unique",
        "expenses_idempotency_key_unique",
        "expenses_pkey",
        "expenses_tenant_date_idx",
        "expenses_tenant_outstanding_due_idx",
      ].sort(),
    );
    const def = Object.fromEntries(
      rows.map((r) => [r.name, r.def.replace(/\s+/g, " ")]),
    );
    expect(def.expenses_tenant_date_idx).toContain(
      "(tenant_id, expense_date DESC, id DESC)",
    );
    expect(def.expenses_tenant_outstanding_due_idx).toContain(
      "(tenant_id, due_date, id)",
    );
    expect(def.expenses_tenant_outstanding_due_idx).toMatch(
      /WHERE \(+status(::text)?\)? = ANY \(\(?ARRAY\['open'::text, 'partially_paid'::text\]/,
    );
    expect(def.expense_payments_expense_idx).toContain(
      "(expense_id, paid_at, id)",
    );
    expect(def.expense_payments_tenant_paid_at_idx).toContain(
      "(tenant_id, paid_at)",
    );
    expect(def.expense_payments_tenant_paid_at_idx).toMatch(
      /WHERE \(?status\)?(::text)? = 'posted'/,
    );
  });

  it.each(EXPENSE_TABLES)(
    "S4 RLS: enabled on %s with zero policies",
    async (table) => {
      const [row] = await testDb<{ rls: boolean; policies: string }[]>`
      select c.relrowsecurity as rls,
             (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::text as policies
      from pg_class c where c.oid = ${`public.${table}`}::regclass`;
      expect(row!.rls).toBe(true);
      expect(Number(row!.policies)).toBe(0);
    },
  );

  it.each(EXPENSE_TABLES)(
    "S5 table privileges: %s grants nothing to public, anon, authenticated or service_role",
    async (table) => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const privilege of [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
          "MAINTAIN",
        ]) {
          const [row] = await testDb<
            { ok: boolean }[]
          >`select has_table_privilege(${role}, ${`public.${table}`}, ${privilege}) as ok`;
          expect(row!.ok, `${role} ${privilege} on ${table}`).toBe(false);
        }
      }
      const [acl] = await testDb<{ others: string }[]>`
      select count(*)::text as others from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where c.oid = ${`public.${table}`}::regclass and a.grantee <> c.relowner`;
      expect(
        Number(acl!.others),
        "the ACL must be owner-only (no PUBLIC entry either)",
      ).toBe(0);
    },
  );

  const FUNCTIONS: [string, string, string, "i" | "s" | "v", boolean][] = [
    // public wrappers
    ["public", "list_expense_categories", "p_tenant_id uuid", "s", true],
    [
      "public",
      "get_expense_overview",
      "p_tenant_id uuid, p_month date, p_branch_id uuid, p_general_only boolean, p_reference_date date",
      "s",
      true,
    ],
    [
      "public",
      "list_expenses",
      "p_tenant_id uuid, p_from_date date, p_to_date date, p_branch_id uuid, p_general_only boolean, p_category_key text, p_status text, p_include_cancelled boolean, p_overdue_only boolean, p_search text, p_limit integer, p_cursor_date date, p_cursor_id uuid, p_reference_date date",
      "s",
      true,
    ],
    [
      "public",
      "get_expense",
      "p_expense_id uuid, p_reference_date date",
      "s",
      true,
    ],
    [
      "public",
      "create_expense",
      "p_tenant_id uuid, p_category_key text, p_description text, p_expense_date date, p_amount numeric, p_idempotency_key uuid, p_branch_id uuid, p_vendor_name text, p_due_date date, p_note text, p_initial_payment jsonb",
      "v",
      true,
    ],
    [
      "public",
      "update_expense",
      "p_expense_id uuid, p_category_key text, p_description text, p_expense_date date, p_amount numeric, p_expected_version integer, p_branch_id uuid, p_vendor_name text, p_due_date date, p_note text",
      "v",
      true,
    ],
    ["public", "cancel_expense", "p_expense_id uuid, p_reason text", "v", true],
    [
      "public",
      "record_expense_payment",
      "p_expense_id uuid, p_amount numeric, p_method text, p_paid_at timestamp with time zone, p_note text, p_idempotency_key uuid",
      "v",
      true,
    ],
    [
      "public",
      "void_expense_payment",
      "p_payment_id uuid, p_reason text",
      "v",
      true,
    ],
    // private RPC implementations
    ["private", "list_expense_categories", "p_tenant_id uuid", "s", true],
    [
      "private",
      "get_expense_overview",
      "p_tenant_id uuid, p_month date, p_branch_id uuid, p_general_only boolean, p_reference_date date",
      "s",
      true,
    ],
    [
      "private",
      "list_expenses",
      "p_tenant_id uuid, p_from_date date, p_to_date date, p_branch_id uuid, p_general_only boolean, p_category_key text, p_status text, p_include_cancelled boolean, p_overdue_only boolean, p_search text, p_limit integer, p_cursor_date date, p_cursor_id uuid, p_reference_date date",
      "s",
      true,
    ],
    [
      "private",
      "get_expense",
      "p_expense_id uuid, p_reference_date date",
      "s",
      true,
    ],
    [
      "private",
      "create_expense",
      "p_tenant_id uuid, p_category_key text, p_description text, p_expense_date date, p_amount numeric, p_idempotency_key uuid, p_branch_id uuid, p_vendor_name text, p_due_date date, p_note text, p_initial_payment jsonb",
      "v",
      true,
    ],
    [
      "private",
      "update_expense",
      "p_expense_id uuid, p_category_key text, p_description text, p_expense_date date, p_amount numeric, p_expected_version integer, p_branch_id uuid, p_vendor_name text, p_due_date date, p_note text",
      "v",
      true,
    ],
    [
      "private",
      "cancel_expense",
      "p_expense_id uuid, p_reason text",
      "v",
      true,
    ],
    [
      "private",
      "record_expense_payment",
      "p_expense_id uuid, p_amount numeric, p_method text, p_paid_at timestamp with time zone, p_note text, p_idempotency_key uuid",
      "v",
      true,
    ],
    [
      "private",
      "void_expense_payment",
      "p_payment_id uuid, p_reason text",
      "v",
      true,
    ],
    // helpers
    [
      "private",
      "compute_expense_status",
      "p_amount numeric, p_posted numeric",
      "i",
      false,
    ],
    ["private", "expense_posted_total", "p_expense_id uuid", "s", true],
    ["private", "expense_settlement_events", "p_expense_id uuid", "s", true],
    ["private", "tenant_local_date", "p_tenant_id uuid", "s", true],
    ["private", "normalize_expense_text", "p_text text", "i", false],
    ["private", "normalize_expense_amount", "p_amount numeric", "i", false],
    [
      "private",
      "expense_create_fingerprint",
      "p_branch_id uuid, p_category_key text, p_expense_date date, p_due_date date, p_amount numeric, p_description text, p_vendor_name text, p_note text, p_ip_amount numeric, p_ip_method text, p_ip_paid_at timestamp with time zone, p_ip_note text",
      "i",
      false,
    ],
    [
      "private",
      "normalize_expense_payment_input",
      "p_amount numeric, p_method text, p_paid_at timestamp with time zone, p_note text",
      "s",
      false,
    ],
    [
      "private",
      "post_expense_payment",
      "p_tenant_id uuid, p_expense_id uuid, p_amount numeric, p_method text, p_paid_at timestamp with time zone, p_note text, p_idempotency_key uuid",
      "v",
      true,
    ],
    // trigger functions
    ["private", "enforce_expense_invariants", "", "v", true],
    ["private", "enforce_expense_payment_invariants", "", "v", true],
    ["private", "recalculate_expense_status", "", "v", true],
  ];

  it("S6 functions: exactly 30 new ones with the planned identity arguments, volatility, security definer and a pinned empty search_path", async () => {
    expect(FUNCTIONS).toHaveLength(30);
    const rows = await testDb<
      {
        schema: string;
        name: string;
        args: string;
        volatility: string;
        definer: boolean;
        config: string[] | null;
        owner: string;
      }[]
    >`
      select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args, p.provolatile::text as volatility,
             p.prosecdef as definer, p.proconfig as config, pg_get_userbyid(p.proowner) as owner
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and (p.proname like '%expense%' or p.proname = 'tenant_local_date')
      order by n.nspname, p.proname`;
    const actual = rows
      .map((r) => [r.schema, r.name, r.args])
      .sort((a, b) => `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`));
    const expected = FUNCTIONS.map(([s, n, a]) => [s, n, a]).sort((a, b) =>
      `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`),
    );
    expect(actual).toEqual(expected);
    for (const [schema, name, , volatility, definer] of FUNCTIONS) {
      const row = rows.find((r) => r.schema === schema && r.name === name)!;
      expect(row.volatility, `${schema}.${name} volatility`).toBe(volatility);
      expect(row.definer, `${schema}.${name} security definer`).toBe(definer);
      if (definer)
        expect(row.config, `${schema}.${name} search_path`).toContain(
          'search_path=""',
        );
      expect(row.owner).toBe("postgres");
    }
  });

  it("S7 execute grants: the nine wrappers are executable by authenticated only (anon and PUBLIC never); the other 21 functions have no API-role or PUBLIC grant", async () => {
    // service_role is not granted by this migration (same convention as FIN.1A): on a PROD-like database it has no
    // function default privileges and therefore no execute; where an environment's default privileges grant it (the
    // local rig's Supabase simulation, DEV's bootstrap) it inherits exactly that and nothing more.
    const [dp] = await testDb<{ svc_default: boolean }[]>`
      select exists (
        select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
        where d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'f'
          and a.grantee = 'service_role'::regrole and a.privilege_type = 'EXECUTE'
      ) as svc_default`;
    for (const [schema, name, args] of FUNCTIONS) {
      const [row] = await testDb<{ oid: string }[]>`
        select p.oid::text as oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = ${schema} and p.proname = ${name} and pg_get_function_identity_arguments(p.oid) = ${args}`;
      const oid = row!.oid;
      const can = async (role: string) =>
        (
          await testDb<
            { ok: boolean }[]
          >`select has_function_privilege(${role}, ${oid}::oid, 'EXECUTE') as ok`
        )[0]!.ok;
      const isWrapper = schema === "public";
      expect(
        await can("authenticated"),
        `${schema}.${name} authenticated`,
      ).toBe(isWrapper);
      expect(await can("anon"), `${schema}.${name} anon`).toBe(false);
      expect(await can("service_role"), `${schema}.${name} service_role`).toBe(
        isWrapper ? dp!.svc_default : false,
      );
      const [acl] = await testDb<{ public_entries: string }[]>`
        select count(*)::text as public_entries from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = ${oid}::oid and a.grantee = 0`;
      expect(
        Number(acl!.public_entries),
        `${schema}.${name} PUBLIC execute`,
      ).toBe(0);
    }
  });

  it("S8 triggers: exactly the three planned ones, none on any other table", async () => {
    const rows = await testDb<{ name: string; table: string; def: string }[]>`
      select t.tgname as name, c.relname as table, pg_get_triggerdef(t.oid) as def
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
      where not t.tgisinternal and pn.nspname = 'private' and p.proname in ('enforce_expense_invariants', 'enforce_expense_payment_invariants', 'recalculate_expense_status')
      order by t.tgname`;
    const norm = (s: string) => s.replace(/\s+/g, " ");
    expect(rows.map((r) => [r.name, r.table, norm(r.def)])).toEqual([
      [
        "enforce_expense_invariants_trg",
        "expenses",
        "CREATE TRIGGER enforce_expense_invariants_trg BEFORE INSERT OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION private.enforce_expense_invariants()",
      ],
      [
        "enforce_expense_payment_invariants_trg",
        "expense_payments",
        "CREATE TRIGGER enforce_expense_payment_invariants_trg BEFORE INSERT OR UPDATE ON public.expense_payments FOR EACH ROW EXECUTE FUNCTION private.enforce_expense_payment_invariants()",
      ],
      [
        "recalculate_expense_status_trg",
        "expense_payments",
        "CREATE TRIGGER recalculate_expense_status_trg AFTER INSERT OR UPDATE OF status ON public.expense_payments FOR EACH ROW EXECUTE FUNCTION private.recalculate_expense_status()",
      ],
    ]);
    const [all] = await testDb<{ n: string }[]>`
      select count(*)::text as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname in ('expense_categories', 'expenses', 'expense_payments')`;
    expect(
      Number(all!.n),
      "no other trigger may sit on the expense tables",
    ).toBe(3);
  });

  it("S9 category seed: 16 keys (8 fixed, 8 variable) with the exact display_order, all active; re-running the seed is idempotent and keeps is_active", async () => {
    const rows = await testDb<
      { key: string; kind: string; display_order: number; is_active: boolean }[]
    >`select key, kind, display_order, is_active from expense_categories order by display_order, key`;
    expect(
      rows.map((r) => [r.key, r.kind, r.display_order, r.is_active]),
    ).toEqual([
      ["rent", "fixed", 10, true],
      ["electricity", "fixed", 20, true],
      ["water", "fixed", 30, true],
      ["internet", "fixed", 40, true],
      ["phone", "fixed", 50, true],
      ["accountant", "fixed", 60, true],
      ["software", "fixed", 70, true],
      ["pos_fees", "fixed", 80, true],
      ["supplies", "variable", 110, true],
      ["beauty_products", "variable", 120, true],
      ["cleaning", "variable", 130, true],
      ["advertising", "variable", 140, true],
      ["food", "variable", 150, true],
      ["transport", "variable", 160, true],
      ["repairs", "variable", 170, true],
      ["other", "variable", 180, true],
    ]);
    const sql = readFileSync(MIGRATION, "utf8");
    const seed = sql.match(
      /insert into public\.expense_categories \(key, kind, display_order\) values[\s\S]*?on conflict \(key\) do update set kind = excluded\.kind, display_order = excluded\.display_order;/,
    );
    expect(seed, "the seed statement must be in the migration").not.toBeNull();
    class Rollback extends Error {}
    await expect(
      testDb.begin(async (tx) => {
        await tx`update expense_categories set is_active = false where key = 'water'`;
        await tx.unsafe(seed![0]);
        const after = await tx<
          {
            key: string;
            kind: string;
            display_order: number;
            is_active: boolean;
          }[]
        >`select key, kind, display_order, is_active from expense_categories order by display_order, key`;
        expect(after.map((r) => [r.key, r.kind, r.display_order])).toEqual(
          rows.map((r) => [r.key, r.kind, r.display_order]),
        );
        expect(
          after.find((r) => r.key === "water")!.is_active,
          "a retired category stays retired",
        ).toBe(false);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it("S10 FIN.1A is untouched: the frozen migration file hash, and every FIN.1A function body in this database equals that file", async () => {
    const text = readFileSync(FIN1A_MIGRATION);
    expect(createHash("sha256").update(text).digest("hex")).toBe(FIN1A_SHA256);
    const sql = text.toString("utf8");
    const chunks = sql.split(/\ncreate function /).slice(1);
    expect(chunks.length).toBe(12);
    for (const chunk of chunks) {
      const name = chunk.slice(0, chunk.indexOf("("));
      const body = chunk.match(/\bas \$\$([\s\S]*?)\$\$;/)![1]!;
      const [schema, fn] = name.split(".") as [string, string];
      const [row] = await testDb<{ prosrc: string }[]>`
        select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ${schema} and p.proname = ${fn}`;
      expect(
        row?.prosrc,
        `${name} must exist and be byte-identical to the frozen FIN.1A migration`,
      ).toBe(body);
    }
  });

  it("S11 additions only: the permission catalog and the role templates are untouched", async () => {
    const [perms] = await testDb<{ n: string; fin: string }[]>`
      select count(*)::text as n, count(*) filter (where key in ('finance.view', 'finance.manage', 'reports.financial'))::text as fin from permissions`;
    expect(Number(perms!.n)).toBe(23);
    expect(Number(perms!.fin)).toBe(3);
    const [owner] = await testDb<{ n: string }[]>`
      select count(*)::text as n from role_template_permissions rtp join role_templates rt on rt.id = rtp.role_template_id where rt.key = 'SALON_OWNER'`;
    expect(Number(owner!.n)).toBe(23);
    const templates = await testDb<
      { key: string }[]
    >`select key from role_templates order by key`;
    expect(templates.map((t) => t.key)).toEqual([
      "ACCOUNTANT",
      "CASHIER",
      "RECEPTIONIST",
      "SALON_MANAGER",
      "SALON_OWNER",
      "STOCK_MANAGER",
      "STYLIST",
    ]);
  });

  it("S13 function-body identity: every live function body equals the migration text", async () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const chunks = sql.split(/\ncreate function /).slice(1);
    expect(chunks.length).toBe(30);
    for (const chunk of chunks) {
      const name = chunk.slice(0, chunk.indexOf("("));
      const body = chunk.match(/\bas \$\$([\s\S]*?)\$\$;/)![1]!;
      const [schema, fn] = name.split(".") as [string, string];
      const [row] = await testDb<{ prosrc: string }[]>`
        select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ${schema} and p.proname = ${fn}`;
      expect(
        row?.prosrc,
        `${name} must be byte-identical to the migration text`,
      ).toBe(body);
    }
  });

  it("S12 migration hygiene: only create/insert/comment/RLS/revoke/grant/trigger statements on new objects, wrapped in begin/commit", () => {
    const raw = readFileSync(MIGRATION, "utf8");
    expect(raw).not.toContain("\r");
    const withoutBodies = raw.replace(/\$\$[\s\S]*?\$\$/g, () => "$$$$");
    const statements = splitSqlStatements(raw);
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
    const allowed: RegExp[] = [
      /^begin$/,
      /^commit$/,
      /^create table public\.(expense_categories|expenses|expense_payments) \(/,
      /^create index [a-z_]+ on public\.(expenses|expense_payments) /,
      /^alter table public\.(expense_categories|expenses|expense_payments) enable row level security$/,
      /^revoke all on public\.(expense_categories|expenses|expense_payments) from public, anon, authenticated, service_role$/,
      /^insert into public\.expense_categories \(key, kind, display_order\) values /,
      /^comment on (table|function) (public|private)\.[a-z_]+/,
      /^create function (public|private)\.[a-z_]+\(/,
      /^create trigger [a-z_]+ (before|after) /,
      /^revoke execute on function (public|private)\.[a-z_]+\(.*\) from (public|public, anon)$/,
      /^grant execute on function public\.[a-z_]+\(.*\) to authenticated$/,
    ];
    const offenders = statements.filter(
      (s) => !allowed.some((re) => re.test(s)),
    );
    expect(offenders).toEqual([]);
    for (const s of statements) {
      expect(s).not.toMatch(/^(drop|truncate|delete|update)\b/i);
    }
    expect(withoutBodies).not.toMatch(/\bdrop\b/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CAT — the category catalog
// ---------------------------------------------------------------------------------------------------------------
describe("CAT category catalog", () => {
  it("CAT1 list_expense_categories returns the 16 active categories ordered by display_order then key", async () => {
    const out = await expectOk(await listCategories(world.owner.id, T()));
    expect(out).toHaveLength(16);
    expect(out[0]).toEqual({ key: "rent", kind: "fixed", displayOrder: 10 });
    expect(out[15]).toEqual({
      key: "other",
      kind: "variable",
      displayOrder: 180,
    });
    expect(out.map((c) => c.displayOrder)).toEqual(
      [...out.map((c) => c.displayOrder)].sort((a, b) => a - b),
    );
    expect(out.filter((c) => c.kind === "fixed")).toHaveLength(8);
    expect(out.filter((c) => c.kind === "variable")).toHaveLength(8);
    expect(Object.keys(out[0]!).sort()).toEqual([
      "displayOrder",
      "key",
      "kind",
    ]);
  });

  it("CAT2 an inactive category is excluded from the list and rejected by create and by update", async () => {
    const e = await makeExpense(world, { categoryKey: "supplies" });
    await testDb`update expense_categories set is_active = false where key = 'phone'`;
    try {
      const list = await expectOk(await listCategories(world.owner.id, T()));
      expect(list.map((c) => c.key)).not.toContain("phone");
      expect(list).toHaveLength(15);
      expect(
        failure(
          await createExpense(
            world.owner.id,
            validCreate(world, { categoryKey: "phone" }),
          ),
        ),
      ).toBe("FN004");
      const row = await expenseRow(e.expenseId);
      expect(
        failure(
          await updateExpense(world.owner.id, {
            expenseId: row.id,
            categoryKey: "phone",
            description: row.description,
            expenseDate: row.expense_date,
            amount: row.amount,
            expectedVersion: row.version,
          }),
        ),
      ).toBe("FN004");
    } finally {
      await testDb`update expense_categories set is_active = true where key = 'phone'`;
    }
  });

  it("CAT3 an expense in a later-retired category still reads normally", async () => {
    const e = await makeExpense(world, { categoryKey: "pos_fees" });
    await testDb`update expense_categories set is_active = false where key = 'pos_fees'`;
    try {
      expect(
        await expectOk(await getExpense(world.owner.id, e.expenseId)),
      ).toMatchObject({ categoryKey: "pos_fees", categoryKind: "fixed" });
    } finally {
      await testDb`update expense_categories set is_active = true where key = 'pos_fees'`;
    }
  });

  it("CAT4 a caller without finance.view gets FN002", async () => {
    for (const who of [
      world.manageOnly,
      world.neither,
      world.stranger,
      world.otherOwner,
    ]) {
      expect(failure(await listCategories(who.id, T()))).toBe("FN002");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// P — permissions and tenant boundaries
// ---------------------------------------------------------------------------------------------------------------
describe("P permissions and tenant boundaries", () => {
  type Caller = {
    name: string;
    who: () => { id: string } | null;
    expectCode: string | null;
  };
  const READ_CALLERS: Caller[] = [
    { name: "owner", who: () => world.owner, expectCode: null },
    { name: "view-only role", who: () => world.viewOnly, expectCode: null },
    {
      name: "manage-only role",
      who: () => world.manageOnly,
      expectCode: "FN002",
    },
    {
      name: "appointments.view-only role",
      who: () => world.neither,
      expectCode: "FN002",
    },
    { name: "default Yönetici", who: () => world.manager, expectCode: "FN002" },
    {
      name: "default Resepsiyon",
      who: () => world.receptionist,
      expectCode: "FN002",
    },
    { name: "default Personel", who: () => world.stylist, expectCode: "FN002" },
    { name: "no membership", who: () => world.stranger, expectCode: "FN002" },
    {
      name: "another tenant's owner",
      who: () => world.otherOwner,
      expectCode: "FN002",
    },
    { name: "no JWT", who: () => null, expectCode: "FN001" },
  ];

  const WRITE_CALLERS: Caller[] = [
    { name: "owner", who: () => world.owner, expectCode: null },
    { name: "manage-only role", who: () => world.manageOnly, expectCode: null },
    { name: "view-only role", who: () => world.viewOnly, expectCode: "FN002" },
    {
      name: "appointments.view-only role",
      who: () => world.neither,
      expectCode: "FN002",
    },
    { name: "default Yönetici", who: () => world.manager, expectCode: "FN002" },
    {
      name: "default Resepsiyon",
      who: () => world.receptionist,
      expectCode: "FN002",
    },
    { name: "default Personel", who: () => world.stylist, expectCode: "FN002" },
    { name: "no membership", who: () => world.stranger, expectCode: "FN002" },
    {
      name: "another tenant's owner",
      who: () => world.otherOwner,
      expectCode: "FN002",
    },
    { name: "no JWT", who: () => null, expectCode: "FN001" },
  ];

  async function run(who: { id: string } | null, fn: string, args: RpcArg[]) {
    return who ? callRpc(who.id, fn, args) : callRpcNoJwt(fn, args);
  }

  describe("P1 the four read RPCs × callers", () => {
    const reads: [
      string,
      (expenseId: string) => { fn: string; args: RpcArg[] },
    ][] = [
      [
        "list_expense_categories",
        () => ({
          fn: "list_expense_categories",
          args: [["p_tenant_id", T(), "uuid"]],
        }),
      ],
      [
        "get_expense_overview",
        () => ({
          fn: "get_expense_overview",
          args: [
            ["p_tenant_id", T(), "uuid"],
            ["p_reference_date", "2026-09-15", "date"],
          ],
        }),
      ],
      [
        "list_expenses",
        () => ({ fn: "list_expenses", args: [["p_tenant_id", T(), "uuid"]] }),
      ],
      [
        "get_expense",
        (id) => ({ fn: "get_expense", args: [["p_expense_id", id, "uuid"]] }),
      ],
    ];
    it.each(reads)("%s", async (_name, build) => {
      const e = await makeExpense(world);
      for (const caller of READ_CALLERS) {
        const { fn, args } = build(e.expenseId);
        const out = await run(caller.who(), fn, args);
        if (caller.expectCode === null) expect(out.ok, caller.name).toBe(true);
        else expect(failure(out), caller.name).toBe(caller.expectCode);
      }
    });
  });

  describe("P2 the five write RPCs × callers: a refusal changes nothing and writes no audit row", () => {
    // third element: whether the target expense carries a posted payment (cancel needs one WITHOUT, void needs one WITH)
    const writes: [
      string,
      (
        id: string,
        paymentId: string,
        version: number,
      ) => { fn: string; args: RpcArg[] },
      boolean,
    ][] = [
      [
        "create_expense",
        () => ({
          fn: "create_expense",
          args: [
            ["p_tenant_id", T(), "uuid"],
            ["p_category_key", "supplies", "text"],
            ["p_description", "izin testi", "text"],
            ["p_expense_date", "2026-10-01", "date"],
            ["p_amount", 10, "numeric"],
            ["p_idempotency_key", newKey(), "uuid"],
          ],
        }),
        false,
      ],
      [
        "update_expense",
        (id, _p, version) => ({
          fn: "update_expense",
          args: [
            ["p_expense_id", id, "uuid"],
            ["p_category_key", "supplies", "text"],
            ["p_description", "izin testi guncel", "text"],
            ["p_expense_date", "2026-10-01", "date"],
            ["p_amount", 1000, "numeric"],
            ["p_expected_version", version, "integer"],
          ],
        }),
        true,
      ],
      [
        "cancel_expense",
        (id) => ({
          fn: "cancel_expense",
          args: [
            ["p_expense_id", id, "uuid"],
            ["p_reason", "izin testi", "text"],
          ],
        }),
        false,
      ],
      [
        "record_expense_payment",
        (id) => ({
          fn: "record_expense_payment",
          args: [
            ["p_expense_id", id, "uuid"],
            ["p_amount", 5, "numeric"],
            ["p_method", "cash", "text"],
            ["p_paid_at", instantAgo(5), "timestamptz"],
            ["p_idempotency_key", newKey(), "uuid"],
          ],
        }),
        true,
      ],
      [
        "void_expense_payment",
        (_id, paymentId) => ({
          fn: "void_expense_payment",
          args: [
            ["p_payment_id", paymentId, "uuid"],
            ["p_reason", "izin testi", "text"],
          ],
        }),
        true,
      ],
    ];
    it.each(writes)("%s", async (_name, build, withPayment) => {
      for (const caller of WRITE_CALLERS) {
        // a fresh expense (with one payment where the RPC needs one) per attempt, so an earlier successful caller never changes the target
        const e = await makeExpense(world, { amount: 1000 });
        const p = withPayment
          ? await makePayment(world, e.expenseId, 100)
          : null;
        const version = (await expenseRow(e.expenseId)).version;
        const { fn, args } = build(
          e.expenseId,
          p?.paymentId ?? newKey(),
          version,
        );
        const before = await tenantDigest(T());
        const beforeCounts = await counts(T());
        const out = await run(caller.who(), fn, args);
        if (caller.expectCode === null) {
          expect(out.ok, caller.name).toBe(true);
        } else {
          expect(failure(out), caller.name).toBe(caller.expectCode);
          expect(
            await tenantDigest(T()),
            `${caller.name}: nothing changed`,
          ).toBe(before);
          expect(
            await counts(T()),
            `${caller.name}: no row or audit written`,
          ).toEqual(beforeCounts);
        }
      }
    });
  });

  it("P3 id-based RPCs with another tenant's ids are FN002, never FN003; a random id is FN003 (FN009 for a payment)", async () => {
    const mine = await makeExpense(world, { amount: 100 });
    const myPayment = await makePayment(world, mine.expenseId, 10);
    const theirs = await expectOk(
      await createExpense(world.otherOwner.id, {
        ...validCreate(world),
        tenantId: world.otherTenant.id,
      }),
    );
    const theirsPay = await expectOk(
      await recordPayment(world.otherOwner.id, {
        expenseId: theirs.expenseId,
        amount: 5,
        method: "cash",
        paidAt: instantAgo(5),
        idempotencyKey: newKey(),
      }),
    );
    const before = await tenantDigest(T());
    expect(failure(await getExpense(world.otherOwner.id, mine.expenseId))).toBe(
      "FN002",
    );
    expect(
      failure(
        await cancelExpense(world.otherOwner.id, mine.expenseId, "baska salon"),
      ),
    ).toBe("FN002");
    expect(
      failure(
        await recordPayment(world.otherOwner.id, {
          expenseId: mine.expenseId,
          amount: 1,
          method: "cash",
          paidAt: instantAgo(5),
          idempotencyKey: newKey(),
        }),
      ),
    ).toBe("FN002");
    expect(
      failure(
        await voidPayment(
          world.otherOwner.id,
          myPayment.paymentId!,
          "baska salon",
        ),
      ),
    ).toBe("FN002");
    expect(
      failure(
        await updateExpense(world.otherOwner.id, {
          expenseId: mine.expenseId,
          categoryKey: "supplies",
          description: "x",
          expenseDate: "2026-10-01",
          amount: 100,
          expectedVersion: 1,
        }),
      ),
    ).toBe("FN002");
    expect(failure(await getExpense(world.owner.id, theirs.expenseId))).toBe(
      "FN002",
    );
    expect(
      failure(
        await voidPayment(world.owner.id, theirsPay.paymentId!, "baska salon"),
      ),
    ).toBe("FN002");
    expect(await tenantDigest(T())).toBe(before);
    const ghost = newKey();
    expect(failure(await getExpense(world.owner.id, ghost))).toBe("FN003");
    expect(failure(await cancelExpense(world.owner.id, ghost, "yok"))).toBe(
      "FN003",
    );
    expect(
      failure(
        await recordPayment(world.owner.id, {
          expenseId: ghost,
          amount: 1,
          method: "cash",
          paidAt: instantAgo(5),
          idempotencyKey: newKey(),
        }),
      ),
    ).toBe("FN003");
    expect(
      failure(
        await updateExpense(world.owner.id, {
          expenseId: ghost,
          categoryKey: "supplies",
          description: "x",
          expenseDate: "2026-10-01",
          amount: 100,
          expectedVersion: 1,
        }),
      ),
    ).toBe("FN003");
    expect(failure(await voidPayment(world.owner.id, ghost, "yok"))).toBe(
      "FN009",
    );
  });

  it("P4 create_expense with a foreign or nonexistent tenant is FN002 (no existence hint); a null tenant is FN004", async () => {
    const before = await counts(T());
    expect(
      failure(
        await createExpense(
          world.owner.id,
          validCreate(world, { tenantId: world.otherTenant.id }),
        ),
      ),
    ).toBe("FN002");
    expect(
      failure(
        await createExpense(
          world.owner.id,
          validCreate(world, { tenantId: newKey() }),
        ),
      ),
    ).toBe("FN002");
    expect(
      failure(
        await createExpense(
          world.owner.id,
          validCreate(world, { tenantId: null }),
        ),
      ),
    ).toBe("FN004");
    expect(await counts(T())).toEqual(before);
  });

  it("P5 anon cannot execute any wrapper (42501) and an authenticated session without a JWT is FN001", async () => {
    const e = await makeExpense(world);
    const argsFor: Record<string, RpcArg[]> = {
      list_expense_categories: [["p_tenant_id", T(), "uuid"]],
      get_expense_overview: [["p_tenant_id", T(), "uuid"]],
      list_expenses: [["p_tenant_id", T(), "uuid"]],
      get_expense: [["p_expense_id", e.expenseId, "uuid"]],
      create_expense: [
        ["p_tenant_id", T(), "uuid"],
        ["p_category_key", "supplies", "text"],
        ["p_description", "x", "text"],
        ["p_expense_date", "2026-10-01", "date"],
        ["p_amount", 1, "numeric"],
        ["p_idempotency_key", newKey(), "uuid"],
      ],
      update_expense: [
        ["p_expense_id", e.expenseId, "uuid"],
        ["p_category_key", "supplies", "text"],
        ["p_description", "x", "text"],
        ["p_expense_date", "2026-10-01", "date"],
        ["p_amount", 1, "numeric"],
        ["p_expected_version", 1, "integer"],
      ],
      cancel_expense: [
        ["p_expense_id", e.expenseId, "uuid"],
        ["p_reason", "x", "text"],
      ],
      record_expense_payment: [
        ["p_expense_id", e.expenseId, "uuid"],
        ["p_amount", 1, "numeric"],
        ["p_method", "cash", "text"],
        ["p_paid_at", instantAgo(5), "timestamptz"],
        ["p_idempotency_key", newKey(), "uuid"],
      ],
      void_expense_payment: [
        ["p_payment_id", newKey(), "uuid"],
        ["p_reason", "x", "text"],
      ],
    };
    for (const fn of EXPENSE_WRAPPERS) {
      expect(failure(await callRpcAsAnon(fn, argsFor[fn]!)), `anon ${fn}`).toBe(
        "42501",
      );
      expect(
        failure(await callRpcNoJwt(fn, argsFor[fn]!)),
        `no-jwt ${fn}`,
      ).toBe("FN001");
    }
  });

  it("P6 a permission change takes effect on the very next call", async () => {
    const attempt = () =>
      createExpense(world.manageOnly.id, validCreate(world));
    expect((await attempt()).ok).toBe(true);

    // 1. the role loses finance.manage
    await testDb`delete from role_permissions where role_id = ${world.roles.manageOnly} and permission_id = (select id from permissions where key = 'finance.manage')`;
    try {
      expect(failure(await attempt())).toBe("FN002");
    } finally {
      await testDb`insert into role_permissions (role_id, permission_id) select ${world.roles.manageOnly}, id from permissions where key = 'finance.manage'`;
    }
    expect((await attempt()).ok).toBe(true);

    // 2. the membership is suspended
    await testDb`update tenant_memberships set status = 'suspended' where tenant_id = ${T()} and user_id = ${world.manageOnly.id}`;
    try {
      expect(failure(await attempt())).toBe("FN002");
    } finally {
      await testDb`update tenant_memberships set status = 'active' where tenant_id = ${T()} and user_id = ${world.manageOnly.id}`;
    }
    expect((await attempt()).ok).toBe(true);

    // 3. the membership is removed
    await testDb`update tenant_memberships set deleted_at = now() where tenant_id = ${T()} and user_id = ${world.manageOnly.id}`;
    try {
      expect(failure(await attempt())).toBe("FN002");
    } finally {
      await testDb`update tenant_memberships set deleted_at = null where tenant_id = ${T()} and user_id = ${world.manageOnly.id}`;
    }
  });

  it("P7 ordinary staff obtain no expense amount through any RPC, through audit_logs or through the tables", async () => {
    const e = await makeExpense(world, {
      amount: 4242,
      initialPayment: { amount: 100, method: "cash", paid_at: instantAgo(5) },
    });
    for (const who of [world.stylist, world.receptionist, world.neither]) {
      expect(failure(await getExpense(who.id, e.expenseId))).toBe("FN002");
      expect(failure(await listExpenses(who.id, { tenantId: T() }))).toBe(
        "FN002",
      );
      expect(failure(await getOverview(who.id, T()))).toBe("FN002");
      const visibleAudit = await asAuthenticatedUser(
        who.id,
        (sql) =>
          sql`select count(*)::int as n from audit_logs where tenant_id = ${T()} and action like 'finance.%'`,
      );
      expect(
        visibleAudit[0]!.n,
        "finance audit events are invisible to ordinary staff",
      ).toBe(0);
      for (const table of EXPENSE_TABLES) {
        await expect(
          asAuthenticatedUser(who.id, (sql) =>
            sql.unsafe(`select * from public.${table} limit 1`),
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A10 — audit read gate
// ---------------------------------------------------------------------------------------------------------------
describe("A audit (read gate)", () => {
  it("A10 a default Yönetici cannot read audit_logs, so expense amounts do not leak through it; the unrestricted owner can", async () => {
    const e = await makeExpense(world, { amount: 9876.5 });
    const read = (userId: string) =>
      asAuthenticatedUser(
        userId,
        (sql) =>
          sql`select count(*)::int as n from audit_logs where tenant_id = ${T()} and action = 'finance.expense_created' and entity_id = ${e.expenseId}`,
      );
    expect((await read(world.owner.id))[0]!.n).toBe(1);
    expect((await read(world.manager.id))[0]!.n).toBe(0);
    expect((await read(world.viewOnly.id))[0]!.n).toBe(0);
  });
});
