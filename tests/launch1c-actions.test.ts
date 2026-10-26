/**
 * Faz LAUNCH.1C — the guided-setup Server Actions with the Supabase client replaced by a recording fake (no network,
 * no database). The RPCs are the authorization and validation boundary (covered against the real database in
 * launch1c-onboarding.test.ts); here we pin what each action itself must do: refuse a malformed request before it
 * reaches the RPC, pass exactly the validated values, map every refusal to a plain message (no database text),
 * and trust only a well-formed answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const requireUser = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: (...args: unknown[]) => requireUser(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

import {
  addServicesAction,
  addStaffAction,
  applyWeeklyHoursAction,
  saveSalonProfileAction,
  setStaffServicesAction,
} from "@/lib/modules/onboarding/actions";

const TENANT = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";

const STATUS = {
  ready: false,
  blockers: ["no_services"],
  bookingEngineReady: false,
  bookingEngineBlockers: ["no_services"],
  tenantSlug: "ornek",
  profile: { name: "Ornek", timezone: "Europe/Istanbul", currency: "TRY", phone: "0532", missing: [] },
  counts: { services: 0, staff: 0, staffWithHours: 0, bookablePaths: 0 },
  onlineBookingEnabled: false,
  hasAppointments: false,
  firstAvailableSlotAt: null,
  steps: ["profile", "services", "staff", "hours", "mapping", "booking", "ready"].map((key) => ({ key, done: false })),
};

beforeEach(() => {
  rpc.mockReset();
  requireUser.mockReset();
  revalidatePath.mockReset();
  requireUser.mockResolvedValue({ id: "user" });
});

describe("every action", () => {
  it("requires a signed-in user before anything else", async () => {
    requireUser.mockRejectedValue(new Error("redirect to login"));
    await expect(addStaffAction(null, { tenantId: TENANT, tenantSlug: "s", items: [{ fullName: "A" }] })).rejects.toThrow("redirect to login");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("each of the five actions requires a signed-in user and refuses a malformed salon id before any RPC", async () => {
    const valid = {
      profile: { tenantSlug: "s", name: "X", timezone: "Europe/Istanbul", currency: "TRY", phone: "0532 000 00 00", address: "" },
      services: { tenantSlug: "s", items: [{ name: "X", durationMinutes: 30, price: "1" }] },
      staff: { tenantSlug: "s", items: [{ fullName: "X" }] },
      hours: { tenantSlug: "s", staffIds: [STAFF], days: [] },
      mapping: { tenantSlug: "s", assignments: [{ staffId: STAFF, serviceIds: [] }] },
    };
    const run = {
      profile: (extra: object) => saveSalonProfileAction(null, { ...valid.profile, ...extra }),
      services: (extra: object) => addServicesAction(null, { ...valid.services, ...extra }),
      staff: (extra: object) => addStaffAction(null, { ...valid.staff, ...extra }),
      hours: (extra: object) => applyWeeklyHoursAction(null, { ...valid.hours, ...extra }),
      mapping: (extra: object) => setStaffServicesAction(null, { ...valid.mapping, ...extra }),
    };
    for (const [name, call] of Object.entries(run)) {
      requireUser.mockRejectedValueOnce(new Error("redirect to login"));
      await expect(call({ tenantId: TENANT }), name).rejects.toThrow("redirect to login");
      const bad = await call({ tenantId: "not-a-uuid" });
      expect(bad.success, name).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps each database refusal to a plain message and never leaks database text", async () => {
    const cases: [string, string, string][] = [
      ["OB011", "UNAUTHORIZED", "Bu işlem için yetkiniz yok"],
      ["42501", "UNAUTHORIZED", "Bu işlem için yetkiniz yok"],
      ["OB004", "CONFLICT", "Salon şu anda aktif değil"],
      ["OB012", "VALIDATION", "Girdiğiniz bilgiler kabul edilmedi, lütfen kontrol edin"],
      ["OB010", "UNAUTHENTICATED", "Oturumunuz kapanmış, lütfen tekrar giriş yapın"],
      ["XX000", "UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin"],
    ];
    for (const [code, appCode, message] of cases) {
      rpc.mockResolvedValueOnce({ data: null, error: { code, message: 'relation "public.staff_members" violates something' } });
      const result = await addStaffAction(null, { tenantId: TENANT, tenantSlug: "s", items: [{ fullName: "A" }] });
      expect(result).toEqual({ success: false, error: { code: appCode, message } });
      expect(JSON.stringify(result)).not.toContain("staff_members");
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an unreadable or contradictory RPC answer is an error, never a success", async () => {
    rpc.mockResolvedValueOnce({ data: { created: 1, skipped: 0, status: { ready: true, blockers: ["no_services"] } }, error: null });
    const result = await addStaffAction(null, { tenantId: TENANT, tenantSlug: "s", items: [{ fullName: "A" }] });
    expect(result.success).toBe(false);
  });
});

describe("saveSalonProfileAction", () => {
  const valid = { tenantId: TENANT, tenantSlug: "ornek", name: " Salon ", timezone: "Asia/Nicosia", currency: "EUR", phone: "0542 123 45 67", address: "" };

  it("passes exactly the validated values and returns the server's status", async () => {
    rpc.mockResolvedValueOnce({ data: STATUS, error: null });
    const result = await saveSalonProfileAction(null, valid);
    expect(rpc).toHaveBeenCalledWith("update_salon_profile", {
      p_tenant_id: TENANT,
      p_name: "Salon",
      p_timezone: "Asia/Nicosia",
      p_currency: "EUR",
      p_phone: "0542 123 45 67",
      p_address: "",
    });
    expect(result.success && result.data.status.profile.name).toBe("Ornek");
    expect(revalidatePath).toHaveBeenCalledWith("/app/ornek", "layout");
  });

  it("malformed input never reaches the database", async () => {
    for (const bad of [
      { ...valid, name: "  " },
      { ...valid, currency: "XXX" },
      { ...valid, phone: "abc" },
      { ...valid, tenantId: "nope" },
      { ...valid, timezone: "" },
      null,
      "string",
    ]) {
      const result = await saveSalonProfileAction(null, bad);
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("addServicesAction", () => {
  it("sends name, category, duration and price exactly and reports created/skipped from the server", async () => {
    rpc.mockResolvedValueOnce({ data: { created: 2, skipped: 1, status: STATUS }, error: null });
    const result = await addServicesAction(null, {
      tenantId: TENANT,
      tenantSlug: "ornek",
      items: [
        { name: " Saç Kesimi ", category: "Saç", durationMinutes: "45", price: "800" },
        { name: "Manikür", durationMinutes: 30, price: "150.50" },
      ],
    });
    expect(rpc).toHaveBeenCalledWith("onboarding_add_services", {
      p_tenant_id: TENANT,
      p_items: [
        { name: "Saç Kesimi", category: "Saç", durationMinutes: 45, price: "800" },
        { name: "Manikür", category: "", durationMinutes: 30, price: "150.50" },
      ],
    });
    expect(result).toMatchObject({ success: true, data: { created: 2, skipped: 1 } });
  });

  it("rejects bad rows before the RPC: price format, duration range, empty list, too many", async () => {
    const row = { name: "X", durationMinutes: 30, price: "10" };
    for (const items of [
      [],
      [{ ...row, price: "10,5" }],
      [{ ...row, price: "-1" }],
      [{ ...row, durationMinutes: 0 }],
      [{ ...row, durationMinutes: 2000 }],
      [{ ...row, name: "" }],
      Array.from({ length: 51 }, () => row),
    ]) {
      const result = await addServicesAction(null, { tenantId: TENANT, tenantSlug: "s", items });
      expect(result.success).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("addStaffAction / applyWeeklyHoursAction / setStaffServicesAction", () => {
  it("staff: roster fields only", async () => {
    rpc.mockResolvedValueOnce({ data: { created: 1, skipped: 0, status: STATUS }, error: null });
    await addStaffAction(null, { tenantId: TENANT, tenantSlug: "s", items: [{ fullName: " Ayşe ", phone: "0533" }] });
    expect(rpc).toHaveBeenCalledWith("onboarding_add_staff", { p_tenant_id: TENANT, p_items: [{ fullName: "Ayşe", phone: "0533" }] });
  });

  it("hours: validates weekday, time format and the staff list", async () => {
    rpc.mockResolvedValueOnce({ data: STATUS, error: null });
    const days = [{ weekday: 1, start: "09:00", end: "18:00" }];
    const ok = await applyWeeklyHoursAction(null, { tenantId: TENANT, tenantSlug: "s", staffIds: [STAFF], days });
    expect(ok.success).toBe(true);
    expect(rpc).toHaveBeenCalledWith("onboarding_apply_weekly_hours", { p_tenant_id: TENANT, p_staff_ids: [STAFF], p_days: days });
    rpc.mockClear();
    for (const bad of [
      { staffIds: [], days },
      { staffIds: ["x"], days },
      { staffIds: [STAFF], days: [{ weekday: 7, start: "09:00", end: "18:00" }] },
      { staffIds: [STAFF], days: [{ weekday: 1, start: "9:00", end: "18:00" }] },
    ]) {
      expect((await applyWeeklyHoursAction(null, { tenantId: TENANT, tenantSlug: "s", ...bad })).success).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("mapping: identifiers must be UUIDs", async () => {
    rpc.mockResolvedValueOnce({ data: STATUS, error: null });
    const assignments = [{ staffId: STAFF, serviceIds: [SERVICE] }];
    expect((await setStaffServicesAction(null, { tenantId: TENANT, tenantSlug: "s", assignments })).success).toBe(true);
    expect(rpc).toHaveBeenCalledWith("onboarding_set_staff_services", { p_tenant_id: TENANT, p_assignments: assignments });
    rpc.mockClear();
    for (const bad of [[], [{ staffId: "x", serviceIds: [] }], [{ staffId: STAFF, serviceIds: ["'; drop table x"] }]]) {
      expect((await setStaffServicesAction(null, { tenantId: TENANT, tenantSlug: "s", assignments: bad })).success).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
