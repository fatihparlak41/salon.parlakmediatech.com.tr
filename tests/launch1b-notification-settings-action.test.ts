/**
 * Faz LAUNCH.1B — the Server Action behind the Owner's switches, with the Supabase client replaced
 * by a recording fake (no network, no database). The database RPC is the authorization boundary
 * (covered against the real database in launch1b-notification-lifecycle.test.ts); this file pins
 * what the action itself must do: refuse a malformed request before it reaches the RPC, pass
 * exactly the validated values, map the refusal, and report the server's answer (not the request).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const requireUser = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: (...args: unknown[]) => requireUser(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("@/lib/pwa/web-push-server", () => ({ sendTestPush: vi.fn() }));

import { updateCustomerNotificationSettingAction } from "@/lib/modules/settings/actions";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  rpc.mockReset();
  requireUser.mockReset();
  revalidatePath.mockReset();
  requireUser.mockResolvedValue({ id: "user" });
});

describe("updateCustomerNotificationSettingAction", () => {
  it("requires a signed-in user before anything else", async () => {
    requireUser.mockRejectedValue(new Error("redirect to login"));
    await expect(
      updateCustomerNotificationSettingAction(null, { tenantId: TENANT_ID, tenantSlug: "s", type: "appointment_update", enabled: true }),
    ).rejects.toThrow("redirect to login");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes exactly the validated values to the RPC, reports the SERVER's answer, and refreshes the settings page", async () => {
    rpc.mockResolvedValue({ data: { type: "appointment_update", enabled: false }, error: null });
    const result = await updateCustomerNotificationSettingAction(null, {
      tenantId: TENANT_ID,
      tenantSlug: "ornek-salon",
      type: "appointment_update",
      enabled: true, // the request said ON; the server's answer says OFF: the UI must show the server's truth
    });
    expect(rpc).toHaveBeenCalledWith("set_customer_notification_setting", {
      p_tenant_id: TENANT_ID,
      p_notification_type: "appointment_update",
      p_enabled: true,
    });
    expect(result).toEqual({ success: true, data: { type: "appointment_update", enabled: false } });
    expect(revalidatePath).toHaveBeenCalledWith("/app/ornek-salon/settings");
  });

  it("a malformed request never reaches the database: unknown type, bad tenant id, missing slug, non-boolean", async () => {
    const bad = [
      { tenantId: TENANT_ID, tenantSlug: "s", type: "appointment_sms", enabled: true },
      { tenantId: "not-a-uuid", tenantSlug: "s", type: "appointment_update", enabled: true },
      { tenantId: TENANT_ID, tenantSlug: " ", type: "appointment_update", enabled: true },
      { tenantId: TENANT_ID, tenantSlug: "s", type: "appointment_update", enabled: "yes" as unknown as boolean },
      { tenantId: TENANT_ID, tenantSlug: "s", type: "'; drop table x; --", enabled: true },
    ];
    for (const input of bad) {
      const result = await updateCustomerNotificationSettingAction(null, input);
      expect(result.success, JSON.stringify(input)).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the database's refusal for a non-Owner becomes a plain 'no permission' answer; any other error a generic one (no database text leaks)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "settings.manage required", code: "CN011" } });
    const refused = await updateCustomerNotificationSettingAction(null, { tenantId: TENANT_ID, tenantSlug: "s", type: "appointment_update", enabled: true });
    expect(refused).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Bu işlem için yetkiniz yok" } });
    expect(revalidatePath).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'relation "private.customer_notification_activation" does not exist', code: "42P01" } });
    const broken = await updateCustomerNotificationSettingAction(null, { tenantId: TENANT_ID, tenantSlug: "s", type: "appointment_update", enabled: true });
    expect(broken.success).toBe(false);
    expect(JSON.stringify(broken)).not.toContain("customer_notification_activation");
    expect(broken).toMatchObject({ error: { code: "UNEXPECTED" } });
  });
});
