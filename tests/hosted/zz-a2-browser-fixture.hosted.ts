import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupTenants, cleanupUsers, createBranch, createService, createStaffMember, createStaffSchedule, createTestTenant, createTestUser,
  linkServiceBranch, linkStaffBranch, linkStaffService, testDb,
} from "../helpers";
import { assertDisposableDatabase, readHostedEnv } from "./guard";

/**
 * Faz SAAS.1C.2c-A2 - fixtures for the REAL BROWSER acceptance (scratch helper, not a regression test). MODE=create writes the synthetic owner / salons to
 * A2_BROWSER_FIXTURE (a json file in the operator folder; it carries the synthetic password, never a real secret); MODE=cleanup removes them.
 */
readHostedEnv();
const FILE = process.env.A2_BROWSER_FIXTURE ?? "a2-browser-fixture.json";
const MODE = process.env.A2_BROWSER_MODE ?? "create";

afterAll(async () => { await testDb.end(); });

describe("browser fixture", () => {
  it(`fixture ${MODE}`, async () => {
    await assertDisposableDatabase(testDb as unknown as Parameters<typeof assertDisposableDatabase>[0]);
    if (MODE === "cleanup") {
      if (!existsSync(FILE)) return;
      const f = JSON.parse(readFileSync(FILE, "utf8"));
      await cleanupTenants(f.tenantIds);
      await cleanupUsers(f.userIds);
      return;
    }
    const tag = Math.random().toString(36).slice(2, 6);
    const owner = await createTestUser("h-a2-browser-owner");
    const [plan] = await testDb<{ id: string }[]>`select id from plans where key = 'salon'`;
    const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
    const out: Record<string, unknown> = { owner: { email: owner.email, password: owner.password }, userIds: [owner.id], tenantIds: [] as string[], tenants: {} };
    for (const mode of ["full", "read_only"] as const) {
      const slug = `h-a2-br-${mode.replace("_", "")}-${tag}`;
      const t = await createTestTenant(slug, owner.id);
      (out.tenantIds as string[]).push(t.id);
      if (mode === "full") await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${t.id}, ${plan!.id}, 'active', 'pilot')`;
      else await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode, trial_started_at, trial_ends_at, grace_ends_at) values (${t.id}, ${plan!.id}, 'trialing', 'paid', now() - interval '60 days', now() - interval '30 days', now() - interval '10 days')`;
      await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${t.id}, ${feature!.id}, true)`;
      const branch = await createBranch(t.id, "Merkez");
      const staff = (await createStaffMember(t.id, "Personel")).id;
      await linkStaffBranch(staff, branch);
      for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, staff, w, "00:00", "23:59");
      const svc = (await createService(t.id, "Hizmet", 30, 100)).id;
      await linkServiceBranch(svc, branch);
      await linkStaffService(staff, svc);
      await testDb`insert into customers (tenant_id, full_name) values (${t.id}, 'Sentetik Musteri')`;
      (out.tenants as Record<string, unknown>)[mode] = { id: t.id, slug, branch, staff, svc };
    }
    writeFileSync(FILE, JSON.stringify(out, null, 1));
    expect((out.tenantIds as string[]).length).toBe(2);
  }, 300000);
});
