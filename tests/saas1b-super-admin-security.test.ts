import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Faz SAAS.1B — source-level security rules of the Super Admin console. IDs SEC. They read the code, not a database: the properties that
 * must hold however the functions are called (no service-role client in the admin area, no write path, only the four read functions, the
 * guard in every function, no customer data in the migration). The runtime behaviour of the same rules is tests/saas1b-super-admin.test.ts.
 */

const ROOT = process.cwd();
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, "/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Source with comments removed (block comments, and line comments that start a line or follow whitespace, so "https://" survives). */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const ADMIN_FILES = [
  ...walk(path.join(ROOT, "app/[locale]/super-admin")),
  ...walk(path.join(ROOT, "components/super-admin")),
  ...walk(path.join(ROOT, "lib/modules/platform")),
];
const MIGRATION = readFileSync(path.join(ROOT, "supabase/migrations/20261102090000_super_admin_read_model.sql"), "utf8").replace(/\r/g, "");
/** the SQL with every comment removed, so a rule cannot be satisfied (or violated) by prose */
const SQL = MIGRATION.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const ADMIN_FUNCTIONS = ["admin_dashboard_summary", "admin_list_tenants", "admin_tenant_detail", "admin_tenant_audit"];

describe("SEC the admin area never holds privilege", () => {
  it("SEC1 the admin area is not empty (the scan really covers the feature)", () => {
    const names = ADMIN_FILES.map(rel);
    expect(names).toEqual(expect.arrayContaining(["app/[locale]/super-admin/page.tsx", "app/[locale]/super-admin/layout.tsx", "app/[locale]/super-admin/salons/page.tsx", "app/[locale]/super-admin/salons/[tenantId]/page.tsx", "lib/modules/platform/admin.ts", "components/super-admin/copy-button.tsx"]));
  });

  it("SEC2 no file in the admin area touches the service-role client, its key, or a server-only secret", () => {
    for (const file of ADMIN_FILES) {
      const src = code(file);
      expect(src, rel(file)).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|createAdminClient|lib\/supabase\/admin|service_role/);
      expect(src, rel(file)).not.toMatch(/process\.env\.(?!NEXT_PUBLIC_)/);
    }
  });

  it("SEC3 the service-role client stays where it was: the admin area did not add a user to the (existing, short) list", () => {
    const users = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib")), ...walk(path.join(ROOT, "components"))]
      .filter((f) => /SUPABASE_SERVICE_ROLE_KEY|createAdminClient/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(users.filter((f) => f.includes("super-admin") || f.startsWith("lib/modules/platform") || f.startsWith("components/super-admin"))).toEqual([]);
    expect(users.length).toBeLessThanOrEqual(10);
  });

  it("SEC4 the admin area is READ-ONLY: no server action, no table access, no insert/update/delete/upsert", () => {
    for (const file of ADMIN_FILES) {
      const src = code(file);
      expect(src, rel(file)).not.toMatch(/["']use server["']/);
      expect(src, rel(file)).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
      expect(src, rel(file)).not.toMatch(/\.from\s*\(/);
      expect(src, rel(file)).not.toMatch(/\bformAction\b|action=\{/);
    }
  });

  it("SEC5 the only database calls are the four admin functions", () => {
    const called = new Set<string>();
    for (const file of ADMIN_FILES) {
      for (const m of readFileSync(file, "utf8").matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)) called.add(m[1]!);
    }
    expect([...called].sort()).toEqual([...ADMIN_FUNCTIONS].sort());
  });

  it("SEC6 the old status-flipping action is gone and nothing defines or imports it", () => {
    for (const file of [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib")), ...walk(path.join(ROOT, "components"))]) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(/updateTenantStatusAction/);
    }
    expect(() => readFileSync(path.join(ROOT, "lib/modules/platform/actions.ts"))).toThrow();
  });

  it("SEC7 the only form in the admin area is the GET search form; the one client component handles no data and calls nothing", () => {
    const forms: string[] = [];
    for (const file of ADMIN_FILES) {
      for (const m of readFileSync(file, "utf8").matchAll(/<form\b[^>]*>/g)) forms.push(`${rel(file)} ${m[0]}`);
    }
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('method="get"');
    const clientFiles = ADMIN_FILES.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(clientFiles.map(rel)).toEqual(["components/super-admin/copy-button.tsx"]);
    const client = readFileSync(clientFiles[0]!, "utf8");
    expect(client).not.toMatch(/supabase|fetch\(|rpc\(|XMLHttpRequest/i);
  });

  it("SEC8 no impersonation or account-takeover surface: nothing in the admin area signs in, signs out, sets a session, or sends mail", () => {
    for (const file of ADMIN_FILES) {
      expect(code(file), rel(file)).not.toMatch(/\bsignInWith\w*|\bsignOut\b|\bsetSession\b|\bauth\.(admin|signIn|updateUser|resetPassword)|generateLink|inviteUserByEmail|resetPasswordForEmail|sendMail|impersonat/i);
    }
  });

  it("SEC9 the route is protected by the layout, and the layout asks BEFORE rendering the children", () => {
    const layout = readFileSync(path.join(ROOT, "app/[locale]/super-admin/layout.tsx"), "utf8");
    expect(layout).toMatch(/await requirePlatformAdmin\(\)/);
    expect(layout.indexOf("await requirePlatformAdmin()")).toBeLessThan(layout.indexOf("{children}"));
    // every page of the feature lives UNDER that layout (no sibling route such as app/[locale]/admin that would skip it)
    const pages = walk(path.join(ROOT, "app")).filter((f) => /page\.tsx$/.test(f) && /super-admin/i.test(rel(f))).map(rel);
    for (const page of pages) expect(page.startsWith("app/[locale]/super-admin/"), page).toBe(true);
  });
});

describe("SEC the migration", () => {
  const FUNCTION_HEADERS = [...SQL.matchAll(/create or replace function ([a-z_.]+)\(([\s\S]*?)\$(?:function)?\$/g)];

  it("SEC10 exactly ten functions (six private, four public) are defined, and every one is SECURITY DEFINER with an empty search_path", () => {
    const names = [...SQL.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(
      [
        "private.admin_require", "private.admin_tenant_rows", "private.admin_dashboard_summary", "private.admin_list_tenants", "private.admin_tenant_detail", "private.admin_tenant_audit",
        ...ADMIN_FUNCTIONS.map((n) => `public.${n}`),
      ].sort(),
    );
    expect(FUNCTION_HEADERS.length).toBe(10);
    for (const header of FUNCTION_HEADERS) {
      expect(header[0], header[1]).toMatch(/security definer/);
      expect(header[0], header[1]).toMatch(/set search_path = ''/);
      expect(header[0], header[1]).toMatch(/\bstable\b/);
    }
  });

  it("SEC11 every private function starts by calling the guard, and the guard is only an authentication check plus is_platform_admin()", () => {
    expect((SQL.match(/perform private\.admin_require\(\);/g) ?? []).length).toBe(5); // rows, dashboard, list, detail, audit
    const guard = /create or replace function private\.admin_require\(\)[\s\S]*?\$function\$;/.exec(SQL)![0];
    expect(guard).toContain("auth.uid() is null");
    expect(guard).toContain("not private.is_platform_admin()");
    expect(guard).not.toMatch(/raw_user_meta_data|raw_app_meta_data|app_metadata|user_metadata|email|jwt/i);
    for (const name of ["private.admin_tenant_rows", "private.admin_dashboard_summary", "private.admin_list_tenants", "private.admin_tenant_detail", "private.admin_tenant_audit"]) {
      const body = new RegExp(`create or replace function ${name.replace(".", "\\.")}\\([\\s\\S]*?begin\\s+perform private\\.admin_require\\(\\);`).test(SQL);
      expect(body, name).toBe(true);
    }
  });

  it("SEC12 the platform identity is the existing platform_admins row, never user-editable metadata and never an e-mail constant", () => {
    expect(SQL).not.toMatch(/raw_user_meta_data|raw_app_meta_data|app_metadata|user_metadata/);
    expect(SQL).not.toMatch(/'[^']*@[^']*'/); // no e-mail literal anywhere
    expect(SQL).toContain("private.is_platform_admin()");
    expect(SQL).not.toMatch(/\bplatform_admins\b/); // it reaches the table ONLY through the existing predicate
  });

  it("SEC13 the migration writes nothing and creates no table, column or policy", () => {
    expect(SQL).not.toMatch(/^\s*(insert\s+into|update\s+[a-z_.]+\s+set|delete\s+from|truncate|alter\s+table|create\s+table|create\s+policy|drop\s+|create\s+index|create\s+trigger)/im);
    expect(SQL).not.toMatch(/\b(insert\s+into|delete\s+from)\b/i);
  });

  it("SEC14 grants: revoked from every API role first; only the four public wrappers are granted, to authenticated only", () => {
    expect((SQL.match(/revoke all on function/g) ?? []).length).toBe(10);
    const grants = [...SQL.matchAll(/grant execute on function ([a-z_.]+)\(/g)].map((m) => m[1]);
    expect(grants.sort()).toEqual(ADMIN_FUNCTIONS.map((n) => `public.${n}`).sort());
    expect(SQL).not.toMatch(/grant [^;]*\bto\b[^;]*\b(anon|public|service_role)\b/i);
    for (const stmt of SQL.match(/grant execute[^;]*;/g) ?? []) expect(stmt).toMatch(/to authenticated;$/);
    for (const stmt of SQL.match(/revoke all on function[^;]*;/g) ?? []) expect(stmt).toMatch(/from public, anon, authenticated, service_role;$/);
  });

  it("SEC15 no customer personal data, no appointment content, no finance, no audit payload can be selected", () => {
    expect(SQL).not.toMatch(/\bc\.(full_name|phone|email|notes|phone_normalized|email_normalized|status|id)\b/); // customers: tenant_id and deleted_at only
    expect(SQL).not.toMatch(/\ba\.(notes|customer_id|idempotency_key|source|created_by)\b/);
    expect(SQL).not.toMatch(/\bl\.(before|after|ip_address|user_agent|actor_user_id|entity_id)\b/);
    expect(SQL).not.toMatch(/\b(payments?|expenses?|checkout|sales?|treatment_notes|appointment_items)\b/i);
    expect(SQL).not.toMatch(/\bcustomers\b[^;]*\b(select|returning)\b[^;]*\b(full_name|phone|email)\b/i);
    // the customers table is only ever COUNTED
    const customerCte = /customer_c as \([\s\S]*?\),\s*appointment_c/.exec(SQL)![0];
    expect(customerCte).toContain("count(*)");
    expect(customerCte).not.toMatch(/full_name|phone|email|notes/);
  });

  it("SEC16 the only person data returned is the Owner's contact and member names/roles: profiles and auth.users are read for a handful of columns", () => {
    const profileCols = new Set([...SQL.matchAll(/\bpr\.([a-z_]+)/g)].map((m) => m[1]));
    expect([...profileCols].sort()).toEqual(["full_name", "id", "phone"]);
    const userCols = new Set([...SQL.matchAll(/\bu\.([a-z_]+)/g)].map((m) => m[1]));
    expect([...userCols].sort()).toEqual(["email", "id", "last_sign_in_at"]);
    expect(SQL).not.toMatch(/encrypted_password|raw_user_meta_data|banned_until|confirmation_token|recovery_token|phone_confirmed/);
  });

  it("SEC17 readiness is the ONE canonical definition: the migration calls private.onboarding_status and reimplements none of its checks", () => {
    expect(SQL).toContain("private.onboarding_status(t.id)");
    expect(SQL).not.toMatch(/pg_timezone_names|staff_is_available|service_branches|staff_branches|staff_schedules|staff_services/);
    expect(SQL).not.toMatch(/tstzrange|generate_series|staff_is_available|slot/i);
  });

  it("SEC18 inputs are validated against fixed lists; the search term is matched with position(), never with a pattern or dynamic SQL", () => {
    expect(SQL).toContain("raise exception 'invalid filter'");
    expect(SQL).toContain("raise exception 'invalid sort'");
    expect(SQL).toMatch(/position\(v_q in lower\(r\.name\)\)/);
    // dynamic SQL (EXECUTE <string>, format()) is absent ("grant execute on function" is not dynamic SQL), ILIKE is absent, and LIKE never
    // takes an input (the one use, e like 'critical:%', compares the function's own internal signal codes)
    expect(SQL).not.toMatch(/\bexecute\s+(?!on\s+function)|\bformat\(|\bilike\b|\blike\s+(v_|p_)|\|\|\s*v_q|\|\|\s*p_search/i);
    expect([...SQL.matchAll(/\blike\s+'([^']*)'/gi)].map((m) => m[1]!).every((p) => /^(critical|warning|info):%$/.test(p))).toBe(true);
    expect(SQL).toMatch(/least\(greatest\(coalesce\(p_limit, 25\), 1\), 100\)/);
  });
});
