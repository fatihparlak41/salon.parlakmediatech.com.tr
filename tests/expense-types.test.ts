import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Faz FIN.1B.1 — the Supabase types carry the new surface (matrix F14): the three tables with their exact columns and the nine
 * wrapper functions with their exact argument names, types and optionality, every one returning Json. The file is parsed as
 * TypeScript (not matched with regular expressions) and also compared with the migration's own function signatures, so the
 * types and the SQL cannot drift apart. No database needed.
 *
 * When database.types.ts is regenerated from a real database (supabase gen types), this test must keep passing unchanged.
 */

const root = process.cwd();
const typesSource = ts.createSourceFile(
  "database.types.ts",
  readFileSync(path.join(root, "lib/supabase/database.types.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function propertyNamed(
  node: ts.TypeLiteralNode,
  name: string,
): ts.PropertySignature | undefined {
  return node.members
    .filter(ts.isPropertySignature)
    .find(
      (m) =>
        (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) &&
        m.name.text === name,
    );
}

function literalOf(prop: ts.PropertySignature | undefined): ts.TypeLiteralNode {
  if (!prop?.type || !ts.isTypeLiteralNode(prop.type))
    throw new Error(`expected a type literal at ${prop?.name.getText()}`);
  return prop.type;
}

const databaseAlias = typesSource.statements.find(
  (s): s is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(s) && s.name.text === "Database",
)!;
const publicSchema = literalOf(
  propertyNamed(databaseAlias.type as ts.TypeLiteralNode, "public"),
);
const tables = literalOf(propertyNamed(publicSchema, "Tables"));
const functions = literalOf(propertyNamed(publicSchema, "Functions"));

type Field = { type: string; optional: boolean };

function fields(literal: ts.TypeLiteralNode): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const m of literal.members.filter(ts.isPropertySignature)) {
    out[(m.name as ts.Identifier).text] = {
      type: m.type!.getText().replace(/\s+/g, " "),
      optional: m.questionToken !== undefined,
    };
  }
  return out;
}

const required = (type: string): Field => ({ type, optional: false });
const optional = (type: string): Field => ({ type, optional: true });

const TABLE_ROWS: Record<string, Record<string, string>> = {
  expense_categories: {
    created_at: "string",
    display_order: "number",
    is_active: "boolean",
    key: "string",
    kind: "string",
  },
  expense_payments: {
    amount: "number",
    created_at: "string",
    created_by: "string | null",
    expense_id: "string",
    id: "string",
    idempotency_key: "string",
    method: "string",
    note: "string | null",
    paid_at: "string",
    status: "string",
    tenant_id: "string",
    void_reason: "string | null",
    voided_at: "string | null",
    voided_by: "string | null",
  },
  expenses: {
    amount: "number",
    branch_id: "string | null",
    cancel_reason: "string | null",
    cancelled_at: "string | null",
    cancelled_by: "string | null",
    category_key: "string",
    created_at: "string",
    created_by: "string | null",
    currency: "string",
    description: "string",
    due_date: "string | null",
    expense_date: "string",
    id: "string",
    idempotency_fingerprint: "string | null",
    idempotency_key: "string | null",
    note: "string | null",
    settlement_events: "number",
    status: "string",
    tenant_id: "string",
    updated_at: "string",
    vendor_name: "string | null",
    version: "number",
  },
};

// columns a caller MUST supply on insert (no default, not nullable)
const INSERT_REQUIRED: Record<string, string[]> = {
  expense_categories: ["display_order", "key", "kind"],
  expense_payments: [
    "amount",
    "expense_id",
    "idempotency_key",
    "method",
    "tenant_id",
  ],
  expenses: [
    "amount",
    "category_key",
    "currency",
    "description",
    "expense_date",
    "tenant_id",
  ],
};

const FUNCTION_ARGS: Record<string, Record<string, Field>> = {
  cancel_expense: {
    p_expense_id: required("string"),
    p_reason: required("string"),
  },
  create_expense: {
    p_amount: required("number"),
    p_branch_id: optional("string"),
    p_category_key: required("string"),
    p_description: required("string"),
    p_due_date: optional("string"),
    p_expense_date: required("string"),
    p_idempotency_key: optional("string"),
    p_initial_payment: optional("Json"),
    p_note: optional("string"),
    p_tenant_id: required("string"),
    p_vendor_name: optional("string"),
  },
  get_expense: {
    p_expense_id: required("string"),
    p_reference_date: optional("string"),
  },
  get_expense_overview: {
    p_branch_id: optional("string"),
    p_general_only: optional("boolean"),
    p_month: optional("string"),
    p_reference_date: optional("string"),
    p_tenant_id: required("string"),
  },
  list_expense_categories: { p_tenant_id: required("string") },
  list_expenses: {
    p_branch_id: optional("string"),
    p_category_key: optional("string"),
    p_cursor_date: optional("string"),
    p_cursor_id: optional("string"),
    p_from_date: optional("string"),
    p_general_only: optional("boolean"),
    p_include_cancelled: optional("boolean"),
    p_limit: optional("number"),
    p_overdue_only: optional("boolean"),
    p_reference_date: optional("string"),
    p_search: optional("string"),
    p_status: optional("string"),
    p_tenant_id: required("string"),
    p_to_date: optional("string"),
  },
  record_expense_payment: {
    p_amount: required("number"),
    p_expense_id: required("string"),
    p_idempotency_key: optional("string"),
    p_method: required("string"),
    p_note: optional("string"),
    p_paid_at: required("string"),
  },
  update_expense: {
    p_amount: required("number"),
    p_branch_id: optional("string"),
    p_category_key: required("string"),
    p_description: required("string"),
    p_due_date: optional("string"),
    p_expected_version: optional("number"),
    p_expense_date: required("string"),
    p_expense_id: required("string"),
    p_note: optional("string"),
    p_vendor_name: optional("string"),
  },
  void_expense_payment: {
    p_payment_id: required("string"),
    p_reason: required("string"),
  },
};

describe("F14 database.types.ts", () => {
  it.each(Object.entries(TABLE_ROWS))(
    "%s: Row, Insert and Update carry exactly the table's columns",
    (table, columns) => {
      const t = literalOf(propertyNamed(tables, table));
      const row = fields(literalOf(propertyNamed(t, "Row")));
      const insert = fields(literalOf(propertyNamed(t, "Insert")));
      const update = fields(literalOf(propertyNamed(t, "Update")));
      expect(
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.type])),
      ).toEqual(columns);
      expect(Object.values(row).every((f) => !f.optional)).toBe(true);
      expect(Object.keys(insert).sort()).toEqual(Object.keys(columns).sort());
      expect(Object.keys(update).sort()).toEqual(Object.keys(columns).sort());
      expect(Object.values(update).every((f) => f.optional)).toBe(true);
      const mustSupply = Object.entries(insert)
        .filter(([, f]) => !f.optional)
        .map(([k]) => k)
        .sort();
      expect(mustSupply).toEqual([...INSERT_REQUIRED[table]!].sort());
    },
  );

  it("the composite payment FK and the category FK are described", () => {
    const payments = literalOf(propertyNamed(tables, "expense_payments"));
    const text = propertyNamed(payments, "Relationships")!.getText();
    expect(text).toContain('foreignKeyName: "expense_payments_expense_fk"');
    expect(text).toContain('columns: ["expense_id", "tenant_id"]');
    expect(text).toContain('referencedColumns: ["id", "tenant_id"]');
    const expenses = literalOf(propertyNamed(tables, "expenses"));
    expect(propertyNamed(expenses, "Relationships")!.getText()).toContain(
      'referencedRelation: "expense_categories"',
    );
  });

  it.each(Object.entries(FUNCTION_ARGS))(
    "%s: exact argument names, types and optionality, returning Json",
    (name, expected) => {
      const fn = literalOf(propertyNamed(functions, name));
      expect(fields(literalOf(propertyNamed(fn, "Args")))).toEqual(expected);
      expect(propertyNamed(fn, "Returns")!.type!.getText()).toBe("Json");
    },
  );

  it("carries only the nine expense functions among the expense names (no private helper leaked into the public types)", () => {
    const names = functions.members
      .filter(ts.isPropertySignature)
      .map((m) => (m.name as ts.Identifier).text)
      .filter((n) => n.includes("expense"))
      .sort();
    expect(names).toEqual(Object.keys(FUNCTION_ARGS).sort());
  });

  it("the argument lists match the migration's own public wrapper signatures (names and defaults)", () => {
    const sql = readFileSync(
      path.join(
        root,
        "supabase/migrations/20261003090000_expense_obligations_and_settlements.sql",
      ),
      "utf8",
    );
    const wrappers = [
      ...sql.matchAll(
        /create function public\.(\w+)\(([\s\S]*?)\)\s*returns jsonb/g,
      ),
    ];
    expect(wrappers).toHaveLength(9);
    for (const [, name, list] of wrappers) {
      const parsed: Record<string, boolean> = {};
      for (const part of list!
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)) {
        const [argName] = part.split(/\s+/);
        parsed[argName!] = /\bdefault\b/i.test(part);
      }
      const expected = Object.fromEntries(
        Object.entries(FUNCTION_ARGS[name!]!).map(([k, f]) => [k, f.optional]),
      );
      expect(parsed, name).toEqual(expected);
    }
  });
});
