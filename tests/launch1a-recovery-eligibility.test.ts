import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, asDatabaseRole, cleanupUsers, testDb } from "./helpers";

/**
 * Faz LAUNCH.1A (2 of 3) — public.password_recovery_allowed (migration
 * 20261022150100): who may be sent a password-recovery e-mail.
 *
 * SalonOS keeps two authorization domains on ONE auth user pool: salon staff
 * sign in with a password, customers use a passwordless magic link. Recovery
 * must never hand a customer-only account its FIRST password through the staff
 * surface, so the forgot-password action asks this function (service_role
 * ONLY — never anon/authenticated, it would be an account-existence oracle)
 * before it sends anything.
 */

const TAG = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];

async function makeUser(label: string, opts: { password: boolean; confirmed: boolean }): Promise<{ id: string; email: string }> {
  const email = `test-l1a-rec-${label}-${TAG}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    ...(opts.password ? { password: "Test1234!Test1234!" } : {}),
    email_confirm: opts.confirmed,
  });
  expect(error).toBeNull();
  createdUserIds.push(data.user!.id);
  return { id: data.user!.id, email };
}

const allowed = async (email: string | null) =>
  (await asDatabaseRole("service_role", null, (sql) => sql<{ ok: boolean }[]>`select public.password_recovery_allowed(${email}) as ok`))[0]!.ok;

afterAll(async () => {
  await cleanupUsers(createdUserIds);
}, 60000);

beforeAll(async () => {
  const [fn] = await testDb<{ present: boolean }[]>`select to_regprocedure('public.password_recovery_allowed(text)') is not null as present`;
  expect(fn!.present, "run this file against a database that carries migration 20261022150100").toBe(true);
});

describe("password_recovery_allowed — only accounts that HAVE a password", () => {
  it("is true for a confirmed account with a password (the staff / owner shape)", async () => {
    const staff = await makeUser("staff", { password: true, confirmed: true });
    expect(await allowed(staff.email)).toBe(true);
  });

  it("is false for a confirmed PASSWORDLESS account (the customer magic-link shape) — recovery can never give it a first password", async () => {
    const customer = await makeUser("customer", { password: false, confirmed: true });
    expect(await allowed(customer.email)).toBe(false);
    // an empty-string password hash (how a passwordless GoTrue user is stored) is treated the same as NULL
    await testDb`update auth.users set encrypted_password = '' where id = ${customer.id}`;
    expect(await allowed(customer.email)).toBe(false);
  });

  it("is false for an UNCONFIRMED account, even with a password", async () => {
    const unconfirmed = await makeUser("unconfirmed", { password: true, confirmed: false });
    expect(await allowed(unconfirmed.email)).toBe(false);
  });

  it("is false for a soft-deleted account", async () => {
    const gone = await makeUser("deleted", { password: true, confirmed: true });
    await testDb`update auth.users set deleted_at = now() where id = ${gone.id}`;
    expect(await allowed(gone.email)).toBe(false);
  });

  it("is false for an unknown address, an empty string and NULL", async () => {
    expect(await allowed(`nobody-${TAG}@example.com`)).toBe(false);
    expect(await allowed("")).toBe(false);
    expect(await allowed("   ")).toBe(false);
    expect(await allowed(null)).toBe(false);
  });

  it("ignores case and surrounding spaces in the submitted address", async () => {
    const staff = await makeUser("norm", { password: true, confirmed: true });
    expect(await allowed(`  ${staff.email.toUpperCase()}  `)).toBe(true);
  });

  it("does not treat SQL wildcards or a partial address as a match", async () => {
    const staff = await makeUser("wild", { password: true, confirmed: true });
    expect(await allowed(staff.email.replace("test-l1a-rec-wild", "%"))).toBe(false);
    expect(await allowed(staff.email.slice(0, -4))).toBe(false);
  });
});

describe("password_recovery_allowed — who may call it", () => {
  it("anon and authenticated cannot execute it (an executable copy would be an account-existence oracle)", async () => {
    const staff = await makeUser("grants", { password: true, confirmed: true });
    await expect(asDatabaseRole("anon", null, (sql) => sql`select public.password_recovery_allowed(${staff.email})`)).rejects.toMatchObject({ code: "42501" });
    await expect(asDatabaseRole("authenticated", staff.id, (sql) => sql`select public.password_recovery_allowed(${staff.email})`)).rejects.toMatchObject({ code: "42501" });
  });

  it("the private implementation is not reachable by API roles either", async () => {
    await expect(asDatabaseRole("authenticated", null, (sql) => sql`select private.password_recovery_allowed('x@example.com')`)).rejects.toMatchObject({ code: "42501" });
    await expect(asDatabaseRole("service_role", null, (sql) => sql`select private.password_recovery_allowed('x@example.com')`)).rejects.toMatchObject({ code: "42501" });
  });

  it("the function exposes a single boolean — no row, no id, no hint about WHY an address is ineligible", async () => {
    const customer = await makeUser("shape", { password: false, confirmed: true });
    const [row] = await asDatabaseRole("service_role", null, (sql) => sql<Record<string, unknown>[]>`select public.password_recovery_allowed(${customer.email})`);
    expect(Object.keys(row!)).toEqual(["password_recovery_allowed"]);
    expect(typeof row!.password_recovery_allowed).toBe("boolean");
  });
});
