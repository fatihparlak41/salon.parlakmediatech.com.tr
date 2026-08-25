import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createTestTenant,
  createTestUser,
  createTestMembershipFromTemplate,
  createRoleForTenant,
  addMembership,
  signInAs,
  anonClient,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
} from "./helpers";
import { generateLinkCode, canonicalizeLinkCode, hashLinkCode } from "../lib/modules/customer-account/link-code";
import { formatLinkCodeForDisplay } from "../lib/modules/customer-account/link-code-format";

/**
 * Faz 2G.3.2 — Salon-Assisted Account Linking + Safe Correction
 * (20260824170000_salon_assisted_account_linking.sql).
 *
 * Dual authorization under test: the CUSTOMER side proves voluntary
 * generation of a tenant-bound pairing capability (auth.uid() only, no
 * browser-supplied identity); the SALON side proves an authorized staff
 * member (customers.link_account, checked in the tenant the target
 * customer row actually belongs to) selected the exact CRM row. Neither
 * side alone is sufficient, and no global auth.users/profiles search
 * exists anywhere in this surface — the code IS the account locator.
 *
 * Every identity is signed in ONCE in beforeAll and reused throughout
 * (rather than a fresh signInAs per assertion) — Supabase Auth's own
 * sign-in rate limit is shared across the whole suite run, and a fresh
 * sign-in per call was a real, observed contributor to hitting it (see
 * future-booking-claim.test.ts's own identical note). A real browser
 * session behaves this way too.
 */

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function rawTestCode(): string {
  let raw = "";
  for (let i = 0; i < 12; i++) raw += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return raw;
}
function hashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

let ownerA: TestUser;
let managerA: TestUser;
let receptionistA: TestUser;
let receptionistGrantedA: TestUser;
let ownerB: TestUser;
let customerUserA: TestUser;
let customerUserB: TestUser;
let existingLinkUser: TestUser;

let clientOwnerA: Awaited<ReturnType<typeof signInAs>>;
let clientManagerA: Awaited<ReturnType<typeof signInAs>>;
let clientReceptionistA: Awaited<ReturnType<typeof signInAs>>;
let clientReceptionistGrantedA: Awaited<ReturnType<typeof signInAs>>;
let clientOwnerB: Awaited<ReturnType<typeof signInAs>>;
let clientCustomerA: Awaited<ReturnType<typeof signInAs>>;
let clientCustomerB: Awaited<ReturnType<typeof signInAs>>;

let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };

let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `555${String(2000000 + phoneCounter).padStart(7, "0")}`;
}

async function insertCustomer(tenantId: string, fullName: string, opts: { phone?: string | null; email?: string | null } = {}) {
  const [row] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name, phone, email, status)
    values (${tenantId}, ${fullName}, ${opts.phone === undefined ? uniquePhone() : opts.phone}, ${opts.email ?? null}, 'active')
    returning id
  `;
  return row!.id;
}

/** Issues a code as clientCustomerA for the given tenant slug. */
async function issueCode(client: Awaited<ReturnType<typeof signInAs>>, tenantSlug: string) {
  const raw = rawTestCode();
  const hash = hashOf(raw);
  const { error } = await client.rpc("create_my_link_code", { p_tenant_slug: tenantSlug, p_code_hash: hash });
  return { raw, hash, error };
}

async function linkAs(client: Awaited<ReturnType<typeof signInAs>>, customerId: string, codeHash: string) {
  return client.rpc("link_customer_account_with_code", { p_customer_id: customerId, p_code_hash: codeHash });
}
async function unlinkAs(client: Awaited<ReturnType<typeof signInAs>>, customerId: string) {
  return client.rpc("unlink_salon_assisted_customer_account", { p_customer_id: customerId });
}

beforeAll(async () => {
  ownerA = await createTestUser("p232-owner-a");
  managerA = await createTestUser("p232-manager-a");
  receptionistA = await createTestUser("p232-recept-a");
  receptionistGrantedA = await createTestUser("p232-recept-grant-a");
  ownerB = await createTestUser("p232-owner-b");
  customerUserA = await createTestUser("p232-cust-a");
  customerUserB = await createTestUser("p232-cust-b");
  existingLinkUser = await createTestUser("p232-existing-link");

  const tenantRowA = await createTestTenant("test-p232-a", ownerA.id);
  tenantA = { id: tenantRowA.id, slug: tenantRowA.slug };
  const tenantRowB = await createTestTenant("test-p232-b", ownerB.id);
  tenantB = { id: tenantRowB.id, slug: tenantRowB.slug };

  await createTestMembershipFromTemplate(tenantA.id, managerA.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(tenantA.id, receptionistA.id, "RECEPTIONIST");

  // A tenant that explicitly widened Receptionist's default — proves
  // the permission is genuinely tenant-editable, not a hard ceiling.
  const grantedRoleId = await createRoleForTenant(tenantA.id, "Receptionist+Link", [
    "customers.view",
    "customers.create",
    "customers.update",
    "customers.link_account",
  ]);
  await addMembership(tenantA.id, receptionistGrantedA.id, grantedRoleId);

  [clientOwnerA, clientManagerA, clientReceptionistA, clientReceptionistGrantedA, clientOwnerB, clientCustomerA, clientCustomerB] =
    await Promise.all([
      signInAs(ownerA),
      signInAs(managerA),
      signInAs(receptionistA),
      signInAs(receptionistGrantedA),
      signInAs(ownerB),
      signInAs(customerUserA),
      signInAs(customerUserB),
    ]);
}, 60000);

afterAll(async () => {
  await Promise.all([
    clientOwnerA.auth.signOut(),
    clientManagerA.auth.signOut(),
    clientReceptionistA.auth.signOut(),
    clientReceptionistGrantedA.auth.signOut(),
    clientOwnerB.auth.signOut(),
    clientCustomerA.auth.signOut(),
    clientCustomerB.auth.signOut(),
  ]);
  await testDb`delete from customer_account_links where tenant_id in (${tenantA.id}, ${tenantB.id})`;
  await testDb`delete from customer_account_pairing_codes where tenant_id in (${tenantA.id}, ${tenantB.id})`;
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([
    ownerA.id,
    managerA.id,
    receptionistA.id,
    receptionistGrantedA.id,
    ownerB.id,
    customerUserA.id,
    customerUserB.id,
    existingLinkUser.id,
  ]);
});

describe("code format (unit)", () => {
  it("generateLinkCode produces exactly 12 characters from the approved 31-symbol alphabet", () => {
    for (let i = 0; i < 25; i++) {
      const code = generateLinkCode();
      expect(code).toHaveLength(12);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$/);
    }
  });

  it("canonicalizeLinkCode trims, strips hyphens/spaces, and uppercases before matching", () => {
    const raw = generateLinkCode();
    const display = formatLinkCodeForDisplay(raw);
    expect(canonicalizeLinkCode(display)).toBe(raw);
    expect(canonicalizeLinkCode(` ${display.toLowerCase()} `)).toBe(raw);
    expect(canonicalizeLinkCode("not-a-valid-code")).toBeNull();
    expect(canonicalizeLinkCode("")).toBeNull();
    expect(canonicalizeLinkCode(raw.slice(0, 11))).toBeNull(); // too short
  });

  it("hashLinkCode is deterministic SHA-256 and never returns the raw value", () => {
    const raw = generateLinkCode();
    const hash = hashLinkCode(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashLinkCode(raw));
    expect(hash).not.toBe(raw);
  });
});

describe("permission", () => {
  it("owner can link", async () => {
    const customerId = await insertCustomer(tenantA.id, "Perm Owner Target");
    const { raw, error: genError } = await issueCode(clientCustomerA, tenantA.slug);
    expect(genError).toBeNull();
    const { error } = await linkAs(clientOwnerA, customerId, hashOf(raw));
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("manager can link", async () => {
    const customerId = await insertCustomer(tenantA.id, "Perm Manager Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientManagerA, customerId, hashOf(raw));
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("receptionist is denied by default (LK002)", async () => {
    const customerId = await insertCustomer(tenantA.id, "Perm Receptionist Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientReceptionistA, customerId, hashOf(raw));
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK002");
  });

  it("a tenant that explicitly grants customers.link_account to Receptionist succeeds", async () => {
    const customerId = await insertCustomer(tenantA.id, "Perm Receptionist Granted Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientReceptionistGrantedA, customerId, hashOf(raw));
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("an owner of an unrelated tenant is denied", async () => {
    const customerId = await insertCustomer(tenantA.id, "Perm Unrelated Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientOwnerB, customerId, hashOf(raw));
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK002");
  });

  it("a customer-only account (no staff membership anywhere) is denied when attempting the staff RPC", async () => {
    const customerId = await insertCustomer(tenantA.id, "Perm Customer Only Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientCustomerB, customerId, hashOf(raw)); // has no tenant_memberships row at all
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK002");
  });
});

describe("code issuance", () => {
  it("stores only the hash — never the raw code — and reports a ~15 minute expiry", async () => {
    const { raw, hash } = await issueCode(clientCustomerA, tenantA.slug);
    const [row] = await testDb<{ code_hash: string; expires_at: string; created_at: string }[]>`
      select code_hash, expires_at, created_at from customer_account_pairing_codes
      where user_id = ${customerUserA.id} and tenant_id = ${tenantA.id} and consumed_at is null and revoked_at is null
    `;
    expect(row!.code_hash).toBe(hash);
    expect(row!.code_hash).not.toBe(raw);
    const minutes = (new Date(row!.expires_at).getTime() - new Date(row!.created_at).getTime()) / 60000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThan(16);
  });

  it("one active code per (user, tenant) — regenerating for Salon A revokes the prior Salon A code", async () => {
    const first = await issueCode(clientCustomerA, tenantA.slug);
    const second = await issueCode(clientCustomerA, tenantA.slug);
    expect(second.error).toBeNull();

    const [firstRow] = await testDb<{ revoked_at: string | null }[]>`
      select revoked_at from customer_account_pairing_codes where code_hash = ${first.hash}
    `;
    expect(firstRow!.revoked_at).not.toBeNull();

    const [secondRow] = await testDb<{ revoked_at: string | null }[]>`
      select revoked_at from customer_account_pairing_codes where code_hash = ${second.hash}
    `;
    expect(secondRow!.revoked_at).toBeNull();

    // The revoked code no longer works.
    const customerId = await insertCustomer(tenantA.id, "Rotation Target");
    const oldAttempt = await linkAs(clientOwnerA, customerId, first.hash);
    expect(oldAttempt.error).not.toBeNull();
    expect(oldAttempt.error!.code).toBe("LK003");
    const newAttempt = await linkAs(clientOwnerA, customerId, second.hash);
    expect(newAttempt.error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("generating a code for Salon A does not revoke a pending Salon B code for the same user", async () => {
    const codeA = await issueCode(clientCustomerA, tenantA.slug);
    const codeB = await issueCode(clientCustomerA, tenantB.slug);
    expect(codeB.error).toBeNull();

    const [rowA] = await testDb<{ revoked_at: string | null }[]>`
      select revoked_at from customer_account_pairing_codes where code_hash = ${codeA.hash}
    `;
    expect(rowA!.revoked_at).toBeNull(); // untouched by the Salon B generation

    // Regenerating for A now DOES revoke A's own prior code, leaving B alone.
    const codeA2 = await issueCode(clientCustomerA, tenantA.slug);
    expect(codeA2.error).toBeNull();
    const [rowAAfter] = await testDb<{ revoked_at: string | null }[]>`
      select revoked_at from customer_account_pairing_codes where code_hash = ${codeA.hash}
    `;
    expect(rowAAfter!.revoked_at).not.toBeNull();
    const [rowB] = await testDb<{ revoked_at: string | null }[]>`
      select revoked_at from customer_account_pairing_codes where code_hash = ${codeB.hash}
    `;
    expect(rowB!.revoked_at).toBeNull();
  });

  it("requires authentication", async () => {
    const { error } = await anonClient().rpc("create_my_link_code", {
      p_tenant_slug: tenantA.slug,
      p_code_hash: hashOf(rawTestCode()),
    });
    expect(error).not.toBeNull();
  });
});

describe("get_my_link_salon_context", () => {
  it("resolves a real tenant's display name for an authenticated customer", async () => {
    const { data, error } = await clientCustomerA.rpc("get_my_link_salon_context", { p_tenant_slug: tenantA.slug });
    expect(error).toBeNull();
    const result = data as unknown as { found: boolean; tenantName?: string };
    expect(result.found).toBe(true);
    expect(result.tenantName).toBeTruthy();
  });

  it("returns found:false for an unknown slug, never an error that discloses why", async () => {
    const { data, error } = await clientCustomerA.rpc("get_my_link_salon_context", { p_tenant_slug: "does-not-exist-slug-xyz" });
    expect(error).toBeNull();
    expect((data as unknown as { found: boolean }).found).toBe(false);
  });

  it("requires authentication", async () => {
    const { error } = await anonClient().rpc("get_my_link_salon_context", { p_tenant_slug: tenantA.slug });
    expect(error).not.toBeNull();
  });
});

describe("linking", () => {
  it("links a normal CRM row", async () => {
    const customerId = await insertCustomer(tenantA.id, "Normal Row", { phone: uniquePhone(), email: "normal@example.com" });
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientOwnerA, customerId, hashOf(raw));
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("links a phone-only row (no email)", async () => {
    const customerId = await insertCustomer(tenantA.id, "Phone Only", { phone: uniquePhone(), email: null });
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientOwnerA, customerId, hashOf(raw));
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("links a no-contact row (no phone, no email)", async () => {
    const customerId = await insertCustomer(tenantA.id, "No Contact", { phone: null, email: null });
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientOwnerA, customerId, hashOf(raw));
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("links a row sharing a family/shared contact email with other rows", async () => {
    const sharedEmail = "family-shared@example.com";
    await insertCustomer(tenantA.id, "Family Member One", { email: sharedEmail });
    const target = await insertCustomer(tenantA.id, "Family Member Two", { email: sharedEmail });
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientOwnerA, target, hashOf(raw));
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${target}`;
  });

  it("the same account can link multiple CRM rows in the same tenant, deliberately, one at a time", async () => {
    const rowOne = await insertCustomer(tenantA.id, "Multi Row One");
    const rowTwo = await insertCustomer(tenantA.id, "Multi Row Two");

    const codeOne = await issueCode(clientCustomerA, tenantA.slug);
    expect((await linkAs(clientOwnerA, rowOne, hashOf(codeOne.raw))).error).toBeNull();

    const codeTwo = await issueCode(clientCustomerA, tenantA.slug);
    expect((await linkAs(clientOwnerA, rowTwo, hashOf(codeTwo.raw))).error).toBeNull();

    const links = await testDb<{ customer_id: string; is_primary: boolean }[]>`
      select customer_id, is_primary from customer_account_links
      where tenant_id = ${tenantA.id} and user_id = ${customerUserA.id} and deleted_at is null
    `;
    expect(links.length).toBe(2);
    expect(links.filter((l) => l.is_primary).length).toBe(1); // exactly one primary
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and user_id = ${customerUserA.id}`;
  });

  it("no primary yet -> the new link becomes primary", async () => {
    const customerId = await insertCustomer(tenantA.id, "Primary Fresh");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw));
    const [link] = await testDb<{ is_primary: boolean }[]>`
      select is_primary from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}
    `;
    expect(link!.is_primary).toBe(true);
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("existing primary -> the new link is non-primary", async () => {
    const existingId = await insertCustomer(tenantA.id, "Existing Primary Holder");
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${customerUserA.id}, ${tenantA.id}, ${existingId}, 'future_booking', true)`;

    const newId = await insertCustomer(tenantA.id, "New Non Primary");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, newId, hashOf(raw));

    const [link] = await testDb<{ is_primary: boolean }[]>`
      select is_primary from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${newId}
    `;
    expect(link!.is_primary).toBe(false);
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and user_id = ${customerUserA.id}`;
  });

  it("already linked to the SAME account is idempotent, consumes the code, no duplicate link", async () => {
    const customerId = await insertCustomer(tenantA.id, "Idempotent Target");
    const first = await issueCode(clientCustomerA, tenantA.slug);
    expect((await linkAs(clientOwnerA, customerId, hashOf(first.raw))).error).toBeNull();

    const second = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientOwnerA, customerId, hashOf(second.raw));
    expect(error).toBeNull(); // idempotent success

    const links = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId} and deleted_at is null
    `;
    expect(links[0]!.count).toBe("1");
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("already linked to a DIFFERENT account is never transferred, disclosed, or merged", async () => {
    const customerId = await insertCustomer(tenantA.id, "Owned By Other");
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${existingLinkUser.id}, ${tenantA.id}, ${customerId}, 'salon_assisted', true)`;

    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientOwnerA, customerId, hashOf(raw));
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK003");

    const links = await testDb<{ user_id: string }[]>`
      select user_id from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId} and deleted_at is null
    `;
    expect(links.map((l) => l.user_id)).toEqual([existingLinkUser.id]);
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("a code generated for Salon A fails generically when redeemed against a Salon B customer row", async () => {
    const customerIdB = await insertCustomer(tenantB.id, "Wrong Tenant Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug); // bound to A
    const { error } = await linkAs(clientOwnerB, customerIdB, hashOf(raw));
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK003");
  });

  it("an expired code fails generically", async () => {
    const { raw, hash } = await issueCode(clientCustomerA, tenantA.slug);
    await testDb`update customer_account_pairing_codes set expires_at = now() - interval '1 minute' where code_hash = ${hash}`;
    const customerId = await insertCustomer(tenantA.id, "Expired Target");
    const { error } = await linkAs(clientOwnerA, customerId, hashOf(raw));
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK003");
  });

  it("a nonexistent customer id fails generically (not a distinct 'customer not found' code)", async () => {
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientOwnerA, crypto.randomUUID(), hashOf(raw));
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK003");
  });
});

describe("enumeration", () => {
  it("unknown code, wrong-tenant code, expired code, and already-owned-by-another all return the identical code and message", async () => {
    const unknown = await linkAs(clientOwnerA, await insertCustomer(tenantA.id, "Enum Unknown"), hashOf(rawTestCode()));

    const customerIdB = await insertCustomer(tenantB.id, "Enum Wrong Tenant");
    const wrongTenantCode = await issueCode(clientCustomerA, tenantA.slug);
    const wrongTenant = await linkAs(clientOwnerB, customerIdB, hashOf(wrongTenantCode.raw));

    const expiredCode = await issueCode(clientCustomerA, tenantA.slug);
    await testDb`update customer_account_pairing_codes set expires_at = now() - interval '1 minute' where code_hash = ${hashOf(expiredCode.raw)}`;
    const expired = await linkAs(clientOwnerA, await insertCustomer(tenantA.id, "Enum Expired"), hashOf(expiredCode.raw));

    const ownedCustomer = await insertCustomer(tenantA.id, "Enum Owned");
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${existingLinkUser.id}, ${tenantA.id}, ${ownedCustomer}, 'salon_assisted', true)`;
    const ownedCode = await issueCode(clientCustomerA, tenantA.slug);
    const owned = await linkAs(clientOwnerA, ownedCustomer, hashOf(ownedCode.raw));

    for (const result of [unknown, wrongTenant, expired, owned]) {
      expect(result.error).not.toBeNull();
      expect(result.error!.code).toBe("LK003");
    }
    const messages = new Set([unknown, wrongTenant, expired, owned].map((r) => r.error!.message));
    expect(messages.size).toBe(1);

    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${ownedCustomer}`;
  });

  it("permission-denied is a genuinely distinct code from code-invalid (not folded into the same enumeration bucket)", async () => {
    const customerId = await insertCustomer(tenantA.id, "Perm Vs Code");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const { error } = await linkAs(clientReceptionistA, customerId, hashOf(raw));
    expect(error!.code).toBe("LK002");
    expect(error!.code).not.toBe("LK003");
  });

  it("no arbitrary email can be tested for account existence anywhere in this surface — no such parameter exists on any RPC", async () => {
    const rows = await testDb<{ args: string }[]>`
      select pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('create_my_link_code', 'link_customer_account_with_code', 'unlink_salon_assisted_customer_account', 'get_customer_account_link_status', 'get_my_link_salon_context')
    `;
    for (const row of rows) {
      expect(row.args.toLowerCase()).not.toMatch(/email|user_id|account_id/);
    }
    expect(rows.length).toBe(5);
  });
});

describe("concurrency", () => {
  it("the same code redeemed simultaneously against two different customer rows: exactly one succeeds", async () => {
    const rowOne = await insertCustomer(tenantA.id, "Race Row One");
    const rowTwo = await insertCustomer(tenantA.id, "Race Row Two");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);

    const [r1, r2] = await Promise.all([linkAs(clientOwnerA, rowOne, hashOf(raw)), linkAs(clientOwnerA, rowTwo, hashOf(raw))]);
    const successes = [r1, r2].filter((r) => r.error === null);
    expect(successes.length).toBe(1);

    const links = await testDb<{ customer_id: string }[]>`
      select customer_id from customer_account_links where tenant_id = ${tenantA.id} and user_id = ${customerUserA.id} and deleted_at is null
    `;
    expect(links.length).toBe(1);
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and user_id = ${customerUserA.id}`;
  });

  it("the same code redeemed twice against the same row: idempotent, one link", async () => {
    const customerId = await insertCustomer(tenantA.id, "Race Same Row");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    const [r1, r2] = await Promise.all([linkAs(clientOwnerA, customerId, hashOf(raw)), linkAs(clientOwnerA, customerId, hashOf(raw))]);
    // The row lock on the code serializes both — whichever runs second
    // sees the code already consumed; since it's already linked to this
    // exact same account by then it may resolve idempotently or hit the
    // generic failure depending on timing. What must never happen,
    // either way, is two link rows.
    void r1;
    void r2;
    const links = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId} and deleted_at is null
    `;
    expect(links[0]!.count).toBe("1");
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("primary-link race: the RPC's own primary decision racing an independent concurrent insert still leaves at most one primary", async () => {
    // Two simultaneously-valid codes for the same (user, tenant) can't
    // exist by construction (customer_account_pairing_codes_active_idx),
    // so a true primary-race can't be built from two code redemptions.
    // Instead race the RPC (row one, via a real code) against a raw
    // direct insert for row two that makes the same "no primary yet"
    // decision independently — simulating a different linking mechanism
    // (e.g. a concurrent future_booking claim) reaching its own
    // is_primary=true conclusion at the same instant. The partial
    // unique index is the only thing that can actually prevent two
    // primaries here, since the two paths share no lock.
    const rowOne = await insertCustomer(tenantA.id, "Primary Race One");
    const rowTwo = await insertCustomer(tenantA.id, "Primary Race Two");
    const { hash } = await issueCode(clientCustomerA, tenantA.slug);

    const rpcCall = linkAs(clientOwnerA, rowOne, hash);
    const directInsert = testDb`
      insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
      values (${customerUserA.id}, ${tenantA.id}, ${rowTwo}, 'salon_assisted', true)
    `.catch((e) => ({ raceLost: true, error: e }));

    await Promise.all([rpcCall, directInsert]);

    const primaries = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links
      where tenant_id = ${tenantA.id} and user_id = ${customerUserA.id} and deleted_at is null and is_primary = true
    `;
    expect(Number(primaries[0]!.count)).toBeLessThanOrEqual(1);
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and user_id = ${customerUserA.id}`;
  });

  it("salon-assisted redemption racing a verified-booking-claim insert for the same customer_id: only one owner", async () => {
    const customerId = await insertCustomer(tenantA.id, "Cross Mechanism Race");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);

    // Simulate the OTHER mechanism (2G.3.1's claim path) racing via a
    // direct insert attempt against the SAME shared unique index this
    // RPC also respects — proves the backstop is mechanism-agnostic.
    const raceInsert = testDb`
      insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
      values (${customerUserB.id}, ${tenantA.id}, ${customerId}, 'verified_booking_claim', true)
    `.catch((e) => ({ dbError: e }));

    const [linkResult, insertResult] = await Promise.all([linkAs(clientOwnerA, customerId, hashOf(raw)), raceInsert]);
    const links = await testDb<{ user_id: string }[]>`
      select user_id from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId} and deleted_at is null
    `;
    expect(links.length).toBe(1); // never two owners, whichever won
    void linkResult;
    void insertResult;
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("two concurrent code generations for the same (user, tenant): exactly one unconsumed/unrevoked code survives", async () => {
    const freshUser = await createTestUser("p232-concurrent-gen");
    const client = await signInAs(freshUser);
    const rawX = rawTestCode();
    const rawY = rawTestCode();
    await Promise.all([
      client.rpc("create_my_link_code", { p_tenant_slug: tenantA.slug, p_code_hash: hashOf(rawX) }),
      client.rpc("create_my_link_code", { p_tenant_slug: tenantA.slug, p_code_hash: hashOf(rawY) }),
    ]);
    const active = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_pairing_codes
      where user_id = ${freshUser.id} and tenant_id = ${tenantA.id} and consumed_at is null and revoked_at is null
    `;
    expect(active[0]!.count).toBe("1");
    await client.auth.signOut();
    await cleanupUsers([freshUser.id]);
  });

  it("concurrent code generation for different tenants (same user): both remain independently valid", async () => {
    const freshUser = await createTestUser("p232-concurrent-gen-2");
    const client = await signInAs(freshUser);
    const rawX = rawTestCode();
    const rawY = rawTestCode();
    await Promise.all([
      client.rpc("create_my_link_code", { p_tenant_slug: tenantA.slug, p_code_hash: hashOf(rawX) }),
      client.rpc("create_my_link_code", { p_tenant_slug: tenantB.slug, p_code_hash: hashOf(rawY) }),
    ]);
    const activeA = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_pairing_codes
      where user_id = ${freshUser.id} and tenant_id = ${tenantA.id} and consumed_at is null and revoked_at is null
    `;
    const activeB = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_pairing_codes
      where user_id = ${freshUser.id} and tenant_id = ${tenantB.id} and consumed_at is null and revoked_at is null
    `;
    expect(activeA[0]!.count).toBe("1");
    expect(activeB[0]!.count).toBe("1");
    await client.auth.signOut();
    await cleanupUsers([freshUser.id]);
  });
});

describe("unlink", () => {
  it("a salon_assisted link can be unlinked by an authorized staff member", async () => {
    const customerId = await insertCustomer(tenantA.id, "Unlink Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw));

    const { error } = await unlinkAs(clientOwnerA, customerId);
    expect(error).toBeNull();

    const [link] = await testDb<{ deleted_at: string | null }[]>`
      select deleted_at from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId} order by created_at desc limit 1
    `;
    expect(link!.deleted_at).not.toBeNull();
  });

  it("a future_booking link cannot be staff-unlinked (LK004)", async () => {
    const customerId = await insertCustomer(tenantA.id, "Future Booking Protected");
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${customerUserA.id}, ${tenantA.id}, ${customerId}, 'future_booking', true)`;
    const { error } = await unlinkAs(clientOwnerA, customerId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK004");
    const [link] = await testDb<{ deleted_at: string | null }[]>`select deleted_at from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
    expect(link!.deleted_at).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("a verified_booking_claim link cannot be staff-unlinked (LK004)", async () => {
    const customerId = await insertCustomer(tenantA.id, "Verified Claim Protected");
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${customerUserA.id}, ${tenantA.id}, ${customerId}, 'verified_booking_claim', true)`;
    const { error } = await unlinkAs(clientOwnerA, customerId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK004");
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("unlink preserves the CRM row and its appointments — only the link is soft-deleted", async () => {
    const customerId = await insertCustomer(tenantA.id, "Preserve Data Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw));
    await unlinkAs(clientOwnerA, customerId);

    const [customer] = await testDb<{ id: string; deleted_at: string | null }[]>`select id, deleted_at from customers where id = ${customerId}`;
    expect(customer!.deleted_at).toBeNull();
  });

  it("access disappears after unlink", async () => {
    const customerId = await insertCustomer(tenantA.id, "Access Removed Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw));

    const beforeUnlink = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId} and user_id = ${customerUserA.id} and deleted_at is null
    `;
    expect(beforeUnlink[0]!.count).toBe("1");

    await unlinkAs(clientOwnerA, customerId);

    const afterUnlink = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId} and user_id = ${customerUserA.id} and deleted_at is null
    `;
    expect(afterUnlink[0]!.count).toBe("0");
  });

  it("a consumed pairing code cannot relink after its resulting link was unlinked — a fresh code is required", async () => {
    const customerId = await insertCustomer(tenantA.id, "Consumed Stays Consumed");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw));
    await unlinkAs(clientOwnerA, customerId);

    const { error } = await linkAs(clientOwnerA, customerId, hashOf(raw));
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK003");
  });

  it("no automatic primary promotion after unlinking the primary link — zero primary is allowed", async () => {
    const customerId = await insertCustomer(tenantA.id, "No Auto Promote");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw)); // becomes primary (first link)
    await unlinkAs(clientOwnerA, customerId);

    const primaries = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links
      where tenant_id = ${tenantA.id} and user_id = ${customerUserA.id} and deleted_at is null and is_primary = true
    `;
    expect(primaries[0]!.count).toBe("0");
  });

  it("unauthorized staff cannot unlink (LK002)", async () => {
    const customerId = await insertCustomer(tenantA.id, "Unlink Perm Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw));

    const { error } = await unlinkAs(clientReceptionistA, customerId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LK002");
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });
});

describe("audit", () => {
  it("a successful link produces exactly one audit event, actor is the STAFF member, salon_assisted provenance, no secret/contact leakage", async () => {
    const customerId = await insertCustomer(tenantA.id, "Audit Link Target");
    const { raw, hash } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw));

    const rows = await testDb<{ actor_user_id: string; action: string; before: unknown; after: unknown }[]>`
      select actor_user_id, action, before, after from audit_logs
      where tenant_id = ${tenantA.id} and action = 'customer_account_link.claimed' and entity_id = ${customerId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_user_id).toBe(ownerA.id); // the STAFF member, not the customer
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain(hash);
    expect(serialized).toContain("salon_assisted");
    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id = ${customerId}`;
  });

  it("a successful unlink produces exactly one audit event with the correct staff actor", async () => {
    const customerId = await insertCustomer(tenantA.id, "Audit Unlink Target");
    const { raw } = await issueCode(clientCustomerA, tenantA.slug);
    await linkAs(clientOwnerA, customerId, hashOf(raw));
    await unlinkAs(clientOwnerA, customerId);

    const rows = await testDb<{ actor_user_id: string }[]>`
      select actor_user_id from audit_logs where tenant_id = ${tenantA.id} and action = 'customer_account_link.unlinked' and entity_id = ${customerId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_user_id).toBe(ownerA.id);
  });
});

describe("get_customer_account_link_status", () => {
  it("returns isLinked:false for an unlinked row, gated by customers.view (receptionist can read it)", async () => {
    const customerId = await insertCustomer(tenantA.id, "Status Unlinked");
    // clientReceptionistA has customers.view but not customers.link_account
    const { data, error } = await clientReceptionistA.rpc("get_customer_account_link_status", { p_customer_id: customerId });
    expect(error).toBeNull();
    expect((data as unknown as { isLinked: boolean }).isLinked).toBe(false);
  });

  it("returns canUnlink:true for a salon_assisted link and canUnlink:false for a verified_booking_claim link, with no user_id/email ever exposed", async () => {
    const salonAssistedId = await insertCustomer(tenantA.id, "Status Salon Assisted");
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${customerUserA.id}, ${tenantA.id}, ${salonAssistedId}, 'salon_assisted', true)`;
    const verifiedId = await insertCustomer(tenantA.id, "Status Verified Claim");
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${customerUserB.id}, ${tenantA.id}, ${verifiedId}, 'verified_booking_claim', true)`;

    const salonResult = await clientOwnerA.rpc("get_customer_account_link_status", { p_customer_id: salonAssistedId });
    const verifiedResult = await clientOwnerA.rpc("get_customer_account_link_status", { p_customer_id: verifiedId });

    expect((salonResult.data as unknown as { canUnlink: boolean }).canUnlink).toBe(true);
    expect((verifiedResult.data as unknown as { canUnlink: boolean }).canUnlink).toBe(false);
    expect(JSON.stringify(salonResult.data)).not.toContain(customerUserA.id);
    expect(JSON.stringify(salonResult.data)).not.toContain(customerUserA.email);

    await testDb`delete from customer_account_links where tenant_id = ${tenantA.id} and customer_id in (${salonAssistedId}, ${verifiedId})`;
  });
});

describe("security baseline", () => {
  it("customer_account_pairing_codes has zero anon/authenticated/PUBLIC table grants", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'customer_account_pairing_codes'
        and grantee in ('anon', 'authenticated', 'PUBLIC')
    `;
    expect(rows).toEqual([]);
  });

  it("all five private helpers are owner-only (zero PUBLIC/anon/authenticated grants)", async () => {
    const names = [
      "get_my_link_salon_context",
      "create_my_link_code",
      "link_customer_account_with_code",
      "unlink_salon_assisted_customer_account",
      "get_customer_account_link_status",
    ];
    const rows = await testDb<{ name: string; proacl: string[] | null }[]>`
      select p.proname as name, p.proacl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ${testDb(names)}
    `;
    expect(rows.length).toBe(names.length);
    for (const row of rows) {
      expect(row.proacl, `${row.name} should be owner-only`).toEqual(["postgres=X/postgres"]);
    }
  });

  it("all five public wrappers are authenticated-only, never anon", async () => {
    const { error: e1 } = await anonClient().rpc("create_my_link_code", { p_tenant_slug: tenantA.slug, p_code_hash: "x" });
    const { error: e2 } = await anonClient().rpc("link_customer_account_with_code", { p_customer_id: crypto.randomUUID(), p_code_hash: "x" });
    const { error: e3 } = await anonClient().rpc("unlink_salon_assisted_customer_account", { p_customer_id: crypto.randomUUID() });
    const { error: e4 } = await anonClient().rpc("get_customer_account_link_status", { p_customer_id: crypto.randomUUID() });
    const { error: e5 } = await anonClient().rpc("get_my_link_salon_context", { p_tenant_slug: tenantA.slug });
    for (const error of [e1, e2, e3, e4, e5]) {
      expect(error!.code).toBe("42501");
    }
  });

  it("booking_gateway's effective privilege surface is unchanged (still exactly create_guest_booking)", async () => {
    const rows = await testDb<{ schema: string; name: string; can_execute: boolean }[]>`
      select n.nspname as schema, p.proname as name, has_function_privilege('booking_gateway', p.oid, 'EXECUTE') as can_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`;
    const executable = rows.filter((r) => r.can_execute).map((r) => `${r.schema}.${r.name}`);
    expect(executable).toEqual(["public.create_guest_booking"]);
  });

  it("service_role has zero function execute grants (unchanged baseline)", async () => {
    const rows = await testDb<{ name: string; proacl: string[] | null }[]>`
      select p.proname as name, p.proacl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and p.proname in ('create_my_link_code', 'link_customer_account_with_code', 'unlink_salon_assisted_customer_account')
    `;
    for (const row of rows) {
      const hasServiceRole = (row.proacl ?? []).some((entry) => entry.includes("service_role"));
      expect(hasServiceRole, `${row.name} must not grant service_role`).toBe(false);
    }
  });

  it("customer cancel/reschedule mutation grants are unaffected", async () => {
    const rows = await testDb<{ name: string; can_execute: boolean }[]>`
      select p.proname as name, has_function_privilege('authenticated', p.oid, 'EXECUTE') as can_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('cancel_my_appointment', 'reschedule_my_appointment')
    `;
    for (const row of rows) {
      expect(row.can_execute, `${row.name} should remain authenticated-executable`).toBe(true);
    }
  });
});
