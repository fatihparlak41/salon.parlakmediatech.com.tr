import { describe, expect, it } from "vitest";
import { admin } from "./helpers";

/**
 * Standing regression guard for the Faz 1.5 grant-tightening work
 * (20260816090001-090008 — see supabase/migrations/README.md and the
 * Faz 1.5 report for the incident this closes: every table had shipped
 * with full anon/authenticated CRUD from Supabase's own project
 * bootstrap, applied directly to the named roles rather than via PUBLIC,
 * so every prior `revoke ... from public` had been silently ineffective).
 *
 * This asserts the LIVE grant state against an explicit whitelist —
 * "exactly this, nothing more, nothing less" — rather than "no worse
 * than before". A future migration that adds any grant to anon, leaves
 * a PUBLIC execute grant on a new function, or drifts authenticated's
 * grants away from this list in EITHER direction (over-permissioned or
 * accidentally under-permissioned) fails one of these tests.
 *
 * Deliberately uses the admin/service-role client, not a signed-in
 * user's: the security_audit_*() functions this file calls are
 * service_role-only diagnostics (see 20260816090005), not a behavioral
 * RLS check — there is no signed-in-user equivalent for "list every
 * grant in the database". Every other test file in this project must
 * keep using a real user session; this one is the deliberate exception.
 */

const AUTHENTICATED_TABLE_WHITELIST: Record<string, string[]> = {
  tenants: ["SELECT", "UPDATE"],
  profiles: ["SELECT", "UPDATE"],
  branches: ["INSERT", "SELECT", "UPDATE"],
  permissions: ["SELECT"],
  role_templates: ["SELECT"],
  role_template_permissions: ["SELECT"],
  roles: ["SELECT", "UPDATE"],
  role_permissions: ["SELECT"],
  // No table-level UPDATE: `status` is writable only via a column-level
  // grant (20260816090002/090006), asserted separately below by the
  // "only column-level grant" test. Postgres never folds a column-level
  // ACL into the table-level one, so it correctly does not appear here.
  tenant_memberships: ["INSERT", "SELECT"],
  platform_admins: ["INSERT", "SELECT", "UPDATE"],
  plans: ["INSERT", "SELECT", "UPDATE"],
  features: ["INSERT", "SELECT", "UPDATE"],
  plan_features: ["DELETE", "INSERT", "SELECT"],
  subscriptions: ["SELECT"],
  tenant_features: ["SELECT"],
  audit_logs: ["SELECT"],
};

// Functions `authenticated` is allowed to EXECUTE. Two groups: private.*
// helpers referenced directly inside an RLS USING/WITH CHECK clause
// (genuinely need the caller's own grant), and the client-facing
// public.* RPC surface. Everything else — wrapper-only private.*
// functions (their SECURITY DEFINER public.* wrapper is the only
// intended path, see 20260816090008), service_role-only audit
// functions, and trigger-only functions — must NOT appear here.
const AUTHENTICATED_FUNCTION_WHITELIST = [
  "private.current_tenant_ids",
  "private.is_tenant_member",
  "private.has_permission",
  "private.is_platform_admin",
  "private.is_platform_owner",
  "public.create_tenant",
  "public.create_role",
  "public.update_role_permissions",
  "public.update_membership_role",
  "public.has_permission",
  "public.has_feature",
  "public.is_platform_admin",
];

describe("security grants regression", () => {
  it("anon has zero table grants", async () => {
    const { data, error } = await admin.rpc("security_audit_table_grants");
    expect(error).toBeNull();
    const anonGrants = (data ?? []).filter((g) => g.grantee === "anon");
    expect(anonGrants).toEqual([]);
  });

  it("anon has zero function execute grants", async () => {
    const { data, error } = await admin.rpc("security_audit_function_grants");
    expect(error).toBeNull();
    const anonGrants = (data ?? []).filter((g) => g.grantee === "anon");
    expect(anonGrants).toEqual([]);
  });

  it("no function retains a PUBLIC execute grant", async () => {
    const { data, error } = await admin.rpc("security_audit_function_grants");
    expect(error).toBeNull();
    const publicGrants = (data ?? []).filter((g) => g.grantee === "PUBLIC");
    expect(publicGrants).toEqual([]);
  });

  it("authenticated's table grants exactly match the whitelist", async () => {
    const { data, error } = await admin.rpc("security_audit_table_grants");
    expect(error).toBeNull();

    const byTable = new Map<string, Set<string>>();
    for (const g of (data ?? []).filter((row) => row.grantee === "authenticated")) {
      if (!byTable.has(g.table_name)) byTable.set(g.table_name, new Set());
      byTable.get(g.table_name)!.add(g.privilege_type);
    }

    for (const [table, privileges] of Object.entries(AUTHENTICATED_TABLE_WHITELIST)) {
      const actual = Array.from(byTable.get(table) ?? []).sort();
      expect(actual, `authenticated grants on "${table}"`).toEqual([...privileges].sort());
      byTable.delete(table);
    }

    // Anything left over is a table with an authenticated grant this
    // whitelist doesn't account for: a new table shipped without
    // updating this test, or an unintended grant.
    expect(Array.from(byTable.keys()), "unexpected tables with authenticated grants").toEqual([]);
  });

  it("authenticated's function execute grants exactly match the whitelist", async () => {
    const { data, error } = await admin.rpc("security_audit_function_grants");
    expect(error).toBeNull();

    const actual = new Set(
      (data ?? [])
        .filter((g) => g.grantee === "authenticated")
        .map((g) => `${g.schema_name}.${g.function_name}`),
    );

    for (const fn of AUTHENTICATED_FUNCTION_WHITELIST) {
      expect(actual.has(fn), `expected authenticated to have execute on ${fn}`).toBe(true);
      actual.delete(fn);
    }

    expect(Array.from(actual), "unexpected authenticated execute grants").toEqual([]);
  });

  it("every SECURITY DEFINER function pins search_path to empty", async () => {
    const { data, error } = await admin.rpc("security_audit_functions");
    expect(error).toBeNull();
    const unpinned = (data ?? [])
      .filter((f) => f.is_security_definer && f.search_path_setting !== `search_path=""`)
      .map((f) => `${f.schema_name}.${f.function_name}`);
    expect(unpinned).toEqual([]);
  });

  it("every public table has RLS enabled with at least one policy", async () => {
    const { data, error } = await admin.rpc("security_audit_rls_status");
    expect(error).toBeNull();
    const problems = (data ?? [])
      .filter((r) => !r.rls_enabled || r.policy_count === 0)
      .map((r) => r.table_name);
    expect(problems).toEqual([]);
  });

  it("the only column-level grant in the schema is tenant_memberships.status", async () => {
    // Table-level ACLs never surface column-restricted grants (Postgres
    // stores them separately on pg_attribute.attacl), so the whitelist
    // test above can't see this boundary — this is the actual security
    // check for the one place a narrower-than-table-level grant matters:
    // role_id must never become directly writable by widening this.
    const { data, error } = await admin.rpc("security_audit_column_grants");
    expect(error).toBeNull();

    const rows = (data ?? []).map((r) => ({
      table: r.table_name,
      column: r.column_name,
      grantee: r.grantee,
      privilege: r.privilege_type,
    }));

    expect(rows).toEqual([
      {
        table: "tenant_memberships",
        column: "status",
        grantee: "authenticated",
        privilege: "UPDATE",
      },
    ]);
  });
});
