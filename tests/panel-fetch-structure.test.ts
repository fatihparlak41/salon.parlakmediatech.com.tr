import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSetupHealth } from "@/lib/modules/dashboard/queries";

/**
 * Faz PERF.4 — the owner pages were slow because their database reads ran
 * one after another (the Panel alone was ten sequential awaits, plus the
 * access check in front of every page). The reads are independent, so they
 * now overlap. No database here: the pure assembly is tested directly, and
 * the shape that makes the speed-up (and must not silently regress back to a
 * waterfall) is pinned as source contracts, the same way
 * profile-name-greeting.test.ts pins the home page. The behaviour itself —
 * identical rendered pages for an owner, a receptionist and a staff-linked
 * stylist — was verified before/after in a real browser session against DEV.
 */

const root = join(__dirname, "..");
// Comments legitimately NAME the old pattern; only executable code may be judged.
function codeOnly(rel: string): string {
  const src = readFileSync(join(root, rel), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("buildSetupHealth (pure assembly behind the dashboard's Attention section)", () => {
  it("nothing configured: every flag is off", () => {
    expect(buildSetupHealth(false, false, [])).toEqual({
      onlineBookingEnabled: false,
      hasActiveService: false,
      hasActiveStaff: false,
      staffMissingSchedule: false,
    });
  });

  it("flags a staff member without a schedule, and only then", () => {
    const withGap = buildSetupHealth(true, true, [
      { id: "a", fullName: "A", hasSchedule: true },
      { id: "b", fullName: "B", hasSchedule: false },
    ]);
    expect(withGap).toEqual({
      onlineBookingEnabled: true,
      hasActiveService: true,
      hasActiveStaff: true,
      staffMissingSchedule: true,
    });

    const complete = buildSetupHealth(true, true, [{ id: "a", fullName: "A", hasSchedule: true }]);
    expect(complete.staffMissingSchedule).toBe(false);
    expect(complete.hasActiveStaff).toBe(true);
  });

  it("passes the two answers it was given straight through", () => {
    expect(buildSetupHealth(true, false, [])).toMatchObject({ onlineBookingEnabled: true, hasActiveService: false });
    expect(buildSetupHealth(false, true, [])).toMatchObject({ onlineBookingEnabled: false, hasActiveService: true });
  });
});

describe("getTenantAccess keeps its outcome while its two reads overlap", () => {
  const session = codeOnly("lib/auth/session.ts");
  const start = session.indexOf("export const getTenantAccess");
  const body = session.slice(start, session.indexOf("export const hasPermission", start));

  it("looks the tenant up in the same Promise.all as the user check, not after it", () => {
    expect(body).toMatch(/Promise\.all\(\[\s*getCurrentUser\(\),\s*supabase\s*\.from\("tenants"\)/);
  });

  it("still answers 'unauthenticated' before it looks at any membership, and 'not_found' for an unseen tenant", () => {
    const unauthenticated = body.indexOf('if (!user) return { reason: "unauthenticated" }');
    const noTenant = body.indexOf('if (!tenant) return { reason: "not_found" }');
    const membershipRead = body.indexOf('.from("tenant_memberships")');
    expect(unauthenticated).toBeGreaterThan(-1);
    expect(noTenant).toBeGreaterThan(unauthenticated);
    expect(membershipRead).toBeGreaterThan(noTenant);
  });

  it("hands the membership row id it already read to the caller", () => {
    expect(body).toContain("membershipId: membership.id");
  });
});

describe("the Panel page reads its data in overlapping groups, not one await at a time", () => {
  const page = codeOnly("app/[locale]/app/[tenantSlug]/page.tsx");

  it("never awaits one of the independent reads on its own line", () => {
    for (const name of [
      "getTenantTimezone",
      "getMyFirstName",
      "getStaffLinkByMembership",
      "getOnlineBookingEnabled",
      "getTodayAppointments",
      "getActiveStaffRoster",
      "getMonthSummary",
      "getHasActiveService",
      "getMyTodayWorkingHours",
    ]) {
      expect(page, `${name} must sit inside a Promise.all`).not.toMatch(new RegExp(`await\\s+${name}\\(`));
    }
  });

  it("uses the membership id from the access check instead of a second membership query", () => {
    expect(page).toContain("access.membershipId");
    expect(page).not.toContain("getMyMembershipId");
  });

  it("has the three overlapping groups: shared reads, personal view, salon-wide view", () => {
    expect((page.match(/await Promise\.all\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
