import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * SEC.1A - the Server Action boundary must not reopen.
 *
 * A module whose FIRST statement is "use server" turns EVERY export into a public HTTP endpoint (a POST with a Next-Action header reaches it with
 * caller-controlled arguments, anonymously unless the proxy or the body says otherwise). Before SEC.1A, lib/modules/team/actions.ts exported
 * createTeamInvitationCore / resendTeamInvitationCore / revokeTeamInvitationCore, which take a caller-supplied Supabase client, a user id and an injectable
 * mailer. This file pins the boundary statically (no database, no server needed):
 *   S1  every export of a "use server" module is an async function whose name ends in "Action" (no constants, no sync helpers, no classes);
 *   S2  none of those functions takes an injectable dependency: a client, an admin client, a user id, a mailer, a sql handle, a deps bag;
 *   S3  the exact set of exported actions equals the reviewed snapshot below, so a NEW entry point is a deliberate, reviewed change;
 *   S4  the orchestration module has no "use server" directive, and is only imported by the three wrappers and by tests;
 *   S5  when a production build is present, its server-reference manifest agrees with S3 and carries none of the three old helper names.
 */
const ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

type Surface = { file: string; name: string; isAsyncFunction: boolean; params: string[] };

function fileLevelUseServer(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);
}

function collectSurface(): Surface[] {
  const out: Surface[] = [];
  for (const dir of ["lib", "app", "components"]) {
    for (const f of walk(path.join(ROOT, dir))) {
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
      if (!fileLevelUseServer(sf)) continue;
      const rel = path.relative(ROOT, f).split(path.sep).join("/");
      for (const st of sf.statements) {
        const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
        if (!exported) continue;
        if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue; // erased at build time
        if (ts.isExportDeclaration(st) && st.isTypeOnly) continue; // `export type { ... }` is erased too
        if (ts.isFunctionDeclaration(st)) {
          out.push({
            file: rel,
            name: st.name?.text ?? "(anonymous)",
            isAsyncFunction: hasModifier(st, ts.SyntaxKind.AsyncKeyword),
            params: st.parameters.map((p) => p.name.getText(sf)),
          });
        } else if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) out.push({ file: rel, name: `${d.name.getText(sf)} (variable)`, isAsyncFunction: false, params: [] });
        } else {
          out.push({ file: rel, name: `(${ts.SyntaxKind[st.kind]})`, isAsyncFunction: false, params: [] });
        }
      }
    }
  }
  return out;
}

/** The reviewed surface (SEC.1A, 71 entry points). Adding or removing a Server Action means editing this list on purpose. */
const REVIEWED_SURFACE = [
  "lib/modules/appointments/actions.ts::completeAppointmentAction",
  "lib/modules/appointments/actions.ts::createAppointmentAction",
  "lib/modules/appointments/actions.ts::rescheduleAppointmentAction",
  "lib/modules/appointments/actions.ts::updateAppointmentStatusAction",
  "lib/modules/auth/actions.ts::confirmEmailAction",
  "lib/modules/auth/actions.ts::requestPasswordRecoveryAction",
  "lib/modules/auth/actions.ts::resendConfirmationAction",
  "lib/modules/auth/actions.ts::resetPasswordAction",
  "lib/modules/auth/actions.ts::signInAction",
  "lib/modules/auth/actions.ts::signOutAction",
  "lib/modules/auth/actions.ts::signUpAction",
  "lib/modules/branches/actions.ts::updateBranchContactAction",
  "lib/modules/commission/actions.ts::setCommissionRuleAction",
  "lib/modules/customer-account/actions.ts::cancelMyAppointmentAction",
  "lib/modules/customer-account/actions.ts::claimMyRecentBookingAction",
  "lib/modules/customer-account/actions.ts::createMyLinkCodeAction",
  "lib/modules/customer-account/actions.ts::requestAccountMagicLinkAction",
  "lib/modules/customer-account/actions.ts::rescheduleMyAppointmentAction",
  "lib/modules/customer-account/actions.ts::updateMyAccountProfileAction",
  "lib/modules/customers/actions.ts::createCustomerAction",
  "lib/modules/customers/actions.ts::linkCustomerAccountAction",
  "lib/modules/customers/actions.ts::unlinkCustomerAccountAction",
  "lib/modules/customers/actions.ts::updateCustomerProfileAction",
  "lib/modules/customers/actions.ts::updateCustomerStatusAction",
  "lib/modules/customers/import-actions.ts::commitCustomerImportAction",
  "lib/modules/customers/import-actions.ts::previewCustomerImportAction",
  "lib/modules/expenses/actions.ts::cancelExpenseAction",
  "lib/modules/expenses/actions.ts::createExpenseAction",
  "lib/modules/expenses/actions.ts::recordExpensePaymentAction",
  "lib/modules/expenses/actions.ts::updateExpenseAction",
  "lib/modules/expenses/actions.ts::voidExpensePaymentAction",
  "lib/modules/export/actions.ts::prepareTenantExportAction",
  "lib/modules/finance/actions.ts::getOrCreateAppointmentSaleAction",
  "lib/modules/finance/actions.ts::recordAppointmentPaymentAction",
  "lib/modules/finance/actions.ts::updateAppointmentSalePricingAction",
  "lib/modules/finance/actions.ts::voidAppointmentPaymentAction",
  "lib/modules/onboarding/actions.ts::addServicesAction",
  "lib/modules/onboarding/actions.ts::addStaffAction",
  "lib/modules/onboarding/actions.ts::applyWeeklyHoursAction",
  "lib/modules/onboarding/actions.ts::saveSalonProfileAction",
  "lib/modules/onboarding/actions.ts::setStaffServicesAction",
  "lib/modules/public-booking/actions.ts::submitGuestBookingAction",
  "lib/modules/services/actions.ts::createServiceAction",
  "lib/modules/services/actions.ts::setServiceCalendarDurationAction",
  "lib/modules/services/actions.ts::updateServiceBranchesAction",
  "lib/modules/services/actions.ts::updateServiceProfileAction",
  "lib/modules/services/actions.ts::updateServiceStaffAction",
  "lib/modules/services/actions.ts::updateServiceStatusAction",
  "lib/modules/settings/actions.ts::removePushSubscriptionAction",
  "lib/modules/settings/actions.ts::savePushSubscriptionAction",
  "lib/modules/settings/actions.ts::sendTestPushNotificationAction",
  "lib/modules/settings/actions.ts::updateCustomerNotificationSettingAction",
  "lib/modules/settings/actions.ts::updateMyNotificationPreferenceAction",
  "lib/modules/settings/actions.ts::updateOnlineBookingSettingAction",
  "lib/modules/settings/actions.ts::updateSelfServicePolicyAction",
  "lib/modules/staff/actions.ts::createStaffExceptionAction",
  "lib/modules/staff/actions.ts::createStaffMemberAction",
  "lib/modules/staff/actions.ts::deleteStaffExceptionAction",
  "lib/modules/staff/actions.ts::updateStaffBranchesAction",
  "lib/modules/staff/actions.ts::updateStaffProfileAction",
  "lib/modules/staff/actions.ts::updateStaffScheduleAction",
  "lib/modules/staff/actions.ts::updateStaffServicesAction",
  "lib/modules/staff/actions.ts::updateStaffStatusAction",
  "lib/modules/team/accept-actions.ts::acceptTeamInvitationAction",
  "lib/modules/team/actions.ts::createTeamInvitationAction",
  "lib/modules/team/actions.ts::resendTeamInvitationAction",
  "lib/modules/team/actions.ts::revokeTeamInvitationAction",
  "lib/modules/team/member-actions.ts::reactivateMemberAction",
  "lib/modules/team/member-actions.ts::removeMemberAction",
  "lib/modules/team/member-actions.ts::suspendMemberAction",
  "lib/modules/tenants/actions.ts::createTenantAction",
];

const FORBIDDEN_PARAM = /^(supabase|client|admin|adminClient|sql|db|deps|dependencies|sendEmail|mailer|transport|userId|actorUserId|actor|currentUserId|callerId)$/i;
const FORMER_HELPERS = ["createTeamInvitationCore", "resendTeamInvitationCore", "revokeTeamInvitationCore"];

describe("SEC.1A server action boundary (static)", () => {
  const surface = collectSurface();

  it("S1 every export of a \"use server\" module is an async function named *Action", () => {
    const bad = surface.filter((s) => !s.isAsyncFunction || !/Action$/.test(s.name));
    expect(bad, JSON.stringify(bad)).toEqual([]);
  });

  it("S2 no exported action accepts an injectable client, user id, mailer, sql handle or deps bag", () => {
    const bad = surface.filter((s) => s.params.some((p) => FORBIDDEN_PARAM.test(p)));
    expect(bad, JSON.stringify(bad)).toEqual([]);
  });

  it("S3 the exported action set equals the reviewed snapshot (71 entry points)", () => {
    const actual = surface.map((s) => `${s.file}::${s.name}`).sort();
    expect(actual).toEqual([...REVIEWED_SURFACE].sort());
    expect(REVIEWED_SURFACE).toHaveLength(71);
  });

  it("S3b the three former helpers are not exported from any \"use server\" module", () => {
    expect(surface.filter((s) => FORMER_HELPERS.includes(s.name))).toEqual([]);
  });

  it("S4 the invitation orchestration has no \"use server\" directive and exports the Core functions", () => {
    const core = readFileSync(path.join(ROOT, "lib/modules/team/invitation-core.ts"), "utf8");
    const sf = ts.createSourceFile("invitation-core.ts", core, ts.ScriptTarget.Latest, true);
    expect(fileLevelUseServer(sf)).toBe(false);
    expect(core).not.toMatch(/^\s*["']use server["']\s*;?\s*$/m);
    for (const name of FORMER_HELPERS) expect(core).toMatch(new RegExp(`export async function ${name}\\(`));
  });

  it("S4b only the wrappers (and tests) import the orchestration module; no client component can pull it in", () => {
    const importers: string[] = [];
    for (const dir of ["lib", "app", "components"]) {
      for (const f of walk(path.join(ROOT, dir))) {
        if (/invitation-core\.ts$/.test(f)) continue;
        if (/from\s+["'](@\/lib\/modules\/team\/invitation-core|\.\/invitation-core)["']/.test(readFileSync(f, "utf8"))) importers.push(path.relative(ROOT, f).split(path.sep).join("/"));
      }
    }
    expect(importers).toEqual(["lib/modules/team/actions.ts"]);
  });

  it("S5 (when a production build exists) the server-reference manifest matches the reviewed surface and has none of the former helpers", () => {
    const manifestPath = path.join(ROOT, ".next/server/server-reference-manifest.json");
    if (!existsSync(manifestPath)) return; // no build in this checkout: the static checks above still hold
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { node?: Record<string, { exportedName?: string }> };
    const names = Object.values(manifest.node ?? {}).map((v) => v.exportedName ?? "");
    for (const f of FORMER_HELPERS) expect(names).not.toContain(f);
    expect(names.every((n) => /Action$/.test(n)), JSON.stringify(names.filter((n) => !/Action$/.test(n)))).toBe(true);
    expect(names.length).toBe(REVIEWED_SURFACE.length);
  });
});
