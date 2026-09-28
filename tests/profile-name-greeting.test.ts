import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  testDb,
  signInAs,
  createTestUser,
  createTestTenant,
  createTestMembershipFromTemplate,
  createStaffMember,
  cleanupTenants,
  cleanupUsers,
  type TestTenant,
  type TestUser,
} from "./helpers";
import { getMyFirstName } from "@/lib/modules/dashboard/queries";

/**
 * Dashboard-greeting / profile-name consistency — split out of Faz
 * ACCOUNT.1's personal-notification-settings.test.ts (see that file's own
 * doc comment: this project ships this as its own commit, separate from
 * the notifications feature).
 *
 * The bug this fixes: a non-owner member's `profiles.full_name` can hold
 * the SALON's name (production case — the sign-up form's "Ad Soyad" value
 * was the salon name, copied verbatim by handle_new_user), so both the
 * dashboard greeting and the home page's "Merhaba, …" read a name that was
 * never a person's. Fixed by (a) greeting from the CURRENT profile
 * everywhere, never frozen sign-up metadata, (b) telling new sign-ups to
 * enter their own name, and (c) letting anyone correct their own stored
 * name from Hesabım (components/customer-account/profile-form.tsx), which
 * self-heals the greeting immediately.
 *
 *   A. source contracts — the home page reads the live profile, not
 *                          user_metadata; sign-up hints at a personal name;
 *                          the two i18n keys involved exist
 *   B. real database    — each of three different accounts in the SAME
 *                          salon is greeted by their OWN first name, never
 *                          the owner's, the salon's or a linked staff
 *                          record's; the production symptom is reproduced
 *                          as data (not a code bug) and self-corrects
 */

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("dashboard/home greeting reads the current profile name (source contracts)", () => {
  it("G1. the home page greets from the CURRENT profile, not the frozen sign-up metadata", () => {
    const home = codeOnly(read("app/[locale]/page.tsx"));
    expect(home).not.toMatch(/user_metadata/);
    expect(home).toContain("getMyAccountProfile()");
  });

  it("G2. the sign-up form tells people to enter their own name, tied to the field for assistive tech", () => {
    const form = read("components/auth/sign-up-form.tsx");
    expect(form).toContain('aria-describedby="fullName-hint"');
    expect(form).toContain('id="fullName-hint"');
  });

  it("G3. the two i18n keys this fix reads both exist in tr.json", () => {
    const messages = JSON.parse(read("messages/tr.json")) as Record<string, unknown>;
    const at = (path: string): unknown =>
      path.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], messages);
    expect(typeof at("Auth.signUp.fullNameHint")).toBe("string");
    expect(typeof at("Home.signedIn.greetingAnonymous")).toBe("string");
  });
});

describe("the dashboard greets the SIGNED-IN user's own profile name (real database)", () => {
  let tenant: TestTenant;
  let owner: TestUser;
  let manager: TestUser;
  let stylist: TestUser;
  let ownerClient: SupabaseClient;
  let managerClient: SupabaseClient;
  let stylistClient: SupabaseClient;

  // Deliberately DIFFERENT first names for every account, and a linked staff
  // record whose name differs from the linked user's own. Earlier fixtures
  // gave owner and manager the same first token, which would have hidden
  // exactly the cross-user leak this suite exists to rule out.
  beforeAll(async () => {
    owner = await createTestUser("greet-owner");
    manager = await createTestUser("greet-manager");
    stylist = await createTestUser("greet-stylist");
    tenant = await createTestTenant("account1-greeting", owner.id);
    await createTestMembershipFromTemplate(tenant.id, manager.id, "SALON_MANAGER");
    await createTestMembershipFromTemplate(tenant.id, stylist.id, "STYLIST");

    await testDb`update profiles set full_name = 'Aylin Kaya' where id = ${owner.id}`;
    await testDb`update profiles set full_name = 'Berkay Demir' where id = ${manager.id}`;
    await testDb`update profiles set full_name = 'Ceren Aydın' where id = ${stylist.id}`;

    // The stylist's account is linked to a staff record with a DIFFERENT name.
    const staff = await createStaffMember(tenant.id, "Deniz Personel");
    await testDb`
      update staff_members
      set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${stylist.id})
      where id = ${staff.id}
    `;

    ownerClient = await signInAs(owner);
    managerClient = await signInAs(manager);
    stylistClient = await signInAs(stylist);
  });

  afterAll(async () => {
    await cleanupTenants([tenant.id].filter(Boolean));
    await cleanupUsers([owner, manager, stylist].filter(Boolean).map((u) => u.id));
  });

  it("D1. Owner, Manager (no staff link) and staff-linked Personel are each greeted by their OWN first name — never the owner's, the salon's or the staff record's", async () => {
    expect(await getMyFirstName(ownerClient, owner.id)).toBe("Aylin");
    expect(await getMyFirstName(managerClient, manager.id)).toBe("Berkay");
    expect(await getMyFirstName(stylistClient, stylist.id)).toBe("Ceren"); // not "Deniz" (linked staff record)
  });

  it("D2. asking for someone else's name returns nothing: profiles are readable by their owner only, so no client can resolve another user's greeting", async () => {
    expect(await getMyFirstName(managerClient, owner.id)).toBeNull();
    expect(await getMyFirstName(stylistClient, manager.id)).toBeNull();
  });

  it("D3. the PROD symptom is DATA: a manager whose stored profile name is the salon's name is greeted with that name's first word", async () => {
    // Exactly what production holds for the affected account: the sign-up
    // form's 'Ad Soyad' value was the salon name, copied to profiles by the
    // handle_new_user trigger. The resolution code is correct; the value is not.
    await testDb`update profiles set full_name = 'Lale Güzellik Salonu' where id = ${manager.id}`;
    expect(await getMyFirstName(managerClient, manager.id)).toBe("Lale");
    // ...and the owner (a genuinely different person in the same salon) is unaffected.
    expect(await getMyFirstName(ownerClient, owner.id)).toBe("Aylin");
  });

  it("D4. correcting the name through the Hesabım form's RPC (update_my_account_profile) fixes the greeting immediately, for that account only", async () => {
    const { data, error } = await managerClient.rpc("update_my_account_profile", {
      p_full_name: "Tülin Demir",
      p_phone: "",
    });
    expect(error).toBeNull();
    expect((data as { fullName: string }).fullName).toBe("Tülin Demir");

    expect(await getMyFirstName(managerClient, manager.id)).toBe("Tülin");
    expect(await getMyFirstName(ownerClient, owner.id)).toBe("Aylin");
    expect(await getMyFirstName(stylistClient, stylist.id)).toBe("Ceren");
  });
});
