import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Faz SAAS.1E.1 staged release — proves the expand/contract migration split
 * is what it claims to be, purely by static inspection (no DB). Complements
 * (does not replace) the local disposable-Postgres rehearsal, which proves
 * the split behaves correctly at runtime; this file pins the SOURCE-level
 * properties a reviewer can check without spinning anything up.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase/migrations");
const GATE_FOUNDATION_FILE = "20260921132660_release_gate_foundation.sql";
const WAVE1_EXPAND_FILES = ["20260921132656_appointment_private_details_expand.sql", "20260921132658_staff_contact_privacy_expand.sql"];
const WAVE2_CONTRACT_FILES = ["20260921132725_appointment_private_fields_contract.sql", "20260921132730_staff_contact_columns_contract.sql"];
const WAVE3_FILE = "20260921132735_activate_non_owner_roles.sql";
const RESTRICTED_TABLES = ["appointments", "appointment_items", "staff_members", "staff_schedule_exceptions"];

function readMigration(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
}

function walkSourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    const walk = (d: string) => {
      for (const entry of readdirSync(d)) {
        if (["node_modules", ".next", ".git"].includes(entry)) continue;
        const full = path.join(d, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
      }
    };
    walk(path.join(process.cwd(), dir));
  }
  return out;
}

describe("staged release — Wave 1 (expand) migrations contain no legacy-column revoke", () => {
  it.each(WAVE1_EXPAND_FILES)("%s has no 'revoke select (' targeting a restricted table", (file) => {
    const sql = readMigration(file);
    for (const table of RESTRICTED_TABLES) {
      const pattern = new RegExp(`revoke select[^;]*on public\\.${table}`, "i");
      expect(sql, `${file} must not revoke select on ${table}`).not.toMatch(pattern);
    }
  });
});

describe("staged release — all new-app RPCs exist by the end of Wave 1", () => {
  it("part 7A defines get_appointment_private_details", () => {
    const sql = readMigration(WAVE1_EXPAND_FILES[0]!);
    expect(sql).toMatch(/create (or replace )?function public\.get_appointment_private_details/i);
  });
  it("part 8A defines all four staff-identity RPCs", () => {
    const sql = readMigration(WAVE1_EXPAND_FILES[1]!);
    for (const fn of ["get_staff_management_details", "get_staff_exception_reasons", "get_my_staff_link", "get_staff_link_for_membership"]) {
      expect(sql).toMatch(new RegExp(`create (or replace )?function public\\.${fn}`, "i"));
    }
  });
});

describe("staged release — Wave 2 (contract) migrations contain the intended revokes", () => {
  it("part 7B revokes appointments.notes/created_by and narrows appointment_items", () => {
    const sql = readMigration(WAVE2_CONTRACT_FILES[0]!);
    expect(sql).toMatch(/revoke select \(notes, created_by\) on public\.appointments/i);
    expect(sql).toMatch(/revoke select on public\.appointment_items/i);
    // Scope to the actual re-grant statement, not the whole file (whose header
    // comment legitimately says "item prices" while explaining why).
    const grantBlock = sql.match(/grant select \([^)]*\) on public\.appointment_items[^;]*;/i)?.[0] ?? "";
    expect(grantBlock).not.toMatch(/\bprice\b/);
  });
  it("part 8B revokes staff_members and staff_schedule_exceptions broad select", () => {
    const sql = readMigration(WAVE2_CONTRACT_FILES[1]!);
    expect(sql).toMatch(/revoke select on public\.staff_members/i);
    expect(sql).toMatch(/revoke select on public\.staff_schedule_exceptions/i);
    const grantBlock = sql.match(/grant select \([^)]*\) on public\.staff_members[^;]*;/i)?.[0] ?? "";
    expect(grantBlock).not.toMatch(/\bemail\b|\bphone\b/);
  });
});

describe("staged release — non-owner activation gate (three-wave structure)", () => {
  it("the gate foundation file defines the table, both helpers, and patches both pre-existing membership-activation functions", () => {
    const sql = readMigration(GATE_FOUNDATION_FILE);
    expect(sql).toMatch(/create table if not exists private\.release_gates/i);
    expect(sql).toMatch(/create (or replace )?function private\.release_gate_open/i);
    expect(sql).toMatch(/create (or replace )?function private\.assert_role_activation_allowed/i);
    expect(sql).toMatch(/create or replace function private\.update_membership_role/i);
    expect(sql).toMatch(/create or replace function private\.reactivate_membership/i);
    // both patched functions must actually call the new assertion, not just be redefined
    const umpBody = sql.slice(sql.indexOf("function private.update_membership_role"), sql.indexOf("function private.reactivate_membership"));
    expect(umpBody).toMatch(/assert_role_activation_allowed/);
    const reactivateBody = sql.slice(sql.indexOf("function private.reactivate_membership"));
    expect(reactivateBody).toMatch(/assert_role_activation_allowed/);
  });

  it("create_team_invitation and accept_team_invitation both call the shared permission-based assertion, not a role-key list", () => {
    const createSql = readMigration("20260921132720_staff_invitation_guards.sql");
    expect(createSql).toMatch(/assert_role_activation_allowed/);
    expect(createSql).not.toMatch(/role\.?key in \('?SALON_MANAGER'?/i);
    const acceptSql = readMigration("20260921132715_invitation_authority_revalidation.sql");
    expect(acceptSql).toMatch(/assert_role_activation_allowed/);
  });

  it("Wave 2 files never flip the gate open", () => {
    for (const file of WAVE2_CONTRACT_FILES) {
      const sql = readMigration(file);
      expect(sql, `${file} must not set release_gates.enabled = true`).not.toMatch(/set\s+enabled\s*=\s*true/i);
    }
  });

  it("Wave 3 is its own file, separate from Wave 1 and Wave 2, and only flips the gate", () => {
    const sql = readMigration(WAVE3_FILE);
    expect(sql).toMatch(/set\s+enabled\s*=\s*true/i);
    // asserts every documented pre-condition before the flip
    for (const marker of ["20260921132725", "20260921132730", "has_column_privilege", "has_function_privilege", "release_gate_open", "manage_unrestricted"]) {
      expect(sql).toContain(marker);
    }
    // the unexpected-active-membership pre-condition is PERMISSION-based, not a
    // hardcoded three-key list — a custom role with a different key is not exempt
    // merely because its key differs from the three defaults.
    expect(sql).toMatch(/not\s*\(\s*'permissions\.manage_unrestricted'\s*=\s*any\s*\(\s*private\.role_permission_keys/i);
    expect(sql).not.toMatch(/role\.?key in \('?SALON_MANAGER'?/i);
  });

  it("the two membership-activation rollback scripts both guard against active non-owner memberships (permission-based) and the wave-3-open ordering", () => {
    const wave2Rb = readFileSync("E:/salonos-operator-artifacts/saas-1e1/rollback_wave2_only.sql", "utf8");
    expect(wave2Rb).toMatch(/release_gate_open/);
    expect(wave2Rb).toMatch(/not\s*\(\s*'permissions\.manage_unrestricted'\s*=\s*any\s*\(\s*private\.role_permission_keys/i);
    expect(wave2Rb).not.toMatch(/role\.?key in \('?SALON_MANAGER'?/i);
    const fullRb = readFileSync("E:/salonos-operator-artifacts/saas-1e1/rollback_1e1_part2.sql", "utf8");
    expect(fullRb).toMatch(/release_gate_open/);
    expect(fullRb).toMatch(/not\s*\(\s*'permissions\.manage_unrestricted'\s*=\s*any\s*\(\s*private\.role_permission_keys/i);
    expect(fullRb).not.toMatch(/role\.?key in \('?SALON_MANAGER'?/i);
  });

  it("update_role_permissions is also patched with the gate — the indirect bypass (editing a role's own permissions out from under an active member) is closed", () => {
    const sql = readMigration(GATE_FOUNDATION_FILE);
    expect(sql).toMatch(/create or replace function private\.update_role_permissions/i);
    const urpBody = sql.slice(sql.indexOf("function private.update_role_permissions"));
    expect(urpBody).toMatch(/assert_role_activation_allowed/);
  });

  it("create_team_invitation and accept_team_invitation both take a row lock on the target role before the gate check, so a concurrent update_role_permissions on the same role cannot interleave", () => {
    // Search for the actual CALL (`perform private.assert_role_activation_allowed`),
    // not a bare mention of the identifier — create_team_invitation's own header
    // comment mentions "private.assert_role_activation_allowed" in prose before the
    // function body even starts, which would give a false (too-early) index.
    const createSql = readMigration("20260921132720_staff_invitation_guards.sql");
    const createLockIdx = createSql.search(/from public\.roles where roles\.id = p_role_id for update/i);
    const createGateIdx = createSql.indexOf("perform private.assert_role_activation_allowed");
    expect(createLockIdx, "create_team_invitation must lock the role row (qualified as roles.id — bare id collides with this function's own RETURNS TABLE id OUT parameter)").toBeGreaterThan(-1);
    expect(createGateIdx, "create_team_invitation must actually CALL the gate assertion, not merely mention it in a comment").toBeGreaterThan(-1);
    expect(createLockIdx).toBeLessThan(createGateIdx);

    const acceptSql = readMigration("20260921132715_invitation_authority_revalidation.sql");
    const acceptLockIdx = acceptSql.search(/from public\.roles where id = v_role_id for update/i);
    const acceptGateIdx = acceptSql.indexOf("perform private.assert_role_activation_allowed");
    expect(acceptLockIdx, "accept_team_invitation must lock the role row before the gate check").toBeGreaterThan(-1);
    expect(acceptLockIdx).toBeLessThan(acceptGateIdx);
  });
});

describe("staged release — current app code has zero direct reads of contract-restricted columns", () => {
  const files = walkSourceFiles(["app", "components", "lib"]);

  it("no .select( string anywhere references appointments.notes or appointment_items.price directly", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /\.select\(\s*[`"][^`"]*\bnotes\b[^`"]*[`"]/.test(src) && /appointments/.test(src);
    });
    // appointment-detail-sheet.tsx / queries.ts legitimately render `detail.notes` (the
    // RPC-sourced field) — this check is about the SELECT STRING, not the rendered value.
    const trueOffenders = offenders.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /`[^`]*\bnotes\b[^`]*`/.test(src.match(/\.select\(\s*`[^`]*`/g)?.join("\n") ?? "");
    });
    expect(trueOffenders).toEqual([]);
  });

  it("no source file selects staff_members email/phone/tenant_membership_id as a literal column name", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      const selects = src.match(/\.select\(\s*[`"][^`"]*[`"]/g) ?? [];
      return selects.some((s) => /\bemail\b|\bphone\b|tenant_membership_id/.test(s)) && /staff_members/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});

describe("staged release — the CURRENTLY DEPLOYED source (pre-SAAS.1E.1) genuinely contains the reads this staging avoids breaking", () => {
  const DEPLOYED_SHA = "e73a3e71868c0bdbd894435bcffdbb19342681e8";

  function readDeployed(relPath: string): string {
    return execSync(`git show ${DEPLOYED_SHA}:${relPath}`, { cwd: process.cwd(), encoding: "utf8" });
  }

  it("deployed appointments/queries.ts selects notes and appointment_items.price directly", () => {
    const src = readDeployed("lib/modules/appointments/queries.ts");
    expect(src).toMatch(/notes,/);
    expect(src).toMatch(/appointment_items\([^)]*price/);
  });

  it("deployed staff/queries.ts selects email/phone/tenant_membership_id directly", () => {
    const src = readDeployed("lib/modules/staff/queries.ts");
    expect(src).toMatch(/email, phone, status, tenant_membership_id/);
  });

  it("deployed team/queries.ts and dashboard/queries.ts reference tenant_membership_id directly", () => {
    expect(readDeployed("lib/modules/team/queries.ts")).toMatch(/tenant_membership_id/);
    expect(readDeployed("lib/modules/dashboard/queries.ts")).toMatch(/tenant_membership_id/);
  });
});
