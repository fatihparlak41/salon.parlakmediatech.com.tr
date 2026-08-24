import { describe, expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import { testDb } from "./helpers";

/**
 * Standing regression guard for the Faz 1.5 grant-tightening work
 * (20260816090001-090008 — see supabase/migrations/README.md and the
 * Faz 1.5 report for the incident this closes: every table had shipped
 * with full anon/authenticated CRUD from Supabase's own project
 * bootstrap, applied directly to the named roles rather than via PUBLIC,
 * so every prior `revoke ... from public` had been silently ineffective).
 *
 * Extended in Faz 1.9 (20260817104813 + the corrective migration that
 * followed it) for the same class of bug found a second time, this time
 * on service_role: DEV's original bootstrap had also granted
 * service_role broad table DML and function EXECUTE directly, via a
 * `FOR ROLE postgres` default-privilege rule outside every migration —
 * invisible until a DEV<->PROD parity check compared live grants and
 * PROD (a fresh bootstrap) didn't have it. Confirmed functionally real,
 * not cosmetic, via `SET ROLE service_role` against PROD.
 *
 * First fix attempt gave service_role an explicit whitelist sized to
 * what tests/helpers.ts's fixture setup/teardown happened to need via
 * the service-role Data API — wrong layer: test-infrastructure
 * convenience was shaping the production grant surface. Corrected by
 * moving fixture setup/teardown (and this file's own audit-function
 * calls) to a direct Postgres connection (testDb, see helpers.ts) that
 * carries its own access, so service_role's actual grants can reflect
 * genuine application runtime need — currently zero, asserted directly
 * below rather than against a whitelist that would otherwise sit empty.
 *
 * This asserts the LIVE grant state — "exactly this, nothing more,
 * nothing less" — rather than "no worse than before". A future
 * migration that adds any grant to anon, leaves a PUBLIC execute grant
 * on a new function, or drifts authenticated's grants away from its
 * whitelist in EITHER direction (over-permissioned or accidentally
 * under-permissioned) fails one of these tests.
 *
 * Deliberately uses testDb (a direct Postgres connection, not any
 * PostgREST-mediated client): the security_audit_*() functions this
 * file calls exist purely for this kind of introspection — "list every
 * grant in the database" — which has no signed-in-user equivalent, and
 * calling them over a direct connection means the test suite needs zero
 * grants of its own to run it, matching the target grant model exactly.
 * Every other test file in this project must keep using a real user
 * session for its actual security assertions; this one is the
 * deliberate exception, same as before.
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
  // Phase 2A (20260819...). appointments/appointment_items are
  // deliberately SELECT-only — every mutation goes through the
  // create_appointment/reschedule_appointment/update_appointment_status
  // RPCs (20260819052733), never a direct grant.
  staff_members: ["INSERT", "SELECT", "UPDATE"],
  services: ["INSERT", "SELECT", "UPDATE"],
  staff_services: ["DELETE", "INSERT", "SELECT"],
  customers: ["INSERT", "SELECT", "UPDATE"],
  staff_schedules: ["INSERT", "SELECT", "UPDATE"],
  staff_schedule_exceptions: ["INSERT", "SELECT", "UPDATE"],
  appointments: ["SELECT"],
  appointment_items: ["SELECT"],
  // Phase 2A.1 (20260819062000) — replaces the old decorative
  // staff_members.branch_id/services.branch_id columns.
  staff_branches: ["DELETE", "INSERT", "SELECT"],
  service_branches: ["DELETE", "INSERT", "SELECT"],
};

// Functions `authenticated` is allowed to EXECUTE. Two groups: private.*
// helpers referenced directly inside an RLS USING/WITH CHECK clause
// (genuinely need the caller's own grant), and the client-facing
// public.* RPC surface. Everything else — wrapper-only private.*
// functions (their SECURITY DEFINER public.* wrapper is the only
// intended path, see 20260816090008), audit functions (now called via
// testDb, not any grant-bearing role), and trigger-only functions —
// must NOT appear here.
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
  // Phase 2A (20260819052733) — appointments/appointment_items have no
  // direct grant, these RPCs are the only mutation path.
  "public.create_appointment",
  "public.reschedule_appointment",
  "public.update_appointment_status",
  // Phase 2C (20260821120000) — evaluated as part of authenticated's own
  // INSERT/UPDATE on customers (phone_normalized/email_normalized are
  // GENERATED ALWAYS AS columns), so authenticated needs direct EXECUTE
  // the same way is_tenant_member/has_permission do for RLS.
  "private.normalize_phone",
  "private.normalize_email",
  // Phase 2C (20260821123000) — SECURITY DEFINER with its own explicit
  // has_permission() check; not SECURITY INVOKER (see that migration's
  // comment for why calling private.normalize_* ruled that out).
  "public.search_customers",
  // Phase 2D (20260822091500) — advisory read-only availability check,
  // SECURITY DEFINER with its own explicit has_permission() check (same
  // SECURITY INVOKER-cannot-call-private.* reasoning as search_customers
  // above). Authenticated only — no anon grant; Phase 2F's public
  // booking flow will need its own separate public-safe boundary.
  "public.check_appointment_availability",
  // Phase 2F (20260822150500/151000) — the public-safe boundary the
  // comment above anticipated. Granted to BOTH authenticated and anon
  // (see ANON_FUNCTION_WHITELIST below and the migration's own header
  // comment): Supabase Auth session storage is per-browser-origin, not
  // per-route, so a logged-in staff member opening /book/[tenantSlug] in
  // the same browser calls these as `authenticated`, not `anon`. These 3
  // are reads only — they never branch on caller identity or grant
  // anything extra to an authenticated caller, so this isn't a widened
  // surface, just a correct one for how the browser actually behaves.
  // The 4th Phase 2F member of this group, create_guest_booking, was
  // REMOVED from here in Phase 2F.2 (20260822170000) — see
  // BOOKING_GATEWAY_FUNCTION_WHITELIST below for where it lives now.
  "public.get_public_booking_context",
  "public.get_public_eligible_staff",
  "public.get_public_availability_slots",
  // Phase 2G.1 (20260822190000) — the customer-portal RPC surface.
  // Authenticated only, never anon: the portal requires a signed-in
  // session, every one of the 3 derives identity exclusively from
  // auth.uid() (see the migration's own header), and none has a
  // meaningful anonymous answer the way the Phase 2F read functions do.
  "public.get_my_account_profile",
  "public.update_my_account_profile",
  "public.get_my_appointments",
  // Faz 2G.2A (20260823201517) — the customer cancellation mutation.
  // Authenticated only: identity is auth.uid(), ownership re-derived via
  // customer_account_links inside the function itself.
  "public.cancel_my_appointment",
  // Faz 2G.2B (20260823205200) — customer reschedule mutation + its
  // advisory slot-preview read, same authenticated-only reasoning.
  "public.reschedule_my_appointment",
  "public.get_my_reschedule_slots",
  // Faz 2G.3.1 (20260824120000) — future-booking verified-claim
  // completion. Authenticated only: identity is auth.uid(), the claim
  // itself is an opaque secret hash, never an id.
  "public.claim_my_recent_booking",
];

// Phase 2F's public read surface — the only functions anon has ever
// been granted execute on in this project. Deliberately identical to
// the read-only entries in AUTHENTICATED_FUNCTION_WHITELIST above — see
// that list's comment for why the same 3 go to both roles.
// create_guest_booking (the mutation) was here through Phase 2F.1;
// Phase 2F.2 (20260822170000) revoked it from both anon and
// authenticated and granted it to booking_gateway alone instead — see
// BOOKING_GATEWAY_FUNCTION_WHITELIST.
const ANON_FUNCTION_WHITELIST = [
  "public.get_public_booking_context",
  "public.get_public_eligible_staff",
  "public.get_public_availability_slots",
];

// Phase 2F.2 (20260822170000) — the dedicated, least-privilege role
// behind the Next.js server-side booking gateway. Exactly one grant,
// ever: EXECUTE on the one mutation the direct-browser path used to
// have. No table grant of any kind (create_guest_booking is already
// SECURITY DEFINER and does all its own table access as its owner), no
// private.* grant, no membership in any other role.
const BOOKING_GATEWAY_FUNCTION_WHITELIST = ["public.create_guest_booking"];

// Expected output of security_audit_default_privileges() in a healthy
// environment: zero rows for anon/authenticated (any row for either
// means a future object would silently inherit access again), and
// exactly these 4 for service_role — MAINTAIN/REFERENCES/TRIGGER/
// TRUNCATE on tables, deliberately left alone because they're
// schema-maintenance privileges, not data access, and match PROD's own
// pre-existing default. Any SELECT/INSERT/UPDATE/DELETE/EXECUTE row
// appearing here means the default-privilege fix regressed.
const EXPECTED_DEFAULT_PRIVILEGES = [
  { for_role: "postgres", schema_name: "public", object_type: "r", grantee: "service_role", privilege_type: "MAINTAIN" },
  { for_role: "postgres", schema_name: "public", object_type: "r", grantee: "service_role", privilege_type: "REFERENCES" },
  { for_role: "postgres", schema_name: "public", object_type: "r", grantee: "service_role", privilege_type: "TRIGGER" },
  { for_role: "postgres", schema_name: "public", object_type: "r", grantee: "service_role", privilege_type: "TRUNCATE" },
];

type TableGrantRow = { schema_name: string; table_name: string; grantee: string; privilege_type: string };
type FunctionGrantRow = { schema_name: string; function_name: string; grantee: string; privilege_type: string };
type FunctionAuditRow = {
  schema_name: string;
  function_name: string;
  is_security_definer: boolean;
  search_path_setting: string;
};
type RlsStatusRow = { table_name: string; rls_enabled: boolean; policy_count: number };
type ColumnGrantRow = { table_name: string; column_name: string; grantee: string; privilege_type: string };
type DefaultPrivilegeRow = {
  for_role: string;
  schema_name: string;
  object_type: string;
  grantee: string;
  privilege_type: string;
};

describe("security grants regression", () => {
  it("anon has zero table grants", async () => {
    const data = await testDb<TableGrantRow[]>`select * from security_audit_table_grants()`;
    const anonGrants = data.filter((g) => g.grantee === "anon");
    expect(anonGrants).toEqual([]);
  });

  it("anon's function execute grants exactly match the whitelist", async () => {
    // Was a blind "zero grants" check through Phase 2E — Phase 2F is the
    // first phase to intentionally grant anon anything. Same
    // exactly-matches-the-whitelist pattern as authenticated's function
    // test below, not simply relaxed to "anything goes".
    const data = await testDb<FunctionGrantRow[]>`select * from security_audit_function_grants()`;
    const actual = new Set(data.filter((g) => g.grantee === "anon").map((g) => `${g.schema_name}.${g.function_name}`));

    for (const fn of ANON_FUNCTION_WHITELIST) {
      expect(actual.has(fn), `expected anon to have execute on ${fn}`).toBe(true);
      actual.delete(fn);
    }

    expect(Array.from(actual), "unexpected anon execute grants").toEqual([]);
  });

  it("(A) no migration/application-owned function retains a PUBLIC execute grant", async () => {
    // Scope, precisely: security_audit_function_grants() only ever reports
    // proowner = 'postgres' functions (20260819054527) — i.e. objects a
    // migration actually created and could have gotten wrong. It is NOT a
    // claim that zero PUBLIC-granted functions exist anywhere in the
    // database; btree_gist's own extension-installed functions are
    // deliberately out of scope here and checked separately by "(B)"
    // below, against an explicit allowlist, not silently excluded.
    const data = await testDb<FunctionGrantRow[]>`select * from security_audit_function_grants()`;
    const publicGrants = data.filter((g) => g.grantee === "PUBLIC");
    expect(publicGrants).toEqual([]);
  });

  it("(B) every extension-owned PUBLIC execute grant belongs to a known, allowlisted extension", async () => {
    // The explicit companion to (A): btree_gist (20260819052514, needed
    // for appointment_items_no_staff_overlap) installs ~150-188 GiST
    // support functions into public with PUBLIC execute granted by its
    // own install script — postgres does not own them and cannot revoke
    // (confirmed: ALTER/REVOKE both fail with 42501 must be owner of
    // function), and most take an `internal`-typed argument, which
    // Postgres refuses to accept from any SQL client regardless of grants
    // (confirmed: `ERROR 0A000: cannot accept a value of type internal`)
    // — see 20260819054527 and 20260819063500 for the full finding.
    //
    // This does not weaken the audit: an entirely different extension
    // being installed later, or a row whose extension_name isn't on this
    // allowlist, still fails here. It also isn't vacuous — the row-count
    // assertion below proves the query is actually finding the real,
    // known-large baseline, not silently returning nothing.
    const knownExtensions = ["btree_gist"];
    const data = await testDb<
      { schema_name: string; function_name: string; extension_name: string; grantee: string; privilege_type: string }[]
    >`select * from security_audit_extension_function_grants()`;

    const unknownExtension = data.filter((g) => !knownExtensions.includes(g.extension_name));
    expect(unknownExtension, "extension-owned grants from an extension not on the allowlist").toEqual([]);
    expect(data.length, "expected the known btree_gist baseline to be non-trivially large").toBeGreaterThan(50);
  });

  it("service_role has zero table grants beyond the schema-maintenance baseline", async () => {
    // MAINTAIN/REFERENCES/TRIGGER/TRUNCATE are PROD's own pre-existing
    // default for service_role (see EXPECTED_DEFAULT_PRIVILEGES above) —
    // schema-maintenance privileges, not data access. Everything else —
    // SELECT/INSERT/UPDATE/DELETE, on any table — must be absent: no
    // runtime caller exists for createAdminClient() today, and fixture
    // setup/teardown now goes through testDb, not service_role.
    const data = await testDb<TableGrantRow[]>`select * from security_audit_table_grants()`;
    const dmlGrants = data.filter(
      (g) => g.grantee === "service_role" && !["MAINTAIN", "REFERENCES", "TRIGGER", "TRUNCATE"].includes(g.privilege_type),
    );
    expect(dmlGrants).toEqual([]);
  });

  it("service_role has zero function execute grants", async () => {
    // Including the security_audit_*() functions this file itself
    // calls — they're reached through testDb (a direct Postgres
    // connection), not through service_role, specifically so this
    // suite needs no grant of its own to run.
    const data = await testDb<FunctionGrantRow[]>`select * from security_audit_function_grants()`;
    const serviceRoleGrants = data.filter((g) => g.grantee === "service_role");
    expect(serviceRoleGrants).toEqual([]);
  });

  it("authenticated's table grants exactly match the whitelist", async () => {
    const data = await testDb<TableGrantRow[]>`select * from security_audit_table_grants()`;

    const byTable = new Map<string, Set<string>>();
    for (const g of data.filter((row) => row.grantee === "authenticated")) {
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
    const data = await testDb<FunctionGrantRow[]>`select * from security_audit_function_grants()`;

    const actual = new Set(
      data.filter((g) => g.grantee === "authenticated").map((g) => `${g.schema_name}.${g.function_name}`),
    );

    for (const fn of AUTHENTICATED_FUNCTION_WHITELIST) {
      expect(actual.has(fn), `expected authenticated to have execute on ${fn}`).toBe(true);
      actual.delete(fn);
    }

    expect(Array.from(actual), "unexpected authenticated execute grants").toEqual([]);
  });

  describe("booking_gateway (Phase 2F.2)", () => {
    it("has exactly the required security properties — NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS/NOINHERIT/LOGIN", async () => {
      const rows = await testDb<
        { rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean; rolinherit: boolean }[]
      >`
        select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
        from pg_roles where rolname = 'booking_gateway'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false,
      });
    });

    it("belongs to no other role (no inherited membership to smuggle in extra privilege)", async () => {
      const rows = await testDb`
        select r.rolname from pg_auth_members m
        join pg_roles r on r.oid = m.roleid
        join pg_roles b on b.oid = m.member
        where b.rolname = 'booking_gateway'
      `;
      expect(rows).toEqual([]);
    });

    it("EFFECTIVE function EXECUTE surface is exactly BOOKING_GATEWAY_FUNCTION_WHITELIST — no more, no less, PUBLIC-inheritance included", async () => {
      // has_function_privilege reports the EFFECTIVE answer (direct
      // grant + role membership + PUBLIC-granted execute all folded
      // together), not a raw ACL row — the exact "not merely explicit
      // ACL rows" check Phase 2F.2 asked for. Scoped to public/private,
      // extension-owned functions excluded (same reasoning as the
      // anon/authenticated tests above): those are pre-existing,
      // catalogued separately by test (B), and not application-owned.
      const rows = await testDb<{ schema: string; name: string; args: string; can_execute: boolean }[]>`
        select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
               has_function_privilege('booking_gateway', p.oid, 'EXECUTE') as can_execute
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      `;
      const executable = rows.filter((r) => r.can_execute).map((r) => `${r.schema}.${r.name}`);
      expect(executable.sort()).toEqual([...BOOKING_GATEWAY_FUNCTION_WHITELIST].sort());

      const target = rows.find((r) => r.can_execute)!;
      // Faz 2G.3.1 (20260824120000) added an 11th trailing parameter,
      // p_claim_secret_hash — DROP+CREATE, reapplied to booking_gateway
      // fresh, same house rule as every prior signature change here.
      expect(target.args).toBe(
        "p_tenant_slug text, p_branch_id uuid, p_service_id uuid, p_scheduled_start_at timestamp with time zone, p_customer_full_name text, p_customer_phone text, p_staff_member_id uuid, p_customer_email text, p_idempotency_key uuid, p_customer_account_user_id uuid, p_claim_secret_hash text",
      );
    });

    it("EFFECTIVE table CRUD is zero on every public-schema table", async () => {
      const rows = await testDb<{ table_name: string; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }[]>`
        select c.relname as table_name,
               has_table_privilege('booking_gateway', c.oid, 'SELECT') as can_select,
               has_table_privilege('booking_gateway', c.oid, 'INSERT') as can_insert,
               has_table_privilege('booking_gateway', c.oid, 'UPDATE') as can_update,
               has_table_privilege('booking_gateway', c.oid, 'DELETE') as can_delete
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
      `;
      const withAnyAccess = rows.filter((r) => r.can_select || r.can_insert || r.can_update || r.can_delete);
      expect(withAnyAccess, "booking_gateway must have zero DML on every table — create_guest_booking is SECURITY DEFINER and does all table access as its own owner").toEqual([]);
    });
  });

  it("public.check_appointment_availability has exactly one callable overload, with the expected signature", async () => {
    // Phase 2D.1 (20260822120000) changed this function from 5 args to 6
    // (an added p_exclude_appointment_id with a default), via DROP +
    // CREATE rather than CREATE OR REPLACE — deliberately, since
    // CREATE OR REPLACE across a different argument list creates a
    // second, ambiguous overload instead of replacing the first.
    //
    // The whitelist test above only proves authenticated has execute on
    // *a* function named public.check_appointment_availability —
    // security_audit_function_grants() selects p.proname (the bare name)
    // and never the argument list, so if a stray second overload of this
    // name ever existed, its grant row would collapse into the exact
    // same Set key as the intended one and the whitelist test would
    // stay green either way. This queries pg_proc directly, keyed by
    // (name, argument signature), specifically to close that blind spot.
    const rows = await testDb<{ arg_types: string }[]>`
      select pg_get_function_identity_arguments(p.oid) as arg_types
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'check_appointment_availability'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.arg_types).toBe(
      "p_tenant_id uuid, p_branch_id uuid, p_staff_member_id uuid, p_service_id uuid, p_scheduled_start_at timestamp with time zone, p_exclude_appointment_id uuid",
    );
  });

  it("public.create_guest_booking has exactly one callable overload, with the expected signature", async () => {
    // Same blind spot as the check_appointment_availability test above,
    // for the function whose whole grant history changed in Phase
    // 2F.2/2G.1/2G.3.1 — a stray second overload here would be an
    // especially severe miss, since this is the one
    // anon-mutating-turned-gateway-only path. 11 args as of
    // 20260824120000 (p_claim_secret_hash added, DROP+CREATE — see that
    // migration's header).
    const rows = await testDb<{ arg_types: string }[]>`
      select pg_get_function_identity_arguments(p.oid) as arg_types
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'create_guest_booking'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.arg_types).toBe(
      "p_tenant_slug text, p_branch_id uuid, p_service_id uuid, p_scheduled_start_at timestamp with time zone, p_customer_full_name text, p_customer_phone text, p_staff_member_id uuid, p_customer_email text, p_idempotency_key uuid, p_customer_account_user_id uuid, p_claim_secret_hash text",
    );
  });

  it("every SECURITY DEFINER function pins search_path to empty", async () => {
    const data = await testDb<FunctionAuditRow[]>`select * from security_audit_functions()`;
    const unpinned = data
      .filter((f) => f.is_security_definer && f.search_path_setting !== `search_path=""`)
      .map((f) => `${f.schema_name}.${f.function_name}`);
    expect(unpinned).toEqual([]);
  });

  it("every public table has RLS enabled with at least one policy", async () => {
    const data = await testDb<RlsStatusRow[]>`select * from security_audit_rls_status()`;
    const problems = data.filter((r) => !r.rls_enabled || r.policy_count === 0).map((r) => r.table_name);
    expect(problems).toEqual([]);
  });

  it("the only column-level grant in the schema is tenant_memberships.status", async () => {
    // Table-level ACLs never surface column-restricted grants (Postgres
    // stores them separately on pg_attribute.attacl), so the whitelist
    // test above can't see this boundary — this is the actual security
    // check for the one place a narrower-than-table-level grant matters:
    // role_id must never become directly writable by widening this.
    const data = await testDb<ColumnGrantRow[]>`select * from security_audit_column_grants()`;

    const rows = data.map((r) => ({
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

  it("authenticated has no USAGE on the private schema at all", async () => {
    // The structural reason the functional checks below reject: private.*
    // functions some of which DO carry a specific EXECUTE grant to
    // authenticated (is_tenant_member, has_permission, ...) work ONLY
    // because an RLS policy's USING/WITH CHECK expression resolves the
    // schema-qualified name once at CREATE POLICY time (as postgres, which
    // has full access) and stores a function OID, not a name — evaluating
    // that stored policy later needs just EXECUTE on that OID, never a
    // fresh name resolution. An ad-hoc `select private.foo(...)` from an
    // authenticated session IS a fresh name resolution, which needs schema
    // USAGE — confirmed absent here. This is what makes "callable only
    // through the owning RLS policy or a SECURITY DEFINER public.* wrapper,
    // never as direct authenticated API surface" actually hold, for every
    // private.* function, not just the ones with zero grants.
    const [{ has_usage: privateUsage }] = await testDb<{ has_usage: boolean }[]>`
      select has_schema_privilege('authenticated', 'private', 'USAGE') as has_usage
    `;
    expect(privateUsage).toBe(false);
  });

  it("authenticated cannot directly invoke private.* appointment helper functions", async () => {
    // Phase 2A.1: catalog-level grants (asserted above) say authenticated
    // has zero EXECUTE on these five — this is the behavioral proof, an
    // actual role-switched call, not an inference from pg_proc.proacl. Runs
    // each call inside its own transaction with SET LOCAL ROLE, which
    // Postgres unwinds at transaction end regardless of outcome — no
    // explicit RESET ROLE needed, and nothing leaks back into testDb's
    // connection pool for a later test to inherit.
    const privateCalls: Record<string, (tx: TransactionSql) => Promise<unknown>> = {
      staff_is_available: (tx) =>
        tx`select private.staff_is_available(gen_random_uuid(), gen_random_uuid(), now(), now() + interval '30 minutes')`,
      validate_and_insert_appointment_item: (tx) =>
        tx`select private.validate_and_insert_appointment_item(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, 1)`,
      create_appointment: (tx) =>
        tx`select private.create_appointment(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '[]'::jsonb)`,
      reschedule_appointment: (tx) => tx`select private.reschedule_appointment(gen_random_uuid(), '[]'::jsonb)`,
      update_appointment_status: (tx) =>
        tx`select private.update_appointment_status(gen_random_uuid(), 'cancelled')`,
    };

    for (const [name, call] of Object.entries(privateCalls)) {
      await expect(
        testDb.begin(async (tx) => {
          await tx`set local role authenticated`;
          await call(tx);
        }),
        `authenticated should not be able to call private.${name} directly`,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("sanity: authenticated CAN directly invoke its whitelisted public.* wrappers (positive control)", async () => {
    // Proves the rejections above are genuinely about private.* access,
    // not a broken role-switch/harness — the exact same mechanism
    // (SET LOCAL ROLE authenticated inside a transaction) succeeds here
    // against a real whitelisted wrapper.
    await expect(
      testDb.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select public.has_permission(gen_random_uuid(), 'staff.view')`;
      }),
    ).resolves.not.toThrow();
  });

  it("no default privilege silently reopens anon/authenticated/service_role access for future objects", async () => {
    // The actual Faz 1.9 incident: DEV's original bootstrap had a
    // `FOR ROLE postgres` default outside every migration, so a
    // brand-new function/table would have silently inherited broad
    // access again even after 20260816090005/090006's explicit
    // per-object revokes. This is the only test in the file that
    // checks a *default* rather than a live grant — everything else
    // here would stay green right up until someone adds a new
    // function or table, at which point this is what catches it.
    const data = await testDb<DefaultPrivilegeRow[]>`select * from security_audit_default_privileges()`;

    const rows = [...data].sort((a, b) => a.privilege_type.localeCompare(b.privilege_type));

    expect(rows).toEqual(EXPECTED_DEFAULT_PRIVILEGES);
  });
});
