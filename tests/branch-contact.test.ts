import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";
import {
  isValidInstagramHandle,
  isValidLocationUrl,
  isValidWhatsappPhone,
  normalizeInstagramHandle,
  normalizeWhatsappPhone,
  toInstagramUrl,
  toWhatsappUrl,
} from "@/lib/modules/branches/normalize";
import { branchContactSchema } from "@/lib/modules/branches/schemas";

/**
 * Faz 2I.2F (Batch A, 20260904090000) — owner-managed branch contact/
 * social profile. Two layers, tested at the layer that actually
 * enforces each property (no test file in this codebase invokes a
 * "use server" action directly — see e.g. tests/phase2c-customers.test.ts
 * and tests/online-booking-settings.test.ts, which both test the RLS
 * policy / RPC directly instead):
 *
 *  - normalize.ts / schemas.ts: plain functions, no DB — validation and
 *    normalization logic (what updateBranchContactAction actually calls
 *    before writing) is proven directly, as pure unit tests.
 *  - branches_update_settings_manage RLS (20260816090004): the real
 *    authorization boundary for the write itself — proven via real
 *    Supabase client sessions, exactly like every other RLS-gated write
 *    in this codebase (updateSelfServicePolicyAction's own tenants
 *    UPDATE has no dedicated test beyond this same kind of RLS
 *    coverage either).
 */

describe("normalize.ts — pure helpers", () => {
  it("normalizeWhatsappPhone strips everything but digits and a leading +", () => {
    expect(normalizeWhatsappPhone("+90 533 874 18 29")).toBe("+905338741829");
    expect(normalizeWhatsappPhone("0533 874 18 29")).toBe("05338741829");
    expect(normalizeWhatsappPhone("(533) 874-18-29")).toBe("5338741829");
  });

  it("isValidWhatsappPhone accepts 8-15 digits, optional leading +, rejects short/garbled input", () => {
    expect(isValidWhatsappPhone("+905338741829")).toBe(true);
    expect(isValidWhatsappPhone("5338741829")).toBe(true);
    expect(isValidWhatsappPhone("1234567")).toBe(false); // 7 digits, too short
    expect(isValidWhatsappPhone("")).toBe(false);
    expect(isValidWhatsappPhone("+")).toBe(false);
  });

  it("toWhatsappUrl strips the leading + for the wa.me link — owner never constructs this URL", () => {
    expect(toWhatsappUrl("+905338741829")).toBe("https://wa.me/905338741829");
    expect(toWhatsappUrl("5338741829")).toBe("https://wa.me/5338741829");
  });

  it("normalizeInstagramHandle strips a single leading @ only", () => {
    expect(normalizeInstagramHandle("@Gokhanilhanhairstudio")).toBe("Gokhanilhanhairstudio");
    expect(normalizeInstagramHandle("Gokhanilhanhairstudio")).toBe("Gokhanilhanhairstudio");
  });

  it("isValidInstagramHandle accepts letters/digits/./_ up to 30 chars, rejects a pasted URL or spaces", () => {
    expect(isValidInstagramHandle("Gokhanilhanhairstudio")).toBe(true);
    expect(isValidInstagramHandle("test.handle_123")).toBe(true);
    expect(isValidInstagramHandle("https://instagram.com/foo")).toBe(false); // slash + colon
    expect(isValidInstagramHandle("has space")).toBe(false);
    expect(isValidInstagramHandle("a".repeat(31))).toBe(false); // over 30 chars
  });

  it("toInstagramUrl builds the public profile link from the stored handle", () => {
    expect(toInstagramUrl("Gokhanilhanhairstudio")).toBe("https://instagram.com/Gokhanilhanhairstudio");
  });

  it("isValidLocationUrl accepts http(s) URLs including a share.google link, rejects other schemes and garbage", () => {
    expect(isValidLocationUrl("https://share.google/EcHzpDuVyTcqqmKYV")).toBe(true);
    expect(isValidLocationUrl("https://maps.app.goo.gl/abc123")).toBe(true);
    expect(isValidLocationUrl("http://example.com/map")).toBe(true);
    expect(isValidLocationUrl("javascript:alert(1)")).toBe(false);
    expect(isValidLocationUrl("mailto:x@example.com")).toBe(false);
    expect(isValidLocationUrl("not a url")).toBe(false);
    expect(isValidLocationUrl("")).toBe(false);
  });
});

describe("branchContactSchema — validation", () => {
  const base = {
    // A valid-shaped (version 4) UUID — Zod's .uuid() checks the
    // version/variant nibbles, so an all-zeros placeholder like
    // "00000000-...-000000000001" is correctly rejected as malformed.
    branchId: "11111111-1111-4111-8111-111111111111",
    tenantSlug: "test-salon",
  };

  it("accepts a fully valid submission", () => {
    const result = branchContactSchema.safeParse({
      ...base,
      address: "Yenikent Ak Sok. No:3, Gönyeli, Lefkoşa",
      phone: "+90 533 874 18 29",
      whatsappPhone: "+90 533 874 18 29",
      instagramHandle: "@Gokhanilhanhairstudio",
      locationUrl: "https://share.google/EcHzpDuVyTcqqmKYV",
    });
    expect(result.success).toBe(true);
  });

  it("accepts every optional field blank/omitted", () => {
    const result = branchContactSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("rejects a malformed WhatsApp number", () => {
    const result = branchContactSchema.safeParse({ ...base, whatsappPhone: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects an Instagram field that's actually a pasted profile URL", () => {
    const result = branchContactSchema.safeParse({ ...base, instagramHandle: "https://instagram.com/gokhan" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-http(s) location URL", () => {
    const result = branchContactSchema.safeParse({ ...base, locationUrl: "javascript:alert(1)" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed (non-URL) location value", () => {
    const result = branchContactSchema.safeParse({ ...base, locationUrl: "just some text" });
    expect(result.success).toBe(false);
  });
});

describe("branches contact fields — settings.manage governs writes (RLS)", () => {
  let tenant: TestTenant;
  let tenantB: TestTenant;
  let owner: TestUser;
  let ownerB: TestUser;
  let limitedUser: TestUser;
  let ownerClient: SupabaseClient;
  let ownerBClient: SupabaseClient;
  let branchId: string;

  beforeAll(async () => {
    owner = await createTestUser("p2i2f-owner");
    ownerB = await createTestUser("p2i2f-owner-b");
    limitedUser = await createTestUser("p2i2f-limited");

    tenant = await createTestTenant("test-p2i2f", owner.id);
    tenantB = await createTestTenant("test-p2i2f-b", ownerB.id);

    // Same non-settings.manage permission choice as
    // tests/online-booking-settings.test.ts's own limitedUser fixture.
    const limitedRole = await createRoleForTenant(tenant.id, "Sınırlı Rol", ["appointments.view"]);
    await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status)
      values (${tenant.id}, ${limitedUser.id}, ${limitedRole}, 'active')`;

    ownerClient = await signInAs(owner);
    ownerBClient = await signInAs(ownerB);

    branchId = await createBranch(tenant.id, "Ana Şube");
  }, 60000);

  afterAll(async () => {
    await ownerClient.auth.signOut();
    await ownerBClient.auth.signOut();
    await cleanupTenants([tenant.id, tenantB.id]);
    await cleanupUsers([owner.id, ownerB.id, limitedUser.id]);
  });

  async function currentContact(id: string) {
    const [row] = await testDb<
      { address: string | null; whatsapp_phone: string | null; instagram_handle: string | null; location_url: string | null }[]
    >`select address, whatsapp_phone, instagram_handle, location_url from branches where id = ${id}`;
    return row ?? null;
  }

  it("owner (settings.manage) can set the contact fields", async () => {
    const { error } = await ownerClient
      .from("branches")
      .update({
        address: "Yenikent Ak Sok. No:3, Gönyeli, Lefkoşa",
        whatsapp_phone: "+905338741829",
        instagram_handle: "test_pilot_salon",
        location_url: "https://share.google/EcHzpDuVyTcqqmKYV",
      })
      .eq("id", branchId);
    expect(error).toBeNull();

    const row = await currentContact(branchId);
    expect(row?.address).toBe("Yenikent Ak Sok. No:3, Gönyeli, Lefkoşa");
    expect(row?.whatsapp_phone).toBe("+905338741829");
    expect(row?.instagram_handle).toBe("test_pilot_salon");
    expect(row?.location_url).toBe("https://share.google/EcHzpDuVyTcqqmKYV");
  });

  it("owner can clear a field back to null", async () => {
    const { error } = await ownerClient.from("branches").update({ instagram_handle: null }).eq("id", branchId);
    expect(error).toBeNull();
    const row = await currentContact(branchId);
    expect(row?.instagram_handle).toBeNull();
  });

  it("a real member without settings.manage: the row is left unchanged", async () => {
    // Same "RLS's UPDATE USING clause filters rather than throws" ground
    // truth as tests/phase2c-customers.test.ts's identical finding —
    // the row's actual state afterward is the real assertion, not
    // merely the presence/absence of a client-side error.
    const before = await currentContact(branchId);
    const limitedClient = await signInAs(limitedUser);
    await limitedClient.from("branches").update({ address: "Yetkisiz Değişiklik" }).eq("id", branchId);
    await limitedClient.auth.signOut();
    const after = await currentContact(branchId);
    expect(after?.address).toBe(before?.address);
    expect(after?.address).not.toBe("Yetkisiz Değişiklik");
  });

  it("cross-tenant: tenant B's owner cannot modify tenant A's branch (forged branch id)", async () => {
    const before = await currentContact(branchId);
    await ownerBClient.from("branches").update({ address: "Yetkisiz Şube Değişikliği" }).eq("id", branchId);
    const after = await currentContact(branchId);
    expect(after?.address).toBe(before?.address);
    expect(after?.address).not.toBe("Yetkisiz Şube Değişikliği");
  });

  it("anon cannot even reach the table — rejected at the grant level, not just RLS", async () => {
    const before = await currentContact(branchId);
    const { error } = await anonClient().from("branches").update({ address: "Anon Değişikliği" }).eq("id", branchId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501"); // insufficient_privilege — no grant at all, matches branches' own table grant (authenticated only)
    const after = await currentContact(branchId);
    expect(after?.address).toBe(before?.address);
  });
});
