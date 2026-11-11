// @vitest-environment jsdom
/**
 * Faz SAAS.1C.1 - the billing UI, rendered in jsdom with the REAL Turkish catalog (a templated message formatted without its values yields the
 * key path, exactly like next-intl in a browser) and a recording fake of the Supabase client. IDs UI (views), PG (page guards), PU (pure rules),
 * MS (message catalog), WR (no write control). No network, no database: the database side is tests/saas1c1-billing.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import trMessages from "@/messages/tr.json";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  requirePlatformAdmin: vi.fn(),
  getTenantAccess: vi.fn(),
  hasPermission: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: (...args: unknown[]) => h.rpc(...args) }) }));
vi.mock("@/lib/auth/session", () => ({
  requirePlatformAdmin: (...args: unknown[]) => h.requirePlatformAdmin(...args),
  getTenantAccess: (...args: unknown[]) => h.getTenantAccess(...args),
  hasPermission: (...args: unknown[]) => h.hasPermission(...args),
}));
vi.mock("@/lib/site-url", () => ({ getSiteUrl: () => "https://salon.example.test" }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => h.redirect(url),
  notFound: () => h.notFound(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => {
    const find = (key: string): unknown => {
      let node: unknown = trMessages;
      for (const part of `${namespace}.${key}`.split(".")) node = (node as Record<string, unknown>)?.[part];
      return node;
    };
    const t = (key: string, values?: Record<string, string | number>) => {
      const node = find(key);
      if (typeof node !== "string") return `${namespace}.${key}`;
      if (node.includes("{")) {
        if (!values) return `${namespace}.${key}`;
        return node.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k]));
      }
      return node;
    };
    t.raw = (key: string) => find(key);
    return t;
  },
}));

import SuperAdminBillingPage from "@/app/[locale]/super-admin/billing/page";
import SuperAdminSalonDetailPage from "@/app/[locale]/super-admin/salons/[tenantId]/page";
import SuperAdminLayout from "@/app/[locale]/super-admin/layout";
import TenantBillingPage from "@/app/[locale]/app/[tenantSlug]/billing/page";
import { BillingNoticeStrip, StaffLimitHint } from "@/components/billing/billing-views";
import { tenantTrialLine } from "@/components/billing/page-labels";
import { ACCESS_MODES, ACCESS_REASONS, BILLING_MODES, BILLING_FILTERS, SUBSCRIPTION_STATUSES, billingNotice, parseBillingFilter, staffLimitHint, type AccessState } from "@/lib/modules/billing/model";

const TENANT = "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";
const RAW_KEY = /(SuperAdmin|Billing)\.[a-zA-Z]/;

const state = (over: Partial<AccessState> = {}): AccessState => ({
  mode: "full",
  reason: "trial_active",
  daysRemaining: 20,
  trialEnding: false,
  status: "trialing",
  billingMode: "paid",
  planKey: "salon",
  trialStartedAt: "2026-11-01T10:00:00Z",
  trialEndsAt: "2026-12-01T10:00:00Z",
  graceEndsAt: "2026-12-15T10:00:00Z",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  enforcementEnabled: false,
  ...over,
});

const usage = { activeStaff: 6, branches: 1, services: 12, customers: 77, activeMembers: 2, appointmentsTotal: 92, appointmentsCreated30d: 35, treatmentPhotos: 0, treatmentPhotoBytes: 0, emailsSent30d: 9 };
const limits = [
  { key: "max_active_staff", used: 6, limit: 5, enforcement: "soft", state: "over" },
  { key: "max_branches", used: 1, limit: 1, enforcement: "hard", state: "at_limit" },
];

const row = (slug: string, over: Record<string, unknown> = {}) => ({
  tenantId: `id-${slug}`, name: `Salon ${slug}`, slug, tenantStatus: "trial", planKey: "salon", billingMode: "paid", status: "trialing", accessMode: "full",
  accessReason: "trial_active", daysRemaining: 20, trialEnding: false, trialEndsAt: "2026-12-01T10:00:00Z", graceEndsAt: "2026-12-15T10:00:00Z",
  overLimit: false, atLimit: false, readyTrialNotStarted: false, ...over,
});

const dashboard = { total: 4, trialNotStarted: 1, trialActive: 1, trialEnding: 1, grace: 1, readOnly: 1, blocked: 0, paidActive: 0, pilot: 2, complimentary: 0, internal: 1, noSubscription: 0, overLimit: 1, readyTrialNotStarted: 1, enforcementEnabled: false };

function route(over: { list?: unknown; detail?: unknown; mine?: unknown; dash?: unknown } = {}) {
  h.rpc.mockImplementation(async (name: string) => {
    if (name === "admin_billing_dashboard") return { data: over.dash ?? dashboard, error: null };
    if (name === "admin_billing_list") return { data: over.list ?? [row("a-ending", { trialEnding: true, daysRemaining: 3 }), row("b-over", { overLimit: true, accessReason: "pilot", billingMode: "pilot", status: "active" })], error: null };
    if (name === "admin_tenant_billing") {
      if (over.detail === null) return { data: null, error: { message: "platform admin required" } };
      return { data: over.detail ?? { tenantId: TENANT, subscriptionPresent: true, planKey: "salon", planName: "Salon", planPriceMonthly: null, accessState: state(), usage, limits, readyTrialNotStarted: true, events: [{ at: "2026-11-01T10:00:00Z", type: "created", fromStatus: null, toStatus: "trialing", reason: null }] }, error: null };
    }
    if (name === "get_my_billing_summary") return { data: over.mine === undefined ? { planKey: "salon", planName: "Salon", accessState: state(), usage, limits } : over.mine, error: over.mine === null ? { message: "not allowed" } : null };
    // the existing salon detail reads are not under test here: a minimal valid shape
    if (name === "admin_tenant_detail") return { data: detailFixture(), error: null };
    if (name === "admin_tenant_audit") return { data: [], error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
}

const detailFull = (over: Record<string, unknown> = {}) => ({
  overview: {
    tenantId: TENANT,
    name: "Güzel Salon",
    slug: "guzel-salon",
    accountStatus: "trial",
    lifecycle: "active",
    timezone: "Europe/Istanbul",
    currency: "TRY",
    createdAt: "2026-09-01T09:00:00Z",
    trialEndsAt: null,
    bookingPath: "/book/guzel-salon",
    setupComplete: true,
    readyForBooking: true,
    steps: ["profile", "services", "staff", "hours", "mapping", "booking", "ready"].map((key) => ({ key, done: true })),
    blockers: [],
    profileMissing: [],
    subscriptionStatus: null,
  },
  owners: [{ name: "Ayşe Sahip", email: "ayse@example.test", phone: "+905321112233", status: "active", lastSignInAt: "2026-10-27T08:00:00Z", staffLinked: false }],
  members: [
    { membershipId: "m1", displayName: "Ayşe Sahip", email: "ayse@example.test", roleName: "Salon Sahibi", isOwner: true, status: "active", linkedStaffName: null, lastSignInAt: null, since: "2026-09-01T09:00:00Z" },
    { membershipId: "m2", displayName: "Mehmet Usta", email: "mehmet@example.test", roleName: "Personel", isOwner: false, status: "active", linkedStaffName: "Mehmet Usta", lastSignInAt: null, since: "2026-09-02T09:00:00Z" },
  ],
  usage: { staff: 3, members: 2, services: 5, customers: 40, appointments: 120, appointmentsToday: 4, appointments7d: 21, treatmentPhotos: 2, commissionRules: 1, pendingInvitations: 0 },
  booking: { publicBookingEnabled: true, bookingEngineReady: true, engineBlockers: [], staffWithHours: 3, activeStaff: 3, bookablePaths: 9, directBookableServices: 4, inquiryServices: 1, firstAvailableSlotAt: "2026-10-30T09:15:00Z" },
  system: { lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(), ownersNeverSignedIn: false, oldestPendingInvitationAt: null, healthLevel: "ok", health: [] },
  ...over,
});

function detailFixture() {
  return detailFull();
}

beforeEach(() => {
  h.rpc.mockReset();
  h.requirePlatformAdmin.mockReset();
  h.requirePlatformAdmin.mockResolvedValue({ id: "admin" });
  h.getTenantAccess.mockReset();
  h.getTenantAccess.mockResolvedValue({ reason: "ok", tenant: { id: TENANT, slug: "salon-a" } });
  h.hasPermission.mockReset();
  h.hasPermission.mockResolvedValue(true);
  h.redirect.mockReset();
  h.redirect.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });
  h.notFound.mockReset();
  h.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
});
afterEach(() => cleanup());

const adminList = async (sp: Record<string, string> = {}) => SuperAdminBillingPage({ searchParams: Promise.resolve(sp) } as never);

describe("UI - Super Admin billing overview", () => {
  it("UI1 renders the counts, the enforcement-off note and one row per salon with plan, state, days and limit flags", async () => {
    route();
    const { container } = render(await adminList());
    const text = container.textContent ?? "";
    expect(text).toContain("Abonelik ve faturalandırma");
    expect(text).toContain("Zorlama kapalı");
    expect(container.querySelector('[data-enforcement="off"]')).toBeTruthy();
    expect(container.querySelector('[data-stat="Toplam salon"]')?.textContent).toContain("4");
    expect(container.querySelector('[data-stat="Deneme 7 gün içinde bitiyor"]')?.textContent).toContain("1");
    const rows = container.querySelectorAll("[data-billing-row]");
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain("Deneme sürüyor");
    expect(rows[0]!.textContent).toContain("3");
    expect(rows[1]!.textContent).toContain("Aşıyor");
    expect(rows[1]!.textContent).toContain("Pilot");
    expect(text).not.toMatch(RAW_KEY);
  });

  it("UI2 filter links carry the filter and search; the current one is marked; an unknown filter falls back to all", async () => {
    route();
    const { container } = render(await adminList({ filter: "grace", q: "emel" }));
    const links = [...container.querySelectorAll("nav a")] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      BILLING_FILTERS.map((f) => (f === "all" ? "/super-admin/billing?q=emel" : `/super-admin/billing?q=emel&filter=${f}`)),
    );
    expect(links.filter((a) => a.getAttribute("aria-current") === "true").map((a) => a.textContent)).toEqual(["Ek süre"]);
    expect(h.rpc).toHaveBeenCalledWith("admin_billing_list", { p_filter: "grace", p_search: "emel" });
    h.rpc.mockClear();
    route();
    render(await adminList({ filter: "<script>" }));
    expect(h.rpc).toHaveBeenCalledWith("admin_billing_list", { p_filter: "all", p_search: "" });
  });

  it("UI3 an empty result shows the empty sentence; a non-admin is sent away; any other failure surfaces as an error", async () => {
    route({ list: [] });
    const { container } = render(await adminList());
    expect(container.textContent).toContain("Bu filtreyle eşleşen salon yok.");
    h.rpc.mockImplementation(async () => ({ data: null, error: { message: "platform admin required" } }));
    await expect(adminList()).rejects.toThrow("NEXT_REDIRECT:/");
    h.rpc.mockImplementation(async () => ({ data: null, error: { message: "boom" } }));
    await expect(adminList()).rejects.toThrow("super admin billing unavailable");
  });

  it("UI4 the layout carries the Faturalandırma link next to Panel and Salonlar", async () => {
    const element = await SuperAdminLayout({ children: <div /> } as never);
    const { container } = render(element);
    expect([...container.querySelectorAll("nav a")].map((a) => a.getAttribute("href"))).toEqual(["/super-admin", "/super-admin/salons", "/super-admin/billing"]);
    expect(container.textContent).toContain("Faturalandırma");
  });
});

describe("UI - Super Admin salon detail billing section", () => {
  const detailPage = async () => SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never);

  it("UI5 shows plan, price (not yet defined), access, trial dates, usage vs limits and the event history", async () => {
    route();
    const { container } = render(await detailPage());
    const section = container.querySelector("[data-billing-section]")!;
    expect(section).toBeTruthy();
    const text = section.textContent ?? "";
    expect(text).toContain("Abonelik ve plan");
    expect(section.querySelector('[data-billing-field="plan"]')?.textContent).toContain("Salon");
    expect(section.querySelector('[data-billing-field="price"]')?.textContent).toContain("Henüz tanımlı değil");
    expect(section.querySelector('[data-billing-field="access"]')?.textContent).toContain("Tam erişim");
    expect(section.querySelector('[data-billing-field="reason"]')?.textContent).toContain("Deneme sürüyor");
    expect(section.querySelector('[data-billing-field="daysRemaining"]')?.textContent).toContain("20");
    expect(section.querySelector('[data-limit="max_active_staff"]')?.getAttribute("data-limit-state")).toBe("over");
    expect(section.querySelector('[data-limit="max_active_staff"]')?.textContent).toContain("6 / 5");
    expect(section.querySelector('[data-usage-item="customers"]')?.textContent).toContain("77");
    expect(section.querySelector("[data-ready-not-started]")).toBeTruthy();
    expect(section.querySelector("[data-billing-events]")?.textContent).toContain("Oluşturuldu");
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it("UI6 a salon without a subscription row says so; a billing read failure leaves the rest of the page intact", async () => {
    route({ detail: { tenantId: TENANT, subscriptionPresent: false, planKey: null, planName: null, planPriceMonthly: null, accessState: state({ mode: "full", reason: "no_subscription", status: null, billingMode: null, planKey: null, daysRemaining: null, trialStartedAt: null, trialEndsAt: null, graceEndsAt: null }), usage, limits: [], readyTrialNotStarted: false, events: [] } });
    const { container, unmount } = render(await detailPage());
    expect(container.querySelector("[data-billing-section]")?.textContent).toContain("abonelik kaydı yok");
    expect(container.textContent).not.toMatch(RAW_KEY);
    unmount();
    route({ detail: null });
    const again = render(await detailPage());
    expect(again.container.querySelector("[data-billing-section]")).toBeNull();
    expect(again.container.textContent).toContain("Güzel Salon");
  });
});

describe("PG - the salon's own plan page", () => {
  const page = async () => TenantBillingPage({ params: Promise.resolve({ tenantSlug: "salon-a" }) } as never);

  it("PG1 an Owner / Yönetici sees plan, billing type, access, the trial sentence, usage and limits (informational)", async () => {
    route();
    const { container } = render(await page());
    const text = container.textContent ?? "";
    expect(text).toContain("Plan ve kullanım");
    expect(text).toContain("hiçbir özelliğiniz bu bilgiye göre kapatılmaz");
    expect(container.querySelector("[data-plan-name]")?.textContent).toBe("Salon");
    expect(container.querySelector("[data-trial-line]")?.textContent).toContain("1.12.2026".replace(/\./g, ".")); // 01.12.2026 style date
    expect(container.querySelector("[data-trial-line]")?.textContent).toContain("20 gün kaldı");
    expect(container.querySelector('[data-limit="max_active_staff"]')?.textContent).toContain("Sınırı aşıyor");
    expect(text).toContain("engellemez");
    expect(text).not.toMatch(RAW_KEY);
  });

  it("PG2 someone without settings.manage AND staff.manage is redirected away; a failed read shows the unavailable line", async () => {
    route();
    h.hasPermission.mockResolvedValue(false);
    await expect(page()).rejects.toThrow("NEXT_REDIRECT:/app/salon-a");
    h.hasPermission.mockImplementation(async (_t: string, key: string) => key === "staff.manage");
    route({ mine: null });
    const { container } = render(await page());
    expect(container.textContent).toContain("Plan bilgisi şu an gösterilemiyor.");
    expect(container.querySelector("[data-tenant-plan]")).toBeNull();
  });

  it("PG3 a salon that is not reachable renders nothing and asks for nothing", async () => {
    h.getTenantAccess.mockResolvedValue({ reason: "not_found" });
    expect(await page()).toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("PU - pure rules", () => {
  it("PU1 billingNotice: only commercial states produce a notice", () => {
    expect(billingNotice(state({ mode: "full", reason: "trial_active", trialEnding: true, daysRemaining: 3 }))).toEqual({ kind: "trial_ending", days: 3 });
    expect(billingNotice(state({ mode: "full", reason: "trial_active", trialEnding: false }))).toBeNull();
    expect(billingNotice(state({ mode: "grace", reason: "trial_expired_grace", daysRemaining: 9 }))).toEqual({ kind: "grace", days: 9 });
    expect(billingNotice(state({ mode: "read_only", reason: "trial_expired" }))).toEqual({ kind: "expired" });
    expect(billingNotice(state({ mode: "blocked", reason: "suspended_by_platform" }))).toBeNull();
    for (const reason of ["pilot", "internal", "complimentary", "trial_not_started", "no_subscription", "active"] as const) {
      expect(billingNotice(state({ mode: "full", reason, trialEnding: false })), reason).toBeNull();
    }
    expect(billingNotice(null)).toBeNull();
    expect(billingNotice(state({ mode: "grace", daysRemaining: 0 }))).toEqual({ kind: "grace", days: 1 });
  });

  it("PU2 staffLimitHint: nothing while ok, a hint at the limit and over it, never about other limits", () => {
    expect(staffLimitHint(null)).toBeNull();
    expect(staffLimitHint([{ key: "max_active_staff", used: 2, limit: 5, enforcement: "soft", state: "ok" }])).toBeNull();
    expect(staffLimitHint([{ key: "max_active_staff", used: 5, limit: 5, enforcement: "soft", state: "at_limit" }])).toEqual({ state: "at_limit", used: 5, limit: 5 });
    expect(staffLimitHint([{ key: "max_active_staff", used: 6, limit: 5, enforcement: "soft", state: "over" }])).toEqual({ state: "over", used: 6, limit: 5 });
    expect(staffLimitHint([{ key: "max_branches", used: 1, limit: 1, enforcement: "hard", state: "at_limit" }])).toBeNull();
  });

  it("PU3 parseBillingFilter never trusts the URL", () => {
    expect(parseBillingFilter("grace")).toBe("grace");
    expect(parseBillingFilter(["trial", "x"])).toBe("trial");
    for (const bad of [undefined, "", "ALL", "drop table", "grace;"]) expect(parseBillingFilter(bad as never)).toBe("all");
  });

  it("PU4 the trial sentence for every state is real Turkish, with its values", async () => {
    expect(await tenantTrialLine(state({ reason: "trial_not_started" }))).toContain("kurulumu tamamladığınızda başlar");
    expect(await tenantTrialLine(state({ reason: "trial_active", daysRemaining: 12 }))).toMatch(/\d{2}\.\d{2}\.\d{4} tarihinde bitiyor \(12 gün kaldı\)/);
    expect(await tenantTrialLine(state({ mode: "grace", reason: "trial_expired_grace" }))).toMatch(/\d{2}\.\d{2}\.\d{4} tarihine kadar/);
    expect(await tenantTrialLine(state({ mode: "read_only", reason: "trial_expired" }))).toContain("hiçbir özelliğiniz kısıtlanmıyor");
    for (const reason of ["pilot", "internal", "complimentary"] as const) expect(await tenantTrialLine(state({ reason })), reason).toContain("bitiş tarihi yok");
    for (const reason of ACCESS_REASONS) expect(await tenantTrialLine(state({ reason })), reason).not.toMatch(RAW_KEY);
  });
});

describe("MS - the message catalog is complete in both namespaces", () => {
  const tr = trMessages as unknown as Record<string, Record<string, unknown>> & { SuperAdmin: { billing: Record<string, Record<string, string>> } };
  const spaces: [string, Record<string, Record<string, string>>][] = [
    ["Billing", tr.Billing as unknown as Record<string, Record<string, string>>],
    ["SuperAdmin.billing", tr.SuperAdmin.billing],
  ];
  it("MS1 reasons, modes, statuses, billing modes, limit states and usage keys all have a non-empty label with no placeholder", () => {
    for (const [name, ns] of spaces) {
      for (const k of ACCESS_REASONS) expect(ns.reasons![k], `${name}.reasons.${k}`).toMatch(/\S/);
      for (const k of ACCESS_MODES) expect(ns.modes![k], `${name}.modes.${k}`).toMatch(/\S/);
      for (const k of SUBSCRIPTION_STATUSES) expect(ns.statuses![k], `${name}.statuses.${k}`).toMatch(/\S/);
      for (const k of BILLING_MODES) expect(ns.billingModes![k], `${name}.billingModes.${k}`).toMatch(/\S/);
      for (const k of ["ok", "at_limit", "over"]) expect(ns.limitState![k], `${name}.limitState.${k}`).toMatch(/\S/);
      for (const k of ["activeStaff", "branches", "services", "customers", "activeMembers", "appointmentsTotal", "appointmentsCreated30d", "treatmentPhotos", "emailsSent30d"]) expect(ns.usage![k], `${name}.usage.${k}`).toMatch(/\S/);
      for (const [group, map] of Object.entries(ns)) {
        if (["reasons", "modes", "statuses", "billingModes", "limitState", "usage", "limitKeys"].includes(group)) for (const v of Object.values(map)) expect(v).not.toContain("{");
      }
    }
  });
});

describe("WR - nothing on any billing surface writes", () => {
  it("WR1 the admin overview has no button and no POST form; the only form is the GET search", async () => {
    route();
    const { container } = render(await adminList());
    expect(container.querySelectorAll("button").length).toBe(1); // the search submit
    for (const f of container.querySelectorAll("form")) expect((f.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
  });

  it("WR2 the admin billing section and the salon plan page contain no form, no input and no button", async () => {
    route();
    const detail = render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    const section = detail.container.querySelector("[data-billing-section]")!;
    expect(section.querySelectorAll("form, input, textarea, select, button").length).toBe(0);
    detail.unmount();
    const plan = render(await TenantBillingPage({ params: Promise.resolve({ tenantSlug: "salon-a" }) } as never));
    expect(plan.container.querySelectorAll("form, input, textarea, select, button").length).toBe(0);
  });

  it("WR3 the notice strip and the staff hint are plain text with at most one link", () => {
    const strip = render(<BillingNoticeStrip notice={{ kind: "expired" }} text="x" href="/app/s/billing" cta="Plan ve kullanım" />);
    expect(strip.container.querySelectorAll("button, form, input").length).toBe(0);
    expect(strip.container.querySelectorAll("a").length).toBe(1);
    strip.unmount();
    const hint = render(<StaffLimitHint text="y" />);
    expect(hint.container.querySelectorAll("a, button, form, input").length).toBe(0);
  });

  it("WR4 every access reason and mode renders with its Turkish label and never a raw key", async () => {
    const rows = ACCESS_REASONS.map((reason, i) => row(`r${i}`, { accessReason: reason, accessMode: ACCESS_MODES[i % 4] }));
    route({ list: rows });
    const { container } = render(await adminList());
    expect(container.querySelectorAll("[data-billing-row]").length).toBe(ACCESS_REASONS.length);
    expect(container.textContent).not.toMatch(RAW_KEY);
    for (const mode of ACCESS_MODES) expect(container.querySelector(`[data-access-mode="${mode}"]`), mode).toBeTruthy();
  });
});
