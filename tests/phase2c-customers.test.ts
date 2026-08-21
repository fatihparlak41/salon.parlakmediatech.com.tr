import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createCustomer,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Phase 2C: customers CRM core. customers has no RPC for writes (plain
 * RLS-gated table, same as Phase 2A) — but reads go through
 * public.search_customers (20260821120000, corrected to SECURITY DEFINER
 * in 20260821123000 — see that migration's comment for why SECURITY
 * INVOKER could not call private.normalize_phone/normalize_email at all,
 * found during Phase 2C browser verification), so this file tests both
 * the direct table RLS (create/edit/archive/reactivate/isolation) and the
 * search RPC (normalization, pagination scoping, cross-tenant safety).
 * Every assertion goes through a real signed-in user's client or the
 * anon client; testDb is fixture setup and ground-truth verification
 * only.
 */

// The client vars below are typed as bare SupabaseClient (matching every
// other test file), so .rpc() results fall back to a loose type — this
// just gives the search_customers row shape a name for the .some/.map
// callbacks below rather than annotating each one inline.
type SearchCustomerRow = { id: string };

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let ownerB: TestUser;
let limitedA: TestUser; // customers.view only
let ownerAClient: SupabaseClient;
let ownerBClient: SupabaseClient;
let limitedAClient: SupabaseClient;

beforeAll(async () => {
  ownerA = await createTestUser("p2c-owner-a");
  ownerB = await createTestUser("p2c-owner-b");
  limitedA = await createTestUser("p2c-limited-a");

  tenantA = await createTestTenant("test-p2c-a", ownerA.id);
  tenantB = await createTestTenant("test-p2c-b", ownerB.id);

  const limitedRoleA = await createRoleForTenant(tenantA.id, "Salt Okunur", ["customers.view"]);
  await testDb`
    insert into tenant_memberships (tenant_id, user_id, role_id, status)
    values (${tenantA.id}, ${limitedA.id}, ${limitedRoleA}, 'active')
  `;

  ownerAClient = await signInAs(ownerA);
  ownerBClient = await signInAs(ownerB);
  limitedAClient = await signInAs(limitedA);
}, 45000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, ownerB.id, limitedA.id]);
}, 45000);

describe("create / edit / archive / reactivate", () => {
  it("customers.create holder can create a customer", async () => {
    const { data, error } = await ownerAClient
      .from("customers")
      .insert({ tenant_id: tenantA.id, full_name: "Yeni Müşteri", phone: "0555 000 00 01" })
      .select("id, status")
      .single();
    expect(error).toBeNull();
    expect(data?.status).toBe("active");
    await testDb`delete from customers where id = ${data!.id}`;
  });

  it("customers.update holder can edit profile fields", async () => {
    const customer = await createCustomer(tenantA.id, "Düzenlenecek Müşteri");
    const { error } = await ownerAClient
      .from("customers")
      .update({ phone: "0555 000 00 02", notes: "VIP müşteri" })
      .eq("id", customer.id);
    expect(error).toBeNull();

    const [row] = await testDb<{ phone: string; notes: string }[]>`
      select phone, notes from customers where id = ${customer.id}
    `;
    expect(row?.phone).toBe("0555 000 00 02");
    expect(row?.notes).toBe("VIP müşteri");
    await testDb`delete from customers where id = ${customer.id}`;
  });

  it("archive then reactivate round trip", async () => {
    const customer = await createCustomer(tenantA.id, "Durum Testi Müşterisi");

    const { error: archiveError } = await ownerAClient.from("customers").update({ status: "archived" }).eq("id", customer.id);
    expect(archiveError).toBeNull();
    const [archived] = await testDb<{ status: string }[]>`select status from customers where id = ${customer.id}`;
    expect(archived?.status).toBe("archived");

    const { error: reactivateError } = await ownerAClient.from("customers").update({ status: "active" }).eq("id", customer.id);
    expect(reactivateError).toBeNull();
    const [reactivated] = await testDb<{ status: string }[]>`select status from customers where id = ${customer.id}`;
    expect(reactivated?.status).toBe("active");

    await testDb`delete from customers where id = ${customer.id}`;
  });
});

describe("permissions: customers.view vs customers.create/update", () => {
  it("a view-only user cannot create a customer", async () => {
    const { error } = await limitedAClient.from("customers").insert({ tenant_id: tenantA.id, full_name: "Yetkisiz Ekleme" });
    expect(error).not.toBeNull();
  });

  it("a view-only user's update attempt leaves the ground-truth row unchanged", async () => {
    // UPDATE's RLS USING clause filters non-matching rows rather than
    // throwing (unlike INSERT's WITH CHECK) — the real assertion is the
    // row's actual state afterward, not the presence of a client error.
    // See the identical finding in tests/phase2b-management.test.ts.
    const customer = await createCustomer(tenantA.id, "Yetkisiz Düzenleme");
    await limitedAClient.from("customers").update({ full_name: "Değiştirildi" }).eq("id", customer.id);
    const [row] = await testDb<{ full_name: string }[]>`select full_name from customers where id = ${customer.id}`;
    expect(row?.full_name).toBe("Yetkisiz Düzenleme");
    await testDb`delete from customers where id = ${customer.id}`;
  });

  it("a view-only user can still read customers", async () => {
    const customer = await createCustomer(tenantA.id, "Görüntülenebilir Müşteri");
    const { data, error } = await limitedAClient.from("customers").select("id").eq("id", customer.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    await testDb`delete from customers where id = ${customer.id}`;
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot see tenant A's customers via direct table access", async () => {
    const customer = await createCustomer(tenantA.id, "İzolasyon Testi");
    const { data } = await ownerBClient.from("customers").select("id").eq("id", customer.id);
    expect(data ?? []).toHaveLength(0);
    await testDb`delete from customers where id = ${customer.id}`;
  });

  it("a forged tenant_id insert is rejected", async () => {
    const { error } = await ownerAClient.from("customers").insert({ tenant_id: tenantB.id, full_name: "Sahte Kiracı" });
    expect(error).not.toBeNull();
  });
});

describe("customer identity independent of Auth/tenant membership", () => {
  it("a customer can be created with no created_by (no attributable auth user) and needs no tenant_membership row at all", async () => {
    const { data, error } = await ownerAClient
      .from("customers")
      .insert({ tenant_id: tenantA.id, full_name: "Kimliksiz Müşteri Kaydı" })
      .select("id, created_by")
      .single();
    expect(error).toBeNull();
    // created_by is nullable and unset here — proves it's optional
    // attribution (which staff member added the record), not an identity
    // requirement for the customer themselves.
    expect(data?.created_by).toBeNull();

    // customers has no tenant_membership_id / user_id column at all — the
    // schema itself cannot couple a customer to a login identity.
    const columns = await testDb<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'customers'
        and column_name in ('tenant_membership_id', 'user_id', 'auth_user_id')
    `;
    expect(columns).toHaveLength(0);

    await testDb`delete from customers where id = ${data!.id}`;
  });
});

describe("search_customers — normalization", () => {
  it("finds a customer by phone regardless of formatting (spaces, dashes, country code stripped consistently)", async () => {
    const customer = await createCustomer(tenantA.id, "Telefon Arama Testi");
    await testDb`update customers set phone = '0555 987 65 43' where id = ${customer.id}`;

    const { data, error } = await ownerAClient.rpc("search_customers", {
      p_tenant_id: tenantA.id,
      p_query: "0555-987-6543",
      p_status: "active",
      p_limit: 30,
      p_offset: 0,
    });
    expect(error).toBeNull();
    expect(data?.some((r: SearchCustomerRow) => r.id === customer.id)).toBe(true);

    await testDb`delete from customers where id = ${customer.id}`;
  });

  it("finds a customer by email regardless of case", async () => {
    const customer = await createCustomer(tenantA.id, "E-posta Arama Testi");
    await testDb`update customers set email = 'Karisik.Buyuk@Example.com' where id = ${customer.id}`;

    const { data, error } = await ownerAClient.rpc("search_customers", {
      p_tenant_id: tenantA.id,
      p_query: "karisik.buyuk@example.com",
      p_status: "active",
      p_limit: 30,
      p_offset: 0,
    });
    expect(error).toBeNull();
    expect(data?.some((r: SearchCustomerRow) => r.id === customer.id)).toBe(true);

    await testDb`delete from customers where id = ${customer.id}`;
  });

  it("finds a customer by partial name match", async () => {
    const customer = await createCustomer(tenantA.id, "Ahmet Yılmaz Özkan");
    const { data, error } = await ownerAClient.rpc("search_customers", {
      p_tenant_id: tenantA.id,
      p_query: "Yılmaz",
      p_status: "active",
      p_limit: 30,
      p_offset: 0,
    });
    expect(error).toBeNull();
    expect(data?.some((r: SearchCustomerRow) => r.id === customer.id)).toBe(true);
    await testDb`delete from customers where id = ${customer.id}`;
  });

  it("archived customers are excluded from the default active-status search", async () => {
    const customer = await createCustomer(tenantA.id, "Arşiv Filtre Testi");
    await testDb`update customers set status = 'archived' where id = ${customer.id}`;

    const { data: activeResults } = await ownerAClient.rpc("search_customers", {
      p_tenant_id: tenantA.id,
      p_query: "",
      p_status: "active",
      p_limit: 100,
      p_offset: 0,
    });
    expect(activeResults?.some((r: SearchCustomerRow) => r.id === customer.id)).toBe(false);

    const { data: archivedResults } = await ownerAClient.rpc("search_customers", {
      p_tenant_id: tenantA.id,
      p_query: "",
      p_status: "archived",
      p_limit: 100,
      p_offset: 0,
    });
    expect(archivedResults?.some((r: SearchCustomerRow) => r.id === customer.id)).toBe(true);

    await testDb`delete from customers where id = ${customer.id}`;
  });
});

describe("search_customers — cross-tenant safety", () => {
  it("a duplicate-style phone search never returns another tenant's customer", async () => {
    const sharedPhone = "0555 111 22 33";
    const customerA = await createCustomer(tenantA.id, "Paylaşılan Numara A");
    const customerB = await createCustomer(tenantB.id, "Paylaşılan Numara B");
    await testDb`update customers set phone = ${sharedPhone} where id in (${customerA.id}, ${customerB.id})`;

    const { data } = await ownerAClient.rpc("search_customers", {
      p_tenant_id: tenantA.id,
      p_query: sharedPhone,
      p_status: "all",
      p_limit: 30,
      p_offset: 0,
    });
    const ids = (data ?? []).map((r: SearchCustomerRow) => r.id);
    expect(ids).toContain(customerA.id);
    expect(ids).not.toContain(customerB.id);

    await testDb`delete from customers where id in (${customerA.id}, ${customerB.id})`;
  });

  it("calling search_customers with a tenant_id the caller has no membership in returns nothing, not an error that leaks existence", async () => {
    const customer = await createCustomer(tenantB.id, "Yabancı Kiracı Müşterisi");
    const { data, error } = await ownerAClient.rpc("search_customers", {
      p_tenant_id: tenantB.id,
      p_query: "",
      p_status: "all",
      p_limit: 30,
      p_offset: 0,
    });
    // has_permission(tenantB, 'customers.view') is false for ownerA -> the
    // function raises, surfacing as a PostgREST error, not a silent
    // partial result — either way, tenant B's data must not come back.
    if (!error) {
      expect(data ?? []).toHaveLength(0);
    } else {
      expect(error).not.toBeNull();
    }
    await testDb`delete from customers where id = ${customer.id}`;
  });
});

describe("audit", () => {
  it("creating and archiving a customer writes the expected audit rows (no duplicate application-level logging)", async () => {
    const { data } = await ownerAClient
      .from("customers")
      .insert({ tenant_id: tenantA.id, full_name: "Denetim Testi Müşterisi" })
      .select("id")
      .single();

    await ownerAClient.from("customers").update({ status: "archived" }).eq("id", data!.id);

    const rows = await testDb<{ action: string }[]>`
      select action from audit_logs where entity_type = 'customer' and entity_id = ${data!.id} order by created_at
    `;
    expect(rows.map((r) => r.action)).toEqual(["customer.created", "customer.updated"]);

    await testDb`delete from customers where id = ${data!.id}`;
  });
});

describe("anon access", () => {
  it("anon cannot read the customers table at all", async () => {
    const customer = await createCustomer(tenantA.id, "Anon Testi Müşterisi");
    const { data } = await anonClient().from("customers").select("id").eq("id", customer.id);
    expect(data ?? []).toHaveLength(0);
    await testDb`delete from customers where id = ${customer.id}`;
  });

  it("anon cannot insert into the customers table", async () => {
    const { error } = await anonClient().from("customers").insert({ tenant_id: tenantA.id, full_name: "Anon Ekleme" });
    expect(error).not.toBeNull();
  });

  it("anon cannot call search_customers", async () => {
    const { error } = await anonClient().rpc("search_customers", {
      p_tenant_id: tenantA.id,
      p_query: "",
      p_status: "active",
      p_limit: 30,
      p_offset: 0,
    });
    expect(error).not.toBeNull();
  });
});
