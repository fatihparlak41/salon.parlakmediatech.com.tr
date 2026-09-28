import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admin,
  testDb,
  signInAs,
  createTestUser,
  createTestTenant,
  createTestMembershipFromTemplate,
  cleanupTenants,
  cleanupUsers,
  type TestTenant,
  type TestUser,
} from "./helpers";
import {
  NOTIFICATION_PREFERENCE_KEYS,
  parseNotificationPreferences,
} from "@/lib/modules/notifications/preference-keys";

/**
 * Faz ACCOUNT.1 — personal account / notification settings for EVERY active
 * member of a salon, separate from salon settings (settings.manage), plus
 * (Faz ACCOUNT.1 security) the shared-browser device-ownership policy.
 *
 * Dashboard-greeting / profile-name consistency is a SEPARATE concern with
 * its own commit — see tests/profile-name-greeting.test.ts.
 *
 * What this file proves, in three layers:
 *   A. source contracts   — the personal page is not permission-gated, salon
 *                           settings still are, the user menu links to it,
 *                           every i18n key the new UI uses exists, and
 *                           (A8-A14) the shared-browser policy is wired into
 *                           every sign-out / shell / device-card entry point
 *   B. preference action  — parsing + the Server Action's mapping/guards
 *                           (mocked Supabase, same narrow precedent as
 *                           push-subscription.test.ts)
 *   C. real database      — the four locked roles (Owner, Yönetici,
 *                           Resepsiyon, Personel) can each manage THEIR OWN
 *                           devices and preferences without settings.manage,
 *                           and nobody can touch anybody else's, in another
 *                           role or another tenant
 */

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Mocks for layer B (the Server Action). They only affect modules imported
// through the Next-specific paths below; layers C/D talk to the database
// through tests/helpers.ts's own clients.
const rpcMock = vi.fn();
const requireUserMock = vi.fn(async () => ({ id: "mock-user-id" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: rpcMock }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: vi.fn() }),
}));
// hasPermission is deliberately NOT provided: if the preference action (or
// anything it imports) ever reached for it, the mock would throw.
vi.mock("@/lib/auth/session", () => ({
  requireUser: () => requireUserMock(),
}));
vi.mock("@/lib/pwa/web-push-server", () => ({
  sendTestPush: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

// ===================== A. SOURCE CONTRACTS =====================

describe("Hesabım is separate from salon settings (source contracts)", () => {
  const accountPagePath = "app/[locale]/app/[tenantSlug]/account/page.tsx";
  const accountPage = read(accountPagePath);
  const settingsPage = read("app/[locale]/app/[tenantSlug]/settings/page.tsx");
  const layout = read("app/[locale]/app/[tenantSlug]/layout.tsx");
  const shell = read("components/tenant-app/app-shell.tsx");
  const messages = JSON.parse(read("messages/tr.json"));

  it("A1. the account page has NO permission gate and never bounces a member away", () => {
    const code = codeOnly(accountPage);
    expect(code).not.toMatch(/settings\.manage/);
    expect(code).not.toMatch(/\bredirect\(/);
    expect(code).not.toMatch(/\bnotFound\(/);
    // Membership is proven by the tenant layout + getTenantAccess, which is
    // the whole requirement.
    expect(code).toContain("getTenantAccess(tenantSlug)");
    // The only permission lookups are informational (the "which appointments
    // will reach my devices" note) — they never decide whether the page renders.
    const looked = Array.from(code.matchAll(/hasPermission\(tenantId, "([a-z_.]+)"\)/g))
      .map((m) => m[1])
      .sort();
    expect(looked).toEqual(["appointments.create", "appointments.view"]);
    // No salon-wide data is fetched here (settings queries, branches, team...).
    expect(code).not.toMatch(/settings\/queries|branches\/queries|team\/queries|getSelfServicePolicy|getOwnerManagedBranches/);
  });

  it("A2. salon settings stay behind settings.manage: the page still bounces without it and the nav still hides it", () => {
    expect(settingsPage).toMatch(/hasPermission\(access\.tenant\.id, "settings\.manage"\)/);
    expect(settingsPage).toContain("redirect(`/app/${tenantSlug}`)");
    expect(layout).toMatch(/hasPermission\(access\.tenant\.id, "settings\.manage"\)/);
    expect(layout).toMatch(/canManageSettings\s*\n?\s*\?\s*\[\{ href: "\/settings"/);
  });

  it("A3. the device notification card is no longer part of salon settings", () => {
    expect(codeOnly(settingsPage)).not.toMatch(/NotificationSettingsCard|DeviceNotificationsCard|NotificationPreferencesCard|WEB_PUSH/);
    expect(existsSync(join(root, "components/settings/notification-settings-card.tsx"))).toBe(false);
    // ...and it renders on the account page instead.
    expect(accountPage).toContain("<DeviceNotificationsCard");
    expect(accountPage).toContain("<NotificationPreferencesCard");
  });

  it("A4. no Hesabım entry is hidden behind a permission in the sidebar — it lives in the user menu, on desktop AND in the mobile sheet", () => {
    expect(layout).not.toMatch(/href:\s*"\/account/);
    expect(shell).toContain("`${basePath}/account`");
    expect(shell).toContain("`${basePath}/account#notifications`");
    // Two UserMenu usages (desktop aside + mobile sheet); only the mobile
    // one closes the sheet on navigation.
    expect((shell.match(/<UserMenu\b/g) ?? []).length).toBe(2);
    expect((shell.match(/onNavigate=\{\(\) => setMobileOpen\(false\)\}/g) ?? []).length).toBe(2); // NavLinks + mobile UserMenu
    // The menu items themselves carry no permission logic.
    const menuSrc = shell.slice(shell.indexOf("function UserMenu"), shell.indexOf("export function TenantAppShell"));
    expect(menuSrc).not.toMatch(/hasPermission|settings\.manage|canManage/);
  });

  it("A5. every i18n key the new UI reads exists in tr.json", () => {
    const at = (path: string): unknown => path.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], messages);
    function keysUsed(src: string, fn: string): string[] {
      return Array.from(src.matchAll(new RegExp(`\\b${fn}\\("([^"]+)"`, "g"))).map((m) => m[1]!);
    }
    const missing: string[] = [];
    const check = (ns: string, keys: string[]) => {
      for (const key of keys) {
        if (typeof at(`${ns}.${key}`) !== "string") missing.push(`${ns}.${key}`);
      }
    };

    check("TenantApp.account.notifications", keysUsed(read("components/account/device-notifications-card.tsx"), "t"));

    const prefsSrc = read("components/account/notification-preferences-card.tsx");
    check("TenantApp.account.categories", [
      ...keysUsed(prefsSrc, "t"),
      ...NOTIFICATION_PREFERENCE_KEYS.flatMap((k) => [`${k}.label`, `${k}.description`]),
    ]);

    check("TenantApp.account", keysUsed(accountPage, "t"));
    check("TenantApp.userMenu", keysUsed(layout, "tUserMenu"));
    check("Settings", keysUsed(settingsPage, "t"));
    expect(missing).toEqual([]);
  });
});

// ============ A-2. SHARED-BROWSER POLICY WIRING (source contracts) ============
// The policy itself is unit-tested in device-session.test.ts and proven end to
// end in the Playwright scenarios; these pin that every entry point is wired.

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    const full = join(root, rel);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

describe("shared-browser policy is wired into every entry point (source contracts)", () => {
  it("A8. no component or page posts a raw sign-out form: every 'Çıkış yap' goes through SignOutForm", () => {
    // Nobody, including SignOutForm itself, wires signOutAction as a plain
    // form `action` any more — see A9 for why (Base UI's menu unmounts the
    // form before a deferred requestSubmit() could ever reach it).
    const offenders = [...sourceFiles("components"), ...sourceFiles("app")].filter((f) =>
      /action=\{signOutAction\}/.test(read(f)),
    );
    expect(offenders).toEqual([]);
    for (const f of [
      "components/tenant-app/app-shell.tsx",
      "components/customer-account/account-shell.tsx",
      "components/auth/accept-invite-panel.tsx",
    ]) {
      expect(read(f), f).toContain("<SignOutForm");
    }
  });

  it("A9. SignOutForm runs the time-boxed device cleanup BEFORE the real sign-out, and can never block or fail it", () => {
    const src = read("components/auth/sign-out-form.tsx");
    const cleanup = src.indexOf("disconnectThisBrowser(");
    const signOutCall = src.indexOf("signOutAction(formData)");
    expect(cleanup).toBeGreaterThan(-1);
    // signOutAction is called directly (not via a form `action` prop): Base
    // UI's menu unmounts this form the instant "Çıkış yap" is activated, so
    // a deferred form.requestSubmit() on the now-detached node would be
    // silently ignored by the browser — see this file's own doc comment.
    expect(signOutCall).toBeGreaterThan(cleanup);
    expect(src).not.toContain("action={signOutAction}");
    expect(src).not.toMatch(/\.requestSubmit\(/); // no longer re-submits a DOM node that Base UI may have already unmounted
    expect(src).toContain("new FormData(event.currentTarget)"); // fields captured regardless of DOM connectivity
    expect(src).toContain("event.preventDefault()"); // the browser never submits this form on its own
    expect(src).toMatch(/try \{[\s\S]*disconnectThisBrowser[\s\S]*\} catch/); // a failing cleanup is swallowed
    // revokes only through the ownership-checked action, by row id
    expect(src).toContain("removePushSubscriptionAction(null, { subscriptionId })");
  });

  it("A10. both authenticated shells mount the device guard with a SERVER-computed tag — the raw user id never reaches the client for this", () => {
    for (const f of ["components/tenant-app/app-shell.tsx", "components/customer-account/account-shell.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("<PushDeviceGuard ownerTag={deviceOwnerTag} />");
      expect(src, f).not.toMatch(/user\.id|userId/);
    }
    expect(read("app/[locale]/app/[tenantSlug]/layout.tsx")).toContain("deviceOwnerTag={deviceOwnerTag(access.user.id)}");
    expect(read("app/[locale]/account/(guarded)/layout.tsx")).toContain("deviceOwnerTag={deviceOwnerTag(user.id)}");
    expect(read("app/[locale]/account/link-salon/[tenantSlug]/page.tsx")).toContain("deviceOwnerTag={deviceOwnerTag(user.id)}");
    expect(read("app/[locale]/app/[tenantSlug]/account/page.tsx")).toContain("ownerTag={deviceOwnerTag(access.user.id)}");
    // the tag module is server-only and hashes
    const tagSrc = read("lib/pwa/device-owner-tag.ts");
    expect(tagSrc.trimStart().startsWith('import "server-only";')).toBe(true);
    expect(tagSrc).toContain("createHash(\"sha256\")");
  });

  it("A11. the device card never adopts another person's subscription, records ownership when THIS member connects, and forgets it on disconnect", () => {
    const card = read("components/account/device-notifications-card.tsx");
    expect(card).toContain("isForeignDevice(browserDeviceIdentity(), ownerTag)");
    expect(card).toContain("enforceDeviceOwnership(ownerTag, browserDeviceDeps())");
    expect((card.match(/identity\.setOwnerTag\(ownerTag\)/g) ?? []).length).toBe(2); // reconcile + connect
    expect((card.match(/identity\.rememberDevice\(tenantId, result\.data\.id\)/g) ?? []).length).toBe(2);
    expect(card).toContain("browserDeviceIdentity().clear()"); // disconnect
    // the foreign-device branch returns BEFORE anything is saved for this member
    const foreign = card.indexOf("isForeignDevice(browserDeviceIdentity(), ownerTag)");
    const firstSave = card.indexOf("savePushSubscriptionAction(null");
    expect(foreign).toBeGreaterThan(-1);
    expect(foreign).toBeLessThan(firstSave);
  });

  it("A12. the policy module is framework-free, touches no server API, and the browser wiring is the only place that reads localStorage", () => {
    const policy = codeOnly(read("lib/pwa/device-session.ts"));
    expect(policy).not.toMatch(/localStorage|sessionStorage|navigator\.|document\.|window\./);
    expect(policy).not.toMatch(/fetch\(|supabase|rpc\(/i);
    expect(codeOnly(read("lib/pwa/device-session-browser.ts"))).toMatch(/window\.localStorage/);
  });

  it("A13. the account page tells the member what signing out does (the policy is visible, not hidden)", () => {
    const messages = JSON.parse(read("messages/tr.json"));
    expect(messages.TenantApp.account.notifications.signOutNote).toMatch(/Çıkış yaptığınızda/);
    expect(read("components/account/device-notifications-card.tsx")).toContain('t("signOutNote")');
  });

  it("A14. when the server REFUSES a freshly created subscription, the browser drops it again — no orphan for the next person on this browser", () => {
    const card = read("components/account/device-notifications-card.tsx");
    const refused = card.slice(card.indexOf("setDeviceError(result.error.message)") - 400, card.indexOf("setDeviceError(result.error.message)"));
    expect(refused).toContain("unsubscribeFromPush(subscription)");
    expect(refused).toContain(".catch(() => undefined)"); // best effort, never throws into the UI
  });
});

// ===================== B. PREFERENCE PARSING + ACTION =====================

describe("notification preference parsing", () => {
  const all = { newAppointment: true, cancellation: false, reschedule: true, assignmentChange: false };

  it("B1. accepts exactly the four named booleans", () => {
    expect(parseNotificationPreferences(all)).toEqual(all);
  });

  it("B2. ignores extra fields, rejects a missing or non-boolean one, never invents a default", () => {
    expect(parseNotificationPreferences({ ...all, extra: 1 })).toEqual(all);
    expect(parseNotificationPreferences({ newAppointment: true })).toBeNull();
    expect(parseNotificationPreferences({ ...all, cancellation: "yes" })).toBeNull();
    expect(parseNotificationPreferences(null)).toBeNull();
    expect(parseNotificationPreferences("nope")).toBeNull();
    expect(parseNotificationPreferences(undefined)).toBeNull();
  });

  it("B3. the key list is exactly the four categories the delivery worker honours — and no reminder key", () => {
    expect([...NOTIFICATION_PREFERENCE_KEYS].sort()).toEqual(["assignmentChange", "cancellation", "newAppointment", "reschedule"]);
  });
});

describe("updateMyNotificationPreferenceAction", () => {
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const allTrue = { newAppointment: true, cancellation: true, reschedule: true, assignmentChange: true };

  async function loadAction() {
    return (await import("@/lib/modules/settings/actions")).updateMyNotificationPreferenceAction;
  }

  it("B4. sends ONLY the flipped category (plus the tenant) and returns the authoritative preference set", async () => {
    const expectedParam = {
      newAppointment: "p_new_appointment",
      cancellation: "p_cancellation",
      reschedule: "p_reschedule",
      assignmentChange: "p_assignment_change",
    } as const;
    for (const key of NOTIFICATION_PREFERENCE_KEYS) {
      rpcMock.mockResolvedValueOnce({ data: { ...allTrue, [key]: false }, error: null });
      const action = await loadAction();
      const result = await action(null, { tenantId, key, enabled: false });
      expect(rpcMock).toHaveBeenLastCalledWith("update_my_notification_preferences", {
        p_tenant_id: tenantId,
        [expectedParam[key]]: false,
      });
      expect(result).toEqual({ success: true, data: { ...allTrue, [key]: false } });
    }
    expect(requireUserMock).toHaveBeenCalled();
  });

  it("B5. never accepts a user or membership id — those are not part of the input type and never reach the RPC", async () => {
    rpcMock.mockResolvedValueOnce({ data: allTrue, error: null });
    const action = await loadAction();
    // @ts-expect-error — deliberately trying to smuggle another member's id in.
    await action(null, { tenantId, key: "cancellation", enabled: true, userId: "someone-else", tenantMembershipId: "someone-elses-membership" });
    const args = rpcMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["p_cancellation", "p_tenant_id"]);

    const src = codeOnly(read("lib/modules/settings/actions.ts"));
    const fnStart = src.indexOf("export async function updateMyNotificationPreferenceAction");
    const inputType = src.slice(src.indexOf("input:", fnStart), src.indexOf("):", fnStart));
    expect(inputType).not.toMatch(/userId|user_id|membership/i);
  });

  it("B6. an unknown or prototype-chain key, or a non-boolean value, is rejected before the database is touched", async () => {
    const action = await loadAction();
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "isAdmin", ""]) {
      // @ts-expect-error — invalid keys on purpose.
      const result = await action(null, { tenantId, key, enabled: true });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("VALIDATION");
    }
    // @ts-expect-error — enabled must be a real boolean.
    const notBoolean = await action(null, { tenantId, key: "reschedule", enabled: "true" });
    expect(notBoolean.success).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("B7. NF003 (no active membership) is UNAUTHORIZED; anything else is a generic UNEXPECTED that logs only the tenant and the code", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "NF003", message: "active tenant membership required" } });
    const action = await loadAction();
    const denied = await action(null, { tenantId, key: "newAppointment", enabled: false });
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe("UNAUTHORIZED");

    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "internal detail that must not leak" } });
    const failed = await action(null, { tenantId, key: "newAppointment", enabled: false });
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.error.code).toBe("UNEXPECTED");
      expect(failed.error.message).not.toMatch(/internal detail/);
    }
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[updateMyNotificationPreferenceAction] failed",
      { tenantId, code: "XX000" },
    );
    consoleErrorSpy.mockRestore();
  });

  it("B8. a malformed RPC answer is never passed through as if it were preferences", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValueOnce({ data: { newAppointment: true }, error: null });
    const action = await loadAction();
    const result = await action(null, { tenantId, key: "newAppointment", enabled: true });
    expect(result.success).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  it("B9. an unauthenticated caller never reaches the RPC (requireUser() runs first)", async () => {
    requireUserMock.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    const action = await loadAction();
    await expect(action(null, { tenantId, key: "cancellation", enabled: true })).rejects.toThrow("NEXT_REDIRECT");
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

// ===================== C. REAL DATABASE — FOUR ROLES =====================

type RoleLabel = "owner" | "manager" | "receptionist" | "stylist";

describe("every role manages ITS OWN devices and preferences — and nobody else's (real database)", () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant; // an unrelated salon — cross-tenant isolation
  const users = {} as Record<RoleLabel | "outsider", TestUser>;
  const clients = {} as Record<RoleLabel | "outsider", SupabaseClient>;

  const endpoint = (label: string) =>
    `https://push.example.test/ep/account1-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function saveDevice(who: RoleLabel | "outsider", tenantId: string, ep: string, label = "Test Device") {
    return clients[who].rpc("save_push_subscription", {
      p_tenant_id: tenantId,
      p_endpoint: ep,
      p_p256dh: "p256dh-account1",
      p_auth_key: "auth-account1",
      p_device_label: label,
    });
  }

  beforeAll(async () => {
    for (const label of ["owner", "manager", "receptionist", "stylist", "outsider"] as const) {
      users[label] = await createTestUser(`account1-${label}`);
    }
    tenantA = await createTestTenant("account1-a", users.owner.id);
    await createTestMembershipFromTemplate(tenantA.id, users.manager.id, "SALON_MANAGER");
    await createTestMembershipFromTemplate(tenantA.id, users.receptionist.id, "RECEPTIONIST");
    await createTestMembershipFromTemplate(tenantA.id, users.stylist.id, "STYLIST");
    tenantB = await createTestTenant("account1-b", users.outsider.id);

    for (const label of Object.keys(users) as Array<RoleLabel | "outsider">) {
      clients[label] = await signInAs(users[label]);
    }
  });

  afterAll(async () => {
    await cleanupTenants([tenantA.id, tenantB.id].filter(Boolean));
    await cleanupUsers(Object.values(users).map((u) => u.id));
  });

  it("C1. the premise: only the Owner holds settings.manage — the other three roles are exactly the ones that could not reach the old settings-page card", async () => {
    const expected: Record<RoleLabel, boolean> = { owner: true, manager: false, receptionist: false, stylist: false };
    for (const label of Object.keys(expected) as RoleLabel[]) {
      const { data, error } = await clients[label].rpc("has_permission", {
        p_tenant_id: tenantA.id,
        p_permission_key: "settings.manage",
      });
      expect(error).toBeNull();
      expect(data).toBe(expected[label]);
    }
  });

  for (const role of ["owner", "manager", "receptionist", "stylist"] as const) {
    it(`C2. ${role}: full personal lifecycle without settings.manage — connect a device, see it, set preferences, disconnect`, async () => {
      const ep = endpoint(`lifecycle-${role}`);
      const saved = await saveDevice(role, tenantA.id, ep, "Lifecycle");
      expect(saved.error).toBeNull();
      const deviceId = (saved.data as { id: string }).id;

      const listed = await clients[role].rpc("list_my_devices", { p_tenant_id: tenantA.id });
      expect(listed.error).toBeNull();
      const mine = (listed.data as Array<{ id: string; revoked: boolean }>).find((d) => d.id === deviceId);
      expect(mine?.revoked).toBe(false);
      // The list never exposes the push endpoint or its keys.
      expect(JSON.stringify(listed.data)).not.toMatch(/endpoint|p256dh|auth_key|account1-lifecycle/);

      // First read is the all-true default; each role can flip its own category.
      const before = await clients[role].rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
      expect(before.error).toBeNull();
      expect(parseNotificationPreferences(before.data)).toEqual({
        newAppointment: true,
        cancellation: true,
        reschedule: true,
        assignmentChange: true,
      });
      const updated = await clients[role].rpc("update_my_notification_preferences", {
        p_tenant_id: tenantA.id,
        p_reschedule: false,
      });
      expect(updated.error).toBeNull();
      expect(parseNotificationPreferences(updated.data)).toEqual({
        newAppointment: true,
        cancellation: true,
        reschedule: false,
        assignmentChange: true,
      });
      // ...and a partial update of a different key leaves that one alone.
      const again = await clients[role].rpc("update_my_notification_preferences", {
        p_tenant_id: tenantA.id,
        p_cancellation: false,
      });
      expect(parseNotificationPreferences(again.data)).toMatchObject({ cancellation: false, reschedule: false });

      const removed = await clients[role].rpc("remove_push_subscription", { p_subscription_id: deviceId });
      expect(removed.error).toBeNull();
      const after = await clients[role].rpc("list_my_devices", { p_tenant_id: tenantA.id });
      expect((after.data as Array<{ id: string; revoked: boolean }>).find((d) => d.id === deviceId)?.revoked).toBe(true);
    });
  }

  it("C3. a Yönetici cannot revoke, list or see another member's device — not the Owner's, not the Receptionist's", async () => {
    const ownerDevice = await saveDevice("owner", tenantA.id, endpoint("owner-private"), "OwnerPhone");
    const receptionDevice = await saveDevice("receptionist", tenantA.id, endpoint("reception-private"), "ReceptionPc");
    const ownerDeviceId = (ownerDevice.data as { id: string }).id;
    const receptionDeviceId = (receptionDevice.data as { id: string }).id;

    for (const targetId of [ownerDeviceId, receptionDeviceId]) {
      const { error } = await clients.manager.rpc("remove_push_subscription", { p_subscription_id: targetId });
      // "belongs to someone else" and "does not exist" are the same answer.
      expect(error?.code).toBe("NF004");
    }
    const rows = await testDb<{ id: string; revoked_at: Date | null }[]>`
      select id, revoked_at from push_subscriptions where id in ${testDb([ownerDeviceId, receptionDeviceId])}
    `;
    expect(rows.every((r) => r.revoked_at === null)).toBe(true);

    const managerList = await clients.manager.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const ids = (managerList.data as Array<{ id: string }>).map((d) => d.id);
    expect(ids).not.toContain(ownerDeviceId);
    expect(ids).not.toContain(receptionDeviceId);
    expect(JSON.stringify(managerList.data)).not.toMatch(/OwnerPhone|ReceptionPc/);
  });

  it("C4. a member's preference change never touches anyone else's row — there is no argument that could name one", async () => {
    // Receptionist and Personel each turn a different category off.
    await clients.receptionist.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_new_appointment: false });
    await clients.stylist.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_assignment_change: false });
    // The Yönetici then turns EVERYTHING off for themselves.
    for (const p of ["p_new_appointment", "p_cancellation", "p_reschedule", "p_assignment_change"]) {
      await clients.manager.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, [p]: false });
    }

    const rows = await testDb<
      { user_id: string; new_appointment: boolean; cancellation: boolean; reschedule: boolean; assignment_change: boolean }[]
    >`
      select tm.user_id, np.new_appointment, np.cancellation, np.reschedule, np.assignment_change
      from notification_preferences np
      join tenant_memberships tm on tm.id = np.tenant_membership_id
      where tm.tenant_id = ${tenantA.id}
    `;
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    expect(byUser.get(users.manager.id)).toMatchObject({ new_appointment: false, cancellation: false, reschedule: false, assignment_change: false });
    expect(byUser.get(users.receptionist.id)).toMatchObject({ new_appointment: false, assignment_change: true });
    expect(byUser.get(users.stylist.id)).toMatchObject({ new_appointment: true, assignment_change: false });
  });

  it("C5. cross-tenant: a member of ANOTHER salon can neither register a device, read/update preferences, list nor revoke here", async () => {
    const victim = await saveDevice("manager", tenantA.id, endpoint("cross-tenant-victim"), "ManagerPhone");
    const victimId = (victim.data as { id: string }).id;

    const save = await saveDevice("outsider", tenantA.id, endpoint("cross-tenant-intruder"));
    expect(save.error?.code).toBe("NF003");

    const get = await clients.outsider.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(get.error?.code).toBe("NF003");
    const set = await clients.outsider.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_cancellation: false });
    expect(set.error?.code).toBe("NF003");

    const list = await clients.outsider.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    expect(list.error).toBeNull();
    expect(list.data).toEqual([]);

    const revoke = await clients.outsider.rpc("remove_push_subscription", { p_subscription_id: victimId });
    expect(revoke.error?.code).toBe("NF004");

    // ...and salon A's own data was not changed by any of it.
    const [row] = await testDb<{ revoked_at: Date | null }[]>`select revoked_at from push_subscriptions where id = ${victimId}`;
    expect(row!.revoked_at).toBeNull();
    const intruderRows = await testDb`select id from push_subscriptions where endpoint like ${"%cross-tenant-intruder%"}`;
    expect(intruderRows).toHaveLength(0);
  });

  it("C6. both push tables are unreachable directly — every role only ever goes through the RPCs", async () => {
    for (const label of ["owner", "manager", "receptionist", "stylist"] as const) {
      for (const table of ["push_subscriptions", "notification_preferences"]) {
        const { data, error } = await clients[label].from(table as "push_subscriptions").select("*");
        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error!.code).toBe("42501"); // permission denied for table
      }
    }
  });

  it("C7. the test-send read is scoped to the caller even for a role with no settings.manage — it can never return another member's device", async () => {
    const managerDevice = await saveDevice("manager", tenantA.id, endpoint("testsend-manager"), "MgrTest");
    const receptionDevice = await saveDevice("receptionist", tenantA.id, endpoint("testsend-reception"), "RecTest");
    const managerDeviceId = (managerDevice.data as { id: string }).id;
    const receptionDeviceId = (receptionDevice.data as { id: string }).id;

    const { data, error } = await admin.rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenantA.id,
      p_user_id: users.manager.id, // what requireUser() supplies server-side
    });
    expect(error).toBeNull();
    const ids = (data as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(managerDeviceId);
    expect(ids).not.toContain(receptionDeviceId);

    // A user with no membership in this salon is rejected outright.
    const outsiderRead = await admin.rpc("get_push_subscriptions_for_test_send", {
      p_tenant_id: tenantA.id,
      p_user_id: users.outsider.id,
    });
    expect(outsiderRead.error?.message).toMatch(/active tenant membership required/i);
  });

  it("C8. logout/login on a shared browser never corrupts subscriptions: the device follows whoever last connected it, no duplicates, no leftover owner", async () => {
    const shared = endpoint("shared-browser");

    // Yönetici connects, "logs out"; Resepsiyon logs in on the same browser and connects.
    const first = await saveDevice("manager", tenantA.id, shared, "Shared PC");
    expect(first.error).toBeNull();
    await saveDevice("manager", tenantA.id, shared, "Shared PC"); // re-visit: idempotent, still ONE row
    const second = await saveDevice("receptionist", tenantA.id, shared, "Shared PC");
    expect(second.error).toBeNull();

    const afterSwitch = await testDb<{ user_id: string; revoked_at: Date | null }[]>`
      select tm.user_id, ps.revoked_at
      from push_subscriptions ps join tenant_memberships tm on tm.id = ps.tenant_membership_id
      where ps.endpoint = ${shared}
    `;
    expect(afterSwitch).toHaveLength(2); // one row per (endpoint, membership) — never a duplicate of the same pair
    const active = afterSwitch.filter((r) => r.revoked_at === null);
    expect(active.map((r) => r.user_id)).toEqual([users.receptionist.id]);

    // The Yönetici comes back and connects again: the device moves back.
    await saveDevice("manager", tenantA.id, shared, "Shared PC");
    const afterReturn = await testDb<{ user_id: string; revoked_at: Date | null }[]>`
      select tm.user_id, ps.revoked_at
      from push_subscriptions ps join tenant_memberships tm on tm.id = ps.tenant_membership_id
      where ps.endpoint = ${shared}
    `;
    expect(afterReturn).toHaveLength(2);
    expect(afterReturn.filter((r) => r.revoked_at === null).map((r) => r.user_id)).toEqual([users.manager.id]);
  });

  it("C9. a suspended member can no longer register a device or change preferences, but can still clean up their own", async () => {
    const ep = endpoint("suspended-stylist");
    const before = await saveDevice("stylist", tenantA.id, ep, "StylistPhone");
    const deviceId = (before.data as { id: string }).id;

    await testDb`update tenant_memberships set status = 'suspended' where tenant_id = ${tenantA.id} and user_id = ${users.stylist.id}`;
    try {
      const save = await saveDevice("stylist", tenantA.id, endpoint("suspended-new"));
      expect(save.error?.code).toBe("NF003");
      const prefs = await clients.stylist.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_cancellation: false });
      expect(prefs.error?.code).toBe("NF003");
      const cleanup = await clients.stylist.rpc("remove_push_subscription", { p_subscription_id: deviceId });
      expect(cleanup.error).toBeNull();
    } finally {
      await testDb`update tenant_memberships set status = 'active' where tenant_id = ${tenantA.id} and user_id = ${users.stylist.id}`;
    }
  });
});
