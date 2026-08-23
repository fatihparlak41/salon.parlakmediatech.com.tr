import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb, createTestTenant, createTestUser, cleanupTenants, cleanupUsers, type TestUser } from "./helpers";

/**
 * Faz 2G.1 (20260822180000) — customer_account_links structural
 * guarantees. The cardinality here was an explicit architecture
 * correction over the original Faz 2G.0 proposal: one CRM customer row
 * may be actively claimed by at most one account, but one account may
 * hold many customer rows in the SAME tenant (only one of them PRIMARY)
 * — never a flat "one link per tenant+user".
 */

let user: TestUser;
let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };
let customerA1: string;
let customerA2: string;
let customerB1: string;

beforeAll(async () => {
  user = await createTestUser("p2g1-schema");
  const a = await createTestTenant("test-p2g1-schema-a", user.id);
  const b = await createTestTenant("test-p2g1-schema-b", user.id);
  tenantA = { id: a.id, slug: a.slug };
  tenantB = { id: b.id, slug: b.slug };

  const [c1] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name) values (${tenantA.id}, 'Schema Customer A1') returning id`;
  const [c2] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name) values (${tenantA.id}, 'Schema Customer A2') returning id`;
  const [c3] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name) values (${tenantB.id}, 'Schema Customer B1') returning id`;
  customerA1 = c1!.id;
  customerA2 = c2!.id;
  customerB1 = c3!.id;
}, 60000);

afterAll(async () => {
  await testDb`delete from customer_account_links where user_id = ${user.id}`;
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([user.id]);
});

describe("customer_account_links schema", () => {
  it("composite FK rejects a link whose tenant_id disagrees with the customer's real tenant — structural, not app-validated", async () => {
    await expect(
      testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
        values (${user.id}, ${tenantB.id}, ${customerA1}, 'future_booking', true)`,
    ).rejects.toThrow();
  });

  it("a valid link insert succeeds", async () => {
    const rows = await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
      values (${user.id}, ${tenantA.id}, ${customerA1}, 'future_booking', true) returning id`;
    expect(rows.length).toBe(1);
  });

  it("a second ACTIVE link to the SAME customer row is rejected — one active account per CRM row", async () => {
    await expect(
      testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
        values (${user.id}, ${tenantA.id}, ${customerA1}, 'future_booking', false)`,
    ).rejects.toThrow();
  });

  it("a SECOND non-primary link for the SAME user in the SAME tenant to a DIFFERENT customer row is permitted", async () => {
    const rows = await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
      values (${user.id}, ${tenantA.id}, ${customerA2}, 'future_booking', false) returning id`;
    expect(rows.length).toBe(1);
  });

  it("a SECOND primary link for the SAME user in the SAME tenant is rejected", async () => {
    await expect(
      testDb`update customer_account_links set is_primary = true where user_id = ${user.id} and customer_id = ${customerA2}`,
    ).rejects.toThrow();
  });

  it("a primary link for the SAME user in a DIFFERENT tenant is permitted — primary is per-tenant, not global", async () => {
    const rows = await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
      values (${user.id}, ${tenantB.id}, ${customerB1}, 'future_booking', true) returning id`;
    expect(rows.length).toBe(1);
  });

  it("soft-deleting a link frees its uniqueness slots for a new active link", async () => {
    await testDb`update customer_account_links set deleted_at = now() where user_id = ${user.id} and customer_id = ${customerA1}`;
    const rows = await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
      values (${user.id}, ${tenantA.id}, ${customerA1}, 'future_booking', false) returning id`;
    expect(rows.length).toBe(1);
  });

  it("claimed_via rejects an arbitrary uncontrolled value — only the reserved vocabulary is legal", async () => {
    await testDb`delete from customer_account_links where customer_id = ${customerA1}`;
    await expect(
      testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
        values (${user.id}, ${tenantA.id}, ${customerA1}, 'made_up_value', false)`,
    ).rejects.toThrow();
  });

  it("claimed_via accepts the two values reserved for later phases, even though nothing produces them yet", async () => {
    for (const value of ["verified_booking_claim", "salon_assisted"]) {
      const rows = await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
        values (${user.id}, ${tenantA.id}, ${customerA1}, ${value}, false) returning id`;
      expect(rows.length).toBe(1);
      await testDb`delete from customer_account_links where id = ${rows[0]!.id}`;
    }
  });

  it("anon and authenticated have zero direct table grants — RPC-only write access", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee::text from information_schema.table_privileges
      where table_schema = 'public' and table_name = 'customer_account_links'
      and grantee in ('anon', 'authenticated', 'public')`;
    expect(rows).toEqual([]);
  });

  it("RLS is enabled with exactly one policy — self-select only", async () => {
    const [rel] = await testDb<{ relrowsecurity: boolean }[]>`
      select relrowsecurity from pg_class where oid = 'public.customer_account_links'::regclass`;
    expect(rel!.relrowsecurity).toBe(true);
    const policies = await testDb<{ policyname: string; cmd: string }[]>`
      select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'customer_account_links'`;
    expect(policies.length).toBe(1);
    expect(policies[0]!.cmd).toBe("SELECT");
  });

  it("customers.id + tenant_id is independently unique, the structural basis the composite FK relies on", async () => {
    const rows = await testDb<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid = 'public.customers'::regclass and contype = 'u' and conname = 'customers_id_tenant_id_key'`;
    expect(rows.length).toBe(1);
  });
});
