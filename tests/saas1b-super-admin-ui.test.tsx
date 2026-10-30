// @vitest-environment jsdom
/**
 * Faz SAAS.1B — the Super Admin console, rendered in jsdom with the REAL Turkish catalog and a recording fake of the Supabase client.
 * IDs UI (pages and components), PG (page guards and request validation), CB (copy button), PU (pure helpers). No network, no database:
 * the database side of the same features is tests/saas1b-super-admin.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import trMessages from "@/messages/tr.json";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  requirePlatformAdmin: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: (...args: unknown[]) => h.rpc(...args) }) }));
vi.mock("@/lib/auth/session", () => ({ requirePlatformAdmin: (...args: unknown[]) => h.requirePlatformAdmin(...args) }));
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
  // Faithful to next-intl: a message with {placeholders} formatted WITHOUT values fails and yields the key path (this is what the real
  // browser showed for t("daysAgo")); t.raw() returns the unformatted template.
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

import SuperAdminDashboardPage from "@/app/[locale]/super-admin/page";
import SuperAdminSalonsPage from "@/app/[locale]/super-admin/salons/page";
import SuperAdminSalonDetailPage from "@/app/[locale]/super-admin/salons/[tenantId]/page";
import SuperAdminLayout from "@/app/[locale]/super-admin/layout";
import { CopyButton } from "@/components/super-admin/copy-button";
import { relativeDays } from "@/components/super-admin/format";
import { listHref } from "@/components/super-admin/salon-filters";
import { mapAdminError, PAGE_SIZE, parseListParams } from "@/lib/modules/platform/admin";

const TENANT = "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";

beforeEach(() => {
  h.rpc.mockReset();
  h.requirePlatformAdmin.mockReset();
  h.requirePlatformAdmin.mockResolvedValue({ id: "admin" });
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

const dashboard = {
  salonsTotal: 7,
  lifecycle: { active: 3, setup: 2, inactive: 1, suspended: 1, canceled: 0 },
  bookingActive: 3,
  ownersTotal: 6,
  usersTotal: 11,
  staffTotal: 9,
  appointmentsToday: 4,
  appointments7d: 21,
  health: { critical: 1, warning: 2 },
  recentlyCreated: [{ tenantId: TENANT, name: "Yeni Salon", slug: "yeni-salon", createdAt: "2026-10-28T09:00:00Z", lifecycle: "setup" }],
  needsAttention: [
    { tenantId: TENANT, name: "Bozuk Salon", slug: "bozuk-salon", healthLevel: "critical", health: [{ severity: "critical", code: "booking_broken" }, { severity: "info", code: "new_salon" }] },
    { tenantId: "11111111-2222-4333-8444-555555555555", name: "Durgun Salon", slug: "durgun-salon", healthLevel: "warning", health: [{ severity: "warning", code: "no_recent_activity" }] },
  ],
};

const salonRow = (over: Record<string, unknown> = {}) => ({
  tenant_id: TENANT,
  name: "Güzel Salon",
  slug: "guzel-salon",
  account_status: "trial",
  lifecycle: "active",
  setup_complete: true,
  booking_enabled: true,
  primary_owner_name: "Ayşe Sahip",
  primary_owner_email: "ayse@example.test",
  owner_count: 1,
  staff_count: 3,
  service_count: 5,
  customer_count: 40,
  appointment_count: 120,
  created_at: "2026-09-01T09:00:00Z",
  last_activity_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  health_level: "ok",
  health: [],
  total_count: 1,
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
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

const audit = [
  { occurred_at: "2026-10-28T10:00:00Z", action: "tenant.created", entity_type: "tenant", actor_type: "system" },
  { occurred_at: "2026-10-28T11:00:00Z", action: "some.future_event", entity_type: "x", actor_type: "user" },
];

function route(overrides: Record<string, unknown> = {}) {
  h.rpc.mockImplementation(async (name: string) => {
    if (name in overrides) return overrides[name];
    if (name === "admin_dashboard_summary") return { data: dashboard, error: null };
    if (name === "admin_list_tenants") return { data: [salonRow()], error: null };
    if (name === "admin_tenant_detail") return { data: detail(), error: null };
    if (name === "admin_tenant_audit") return { data: audit, error: null };
    return { data: null, error: { message: "unexpected" } };
  });
}

const forbidden = { data: null, error: { message: "platform admin required", code: "P0001" } };

describe("UI dashboard", () => {
  it("UI1 shows the operational counts, the attention list with severities and the recently created salons", async () => {
    route();
    render(await SuperAdminDashboardPage());
    expect(screen.getByRole("heading", { name: "Platform paneli" })).toBeTruthy();
    const stat = (label: string) => within(document.querySelector(`[data-stat="${label}"]`) as HTMLElement).getByText(/^\d+$/).textContent;
    expect(stat("Toplam salon")).toBe("7");
    expect(stat("Aktif")).toBe("3");
    expect(stat("Kurulumu tamamlanmamış")).toBe("2");
    expect(stat("Askıda veya iptal")).toBe("1");
    expect(stat("Online randevusu açık")).toBe("3");
    expect(stat("Salon sahibi")).toBe("6");
    expect(stat("Personel")).toBe("9");
    expect(stat("Bugünkü randevu")).toBe("4");
    expect(stat("Kritik sorun")).toBe("1");
    const attention = document.querySelector('[data-attention="bozuk-salon"]') as HTMLElement;
    expect(within(attention).getByText("Online randevu açık ama randevu alınamıyor")).toBeTruthy();
    expect(within(attention).queryByText("Yeni salon, kuruluyor")).toBeNull(); // information is not shown as "needs attention"
    expect(document.querySelector('[data-recent="yeni-salon"]')).toBeTruthy();
    expect((screen.getByRole("link", { name: /Bozuk Salon/ }) as HTMLAnchorElement).getAttribute("href")).toBe(`/super-admin/salons/${TENANT}`);
  });

  it("UI2 an empty platform shows the empty state and no numbers", async () => {
    route({ admin_dashboard_summary: { data: { ...dashboard, salonsTotal: 0, recentlyCreated: [], needsAttention: [] }, error: null } });
    render(await SuperAdminDashboardPage());
    expect(screen.getByText("Henüz kayıtlı salon yok.")).toBeTruthy();
    expect(document.querySelector("[data-stat]")).toBeNull();
  });

  it("UI3 nothing needs attention: says so instead of an empty box", async () => {
    route({ admin_dashboard_summary: { data: { ...dashboard, needsAttention: [] }, error: null } });
    render(await SuperAdminDashboardPage());
    expect(screen.getByText("Şu anda ilgi gerektiren salon yok.")).toBeTruthy();
  });

  it("UI4 the console is read-only: no form, no submit button, no write control anywhere on the dashboard", async () => {
    route();
    const { container } = render(await SuperAdminDashboardPage());
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('button[type="submit"], input[type="submit"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Askıya al|Aktifleştir|Sil|Giriş yap/);
  });
});

describe("UI salon list", () => {
  it("UI5 one row per salon with Owner name and e-mail, status badge, setup, booking, counts and relative last activity", async () => {
    route();
    render(await SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never));
    const row = document.querySelector('[data-slug="guzel-salon"]') as HTMLElement;
    expect(within(row).getByText("Güzel Salon")).toBeTruthy();
    expect(within(row).getByText("Ayşe Sahip")).toBeTruthy();
    expect(within(row).getByText("ayse@example.test")).toBeTruthy();
    expect(within(row).getByText("Aktif")).toBeTruthy();
    expect(within(row).getByText("Tamam")).toBeTruthy();
    expect(within(row).getByText("Açık")).toBeTruthy();
    expect(within(row).getByText("2 gün önce")).toBeTruthy();
    expect(within(row).getByText("120")).toBeTruthy();
    expect((within(row).getByRole("link", { name: "Güzel Salon" }) as HTMLAnchorElement).getAttribute("href")).toBe(`/super-admin/salons/${TENANT}`);
  });

  it("UI6 a salon without an Owner is flagged in the Owner column, and a critical salon carries its badge on the row", async () => {
    route({
      admin_list_tenants: {
        data: [salonRow({ slug: "sahipsiz", name: "Sahipsiz", primary_owner_name: null, primary_owner_email: null, owner_count: 0, health_level: "critical", health: [{ severity: "critical", code: "no_owner" }] })],
        error: null,
      },
    });
    render(await SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never));
    const row = document.querySelector('[data-slug="sahipsiz"]') as HTMLElement;
    expect(within(row).getByText("Sahip yok")).toBeTruthy();
    expect(row.querySelector('[data-health="critical"]')).toBeTruthy();
  });

  it("UI7 filter chips are links, the active one is marked, and every chip keeps the search text", async () => {
    route();
    render(await SuperAdminSalonsPage({ searchParams: Promise.resolve({ q: "ayse", filter: "setup" }) } as never));
    const chips = within(screen.getByRole("navigation", { name: "filter" })).getAllByRole("link");
    expect(chips).toHaveLength(10);
    const active = chips.filter((c) => c.getAttribute("aria-current") === "true");
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe("Kurulumda");
    for (const chip of chips) expect(chip.getAttribute("href")).toContain("q=ayse");
    expect((document.querySelector("#salon-search") as HTMLInputElement).value).toBe("ayse");
    expect((document.querySelector('input[name="filter"]') as HTMLInputElement).value).toBe("setup"); // the active filter survives a new search
  });

  it("UI8 an empty answer shows the right empty state: 'no match' when a filter or search is active, 'no salons yet' otherwise", async () => {
    route({ admin_list_tenants: { data: [], error: null } });
    render(await SuperAdminSalonsPage({ searchParams: Promise.resolve({ q: "yok" }) } as never));
    expect(screen.getByText("Bu ölçütlere uyan salon yok.")).toBeTruthy();
    cleanup();
    render(await SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never));
    expect(screen.getByText("Henüz kayıtlı salon yok.")).toBeTruthy();
  });

  it("UI9 paging: total, page numbers and previous/next links carrying the current filter", async () => {
    route({ admin_list_tenants: { data: [salonRow({ total_count: 60 })], error: null } });
    render(await SuperAdminSalonsPage({ searchParams: Promise.resolve({ page: "2", filter: "active" }) } as never));
    expect(screen.getByText("60 salon")).toBeTruthy();
    expect(screen.getByText("Sayfa 2 / 3")).toBeTruthy();
    expect((screen.getByRole("link", { name: "Önceki" }) as HTMLAnchorElement).getAttribute("href")).toBe("/super-admin/salons?filter=active");
    expect((screen.getByRole("link", { name: "Sonraki" }) as HTMLAnchorElement).getAttribute("href")).toBe("/super-admin/salons?filter=active&page=3");
  });

  it("UI10 the list is read-only too: the only form is the GET search form", async () => {
    route();
    const { container } = render(await SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never));
    const forms = Array.from(container.querySelectorAll("form"));
    expect(forms).toHaveLength(1);
    expect(forms[0]!.getAttribute("method")).toBe("get");
    expect(forms[0]!.getAttribute("action")).toBe("/super-admin/salons");
  });
});

describe("UI salon detail", () => {
  it("UI11 shows every section: overview and setup steps, Owner and members, usage, booking, system and the history", async () => {
    route();
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    const titles: Record<string, string> = { "sec-overview": "Genel bakış", "sec-owners": "Sahip ve üyeler", "sec-usage": "Kullanım", "sec-booking": "Online randevu", "sec-system": "Sistem", "sec-audit": "Yönetim geçmişi" };
    for (const [id, title] of Object.entries(titles)) expect(document.getElementById(id)?.textContent, id).toBe(title);
    expect(screen.getByRole("heading", { name: "Güzel Salon" })).toBeTruthy();
    expect(document.querySelectorAll("[data-step]")).toHaveLength(7);
    expect(Array.from(document.querySelectorAll("[data-step]")).every((el) => el.getAttribute("data-done") === "true")).toBe(true);
    expect(screen.getByText("Eksik yok: salon randevu almaya hazır.")).toBeTruthy();
    expect(screen.getByText("Europe/Istanbul")).toBeTruthy();
  });

  it("UI12 the Owner's contact is on the page (name, e-mail, phone), members show role and staff linkage", async () => {
    route();
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    const owners = document.querySelector("[data-owners]") as HTMLElement;
    expect(within(owners).getByText("Ayşe Sahip")).toBeTruthy();
    expect(within(owners).getByText("ayse@example.test")).toBeTruthy();
    expect(within(owners).getByText("+905321112233")).toBeTruthy();
    const members = document.querySelector("[data-members]") as HTMLElement;
    expect(within(members).getByText("Personel")).toBeTruthy();
    expect(within(members).getAllByText("Mehmet Usta").length).toBeGreaterThanOrEqual(2); // display name and linked staff name
  });

  it("UI13 usage counts are numbers only, with the note that customers are not shown", async () => {
    route();
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    const stat = (label: string) => within(document.querySelector(`[data-stat="${label}"]`) as HTMLElement).getByText(/^\d+$/).textContent;
    expect(stat("Müşteri")).toBe("40");
    expect(stat("Toplam randevu")).toBe("120");
    expect(stat("Tedavi fotoğrafı")).toBe("2");
    expect(stat("Komisyon kuralı")).toBe("1");
    expect(screen.getByText(/Müşteriler yalnızca sayılır/)).toBeTruthy();
  });

  it("UI14 booking: link (new tab, no opener), copy buttons, direct versus inquiry services, first free slot", async () => {
    route();
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    const open = screen.getByRole("link", { name: "Randevu sayfasını aç" }) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe("https://salon.example.test/book/guzel-salon");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("button", { name: "Bağlantıyı kopyala" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Salon kimliğini kopyala" })).toBeTruthy();
    expect(screen.getByText("Doğrudan randevulu hizmet")).toBeTruthy();
    expect(screen.getByText("Teklif usulü hizmet")).toBeTruthy();
    expect(screen.queryByText("Boş saat bulunamadı")).toBeNull();
  });

  it("UI15 a salon with problems shows its blockers (with the missing profile parts) and its health signals", async () => {
    route({
      admin_tenant_detail: {
        data: detail({
          overview: { ...detail().overview, lifecycle: "setup", setupComplete: false, readyForBooking: false, steps: ["profile", "services", "staff", "hours", "mapping", "booking", "ready"].map((key) => ({ key, done: false })), blockers: ["salon_profile_missing", "no_services", "public_booking_disabled"], profileMissing: ["branch", "phone"] },
          booking: { ...detail().booking, publicBookingEnabled: false, bookingEngineReady: false, firstAvailableSlotAt: null },
          system: { ...detail().system, healthLevel: "warning", ownersNeverSignedIn: true, health: [{ severity: "warning", code: "setup_stalled" }, { severity: "warning", code: "owner_never_signed_in" }] },
        }),
        error: null,
      },
    });
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    expect(screen.getByText(/Salon profili eksik/)).toBeTruthy();
    expect(screen.getByText(/şube, telefon/)).toBeTruthy();
    expect(screen.getByText("Hizmet yok")).toBeTruthy();
    expect(screen.getByText("Online randevu kapalı")).toBeTruthy();
    expect(document.querySelector('[data-signal="setup_stalled"]')).toBeTruthy();
    expect(screen.getByText("Boş saat bulunamadı")).toBeTruthy();
  });

  it("UI16 the history shows when / what / who with Turkish labels and falls back to the raw key for an unknown event", async () => {
    route();
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    const table = document.querySelector("[data-audit]") as HTMLElement;
    expect(within(table).getByText("Salon oluşturuldu")).toBeTruthy();
    expect(within(table).getByText("Sistem")).toBeTruthy();
    expect(within(table).getByText("some.future_event")).toBeTruthy();
    expect(within(table).getByText("Salon kullanıcısı")).toBeTruthy();
  });

  it("UI17 subscription: the real value when there is one, an honest placeholder when billing does not exist yet (nothing fake)", async () => {
    route();
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    expect(document.querySelector('[data-subscription="none"]')?.textContent).toBe("Faturalandırma henüz tanımlı değil");
    cleanup();
    route({ admin_tenant_detail: { data: detail({ overview: { ...detail().overview, subscriptionStatus: "past_due" } }), error: null } });
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    expect(document.querySelector('[data-subscription="past_due"]')).toBeTruthy();
  });

  it("UI18 Emel-like: ONE Owner who is also the only staff member shows once, linked, with a team of one and no missing setup", async () => {
    route({
      admin_tenant_detail: {
        data: detail({
          owners: [{ name: "Emel Sahip", email: "emel@example.test", phone: null, status: "active", lastSignInAt: null, staffLinked: true }],
          members: [{ membershipId: "m1", displayName: "Emel Sahip", email: "emel@example.test", roleName: "Salon Sahibi", isOwner: true, status: "active", linkedStaffName: "Emel Sahip", lastSignInAt: null, since: "2026-09-01T09:00:00Z" }],
          usage: { ...detail().usage, staff: 1, members: 1, customers: 0, appointments: 0 },
        }),
        error: null,
      },
    });
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    expect(within(document.querySelector("[data-owners]") as HTMLElement).getAllByRole("row")).toHaveLength(2); // header + one Owner
    expect(within(document.querySelector("[data-members]") as HTMLElement).getAllByRole("row")).toHaveLength(2); // header + one member
    expect(within(document.querySelector("[data-owners]") as HTMLElement).getByText("Bağlı")).toBeTruthy();
    expect(screen.queryByText(/Eksikler?$/)).not.toBeNull(); // the heading exists...
    expect(screen.getByText("Eksik yok: salon randevu almaya hazır.")).toBeTruthy(); // ...and says nothing is missing
    expect(document.querySelector("[data-no-owner]")).toBeNull();
  });

  it("UI19 a salon without an active Owner says so on the detail page", async () => {
    route({ admin_tenant_detail: { data: detail({ owners: [] }), error: null } });
    render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    expect(document.querySelector("[data-no-owner]")?.textContent).toBe("Aktif salon sahibi yok");
  });

  it("UI20 the detail page has no form and no write control: nothing to submit, nothing to impersonate", async () => {
    route();
    const { container } = render(await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never));
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('input, textarea, select, button[type="submit"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Askıya al|Aktifleştir|Sil\b|Salon olarak gir|Şifre sıfırla/);
  });
});

describe("PG page guards and request validation", () => {
  it("PG1 a refused caller is sent away from every page, nothing is rendered, no other call is made", async () => {
    route({ admin_dashboard_summary: forbidden, admin_list_tenants: forbidden, admin_tenant_detail: forbidden, admin_tenant_audit: forbidden });
    await expect(SuperAdminDashboardPage()).rejects.toThrow("NEXT_REDIRECT:/");
    await expect(SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never)).rejects.toThrow("NEXT_REDIRECT:/");
    await expect(SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never)).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("PG2 'authentication required' and a database permission error are refusals too", async () => {
    for (const error of [{ message: "authentication required" }, { message: "permission denied for function admin_list_tenants", code: "42501" }]) {
      route({ admin_list_tenants: { data: null, error } });
      await expect(SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never)).rejects.toThrow("NEXT_REDIRECT:/");
    }
  });

  it("PG3 a real failure is not disguised as 'no salons': it throws (the error boundary shows it) instead of rendering an empty console", async () => {
    route({ admin_list_tenants: { data: null, error: { message: "connection reset" } } });
    await expect(SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never)).rejects.toThrow("super admin salon list unavailable");
    route({ admin_dashboard_summary: { data: null, error: { message: "boom" } } });
    await expect(SuperAdminDashboardPage()).rejects.toThrow("super admin dashboard unavailable");
  });

  it("PG4 a malformed salon id never reaches the database; an unknown salon is a 404", async () => {
    route();
    for (const bad of ["not-a-uuid", "../../etc/passwd", "0b1c2d3e-4f50-4162-8394", `${TENANT}'; drop table tenants; --`, ""]) {
      await expect(SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: bad }) } as never), bad).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(h.rpc).not.toHaveBeenCalled();
    route({ admin_tenant_detail: { data: null, error: { message: "tenant not found" } } });
    await expect(SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("PG5 request values are validated before they are sent: unknown filter/sort fall back, page is bounded, search is trimmed and capped", async () => {
    route();
    await SuperAdminSalonsPage({ searchParams: Promise.resolve({ q: "  Ayşe  ", filter: "drop table", sort: "x; --", page: "-3" }) } as never);
    expect(h.rpc).toHaveBeenCalledWith("admin_list_tenants", { p_search: "Ayşe", p_filter: "all", p_sort: "created_desc", p_limit: PAGE_SIZE, p_offset: 0 });
    h.rpc.mockClear();
    await SuperAdminSalonsPage({ searchParams: Promise.resolve({ q: "x".repeat(500), filter: "attention", sort: "name_asc", page: "3" }) } as never);
    const args = h.rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(String(args.p_search)).toHaveLength(100);
    expect(args).toMatchObject({ p_filter: "attention", p_sort: "name_asc", p_limit: PAGE_SIZE, p_offset: 2 * PAGE_SIZE });
  });

  it("PG6 only the four admin functions are ever called, and only with the caller's own client (no other table or function)", async () => {
    route();
    await SuperAdminDashboardPage();
    await SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never);
    await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never);
    const names = new Set(h.rpc.mock.calls.map((c) => c[0]));
    expect([...names].sort()).toEqual(["admin_dashboard_summary", "admin_list_tenants", "admin_tenant_audit", "admin_tenant_detail"]);
  });

  it("PG7 the layout asks for a platform admin BEFORE it renders anything: a refused visitor gets no children and no navigation", async () => {
    h.requirePlatformAdmin.mockImplementation(async () => {
      throw new Error("NEXT_REDIRECT:/");
    });
    await expect(SuperAdminLayout({ children: <p>secret content</p> } as never)).rejects.toThrow("NEXT_REDIRECT:/");
    expect(document.body.textContent).not.toContain("secret content");
  });

  it("PG8 for a platform admin the layout renders the navigation and the content", async () => {
    render(await SuperAdminLayout({ children: <p>içerik</p> } as never));
    expect(screen.getByText("içerik")).toBeTruthy();
    expect((screen.getByRole("link", { name: "Salonlar" }) as HTMLAnchorElement).getAttribute("href")).toBe("/super-admin/salons");
    expect(screen.getByText("Bu ekran salt okunurdur: salonların verisi burada değiştirilemez.")).toBeTruthy();
  });
});

describe("CB copy button and PU pure helpers", () => {
  it("CB1 copies exactly the value it was given and confirms; a refused clipboard does not throw", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyButton value="https://salon.example.test/book/x" label="Kopyala" doneLabel="Kopyalandı" />);
    fireEvent.click(screen.getByRole("button", { name: "Kopyala" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Kopyalandı" })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("https://salon.example.test/book/x");
    cleanup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<CopyButton value="x" label="Kopyala" doneLabel="Kopyalandı" />);
    fireEvent.click(screen.getByRole("button", { name: "Kopyala" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Kopyala" })).toBeTruthy());
  });

  it("PU1 parseListParams: defaults, arrays, bounds", () => {
    expect(parseListParams({})).toEqual({ search: "", filter: "all", sort: "created_desc", page: 1 });
    expect(parseListParams({ q: ["a", "b"], filter: ["booking_on"], page: ["4"] })).toMatchObject({ search: "a", filter: "booking_on", page: 4 });
    expect(parseListParams({ page: "0" }).page).toBe(1);
    expect(parseListParams({ page: "99999999" }).page).toBe(1);
    expect(parseListParams({ page: "abc" }).page).toBe(1);
    expect(parseListParams({ filter: "ALL", sort: "CREATED_ASC" })).toMatchObject({ filter: "all", sort: "created_desc" }); // exact match only
  });

  it("PU2 mapAdminError: refusals, not found, anything else", () => {
    expect(mapAdminError({ message: "platform admin required" })).toBe("forbidden");
    expect(mapAdminError({ message: "authentication required" })).toBe("forbidden");
    expect(mapAdminError({ message: "permission denied for function x", code: "42501" })).toBe("forbidden");
    expect(mapAdminError({ message: "boom", code: "42501" })).toBe("forbidden"); // by SQLSTATE alone
    expect(mapAdminError({ message: "tenant not found" })).toBe("not_found");
    expect(mapAdminError({ message: "invalid filter" })).toBe("error");
    expect(mapAdminError(null)).toBe("error");
  });

  it("PU3 listHref leaves defaults out and encodes the rest", () => {
    expect(listHref({})).toBe("/super-admin/salons");
    expect(listHref({ search: "a b&c", filter: "setup", sort: "name_asc", page: 2 })).toBe("/super-admin/salons?q=a+b%26c&filter=setup&sort=name_asc&page=2");
    expect(listHref({ filter: "all", sort: "created_desc", page: 1 })).toBe("/super-admin/salons");
  });

  it("PU4 relativeDays counts Istanbul calendar days", () => {
    const now = new Date("2026-10-30T10:00:00Z");
    expect(relativeDays(null, now)).toEqual({ kind: "never" });
    expect(relativeDays("2026-10-30T01:00:00Z", now)).toEqual({ kind: "today" });
    expect(relativeDays("2026-10-29T20:30:00Z", now)).toEqual({ kind: "yesterday" }); // 23:30 in Istanbul on the 29th: the previous LOCAL day
    expect(relativeDays("2026-10-29T21:30:00Z", now)).toEqual({ kind: "today" }); // 00:30 in Istanbul on the 30th: the same local day
    expect(relativeDays("2026-10-27T10:00:00Z", now)).toEqual({ kind: "days", n: 3 });
  });
});

describe("UI message keys", () => {
  it("UI21 no page ever shows a raw message key (a templated message without values would, with the real translator)", async () => {
    route();
    for (const [name, element] of [
      ["dashboard", await SuperAdminDashboardPage()],
      ["list", await SuperAdminSalonsPage({ searchParams: Promise.resolve({}) } as never)],
      ["list page 2", await SuperAdminSalonsPage({ searchParams: Promise.resolve({ page: "2" }) } as never)],
      ["detail", await SuperAdminSalonDetailPage({ params: Promise.resolve({ tenantId: TENANT }) } as never)],
    ] as const) {
      const { container, unmount } = render(element);
      expect(container.textContent, name).not.toMatch(/SuperAdmin\.[a-zA-Z]/);
      unmount();
    }
  });
});
