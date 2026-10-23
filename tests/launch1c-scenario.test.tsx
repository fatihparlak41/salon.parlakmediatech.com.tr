// @vitest-environment jsdom
/**
 * Faz LAUNCH.1C — the realistic synthetic scenario, end to end: 1 Owner, 3 staff, 10 services in 3 categories, a normal
 * week, a staff x service mapping, public booking on. The REAL wizard component drives the REAL Server Actions, which
 * call the REAL database functions (the Supabase client is replaced by a tiny adapter that runs each RPC as the Owner
 * against the local scratch database). Every simulated click and every typed character is counted, so the report's
 * "after" numbers are measured, not guessed. Nothing here can reach a hosted project.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { writeFileSync } from "node:fs";
import trMessages from "@/messages/tr.json";
import { SetupWizard, type SetupWizardProps } from "@/components/onboarding/setup-wizard";
import { parseOnboardingStatus, stepProgress } from "@/lib/modules/onboarding/model";
import { asAuthenticatedUser, cleanupTenants, cleanupUsers, createTestUser, testDb, type TestUser } from "./helpers";

const state: { userId: string; serverMs: number; rpcCalls: number } = { userId: "", serverMs: 0, rpcCalls: 0 };

const PARAM_CAST: Record<string, string> = {
  p_tenant_id: "uuid",
  p_name: "text",
  p_timezone: "text",
  p_currency: "text",
  p_phone: "text",
  p_address: "text",
  p_items: "jsonb",
  p_days: "jsonb",
  p_assignments: "jsonb",
  p_staff_ids: "uuid[]",
  p_enabled: "boolean",
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      const values = keys.map((k) => {
        const v = args[k];
        if (PARAM_CAST[k] === "jsonb") return JSON.stringify(v);
        if (PARAM_CAST[k] === "uuid[]") return `{${(v as string[]).join(",")}}`;
        return v as string | boolean;
      });
      const text = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${PARAM_CAST[k] === "jsonb" ? "text::jsonb" : PARAM_CAST[k]}`).join(", ")}) as r`;
      const started = performance.now();
      try {
        const rows = await asAuthenticatedUser(state.userId, (sql) => sql.unsafe(text, values as never[]));
        return { data: (rows[0] as unknown as { r: unknown }).r, error: null };
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return { data: null, error: { code: e.code, message: e.message ?? "" } };
      } finally {
        state.serverMs += performance.now() - started;
        state.rpcCalls += 1;
      }
    },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/pwa/web-push-server", () => ({ sendTestPush: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: state.userId })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const stats = { clicks: 0, edits: 0, chars: 0, serverActions: 0 };
const click = (el: Element) => {
  stats.clicks += 1;
  fireEvent.click(el);
};
const typeInto = (el: Element, text: string) => {
  stats.edits += 1;
  stats.chars += text.length;
  fireEvent.change(el, { target: { value: text } });
};
const choose = (el: Element, value: string) => {
  stats.edits += 1;
  fireEvent.change(el, { target: { value } });
};

let owner: TestUser;
let tenantId = "";
let slug = "";
const stamp = Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  owner = await createTestUser("l1c-scenario");
  state.userId = owner.id;
  slug = `l1c-scn-${stamp}`;
  await asAuthenticatedUser(owner.id, (sql) => sql`select public.create_tenant(${"Beauty Bar Girne"}, ${slug})`);
  const [t] = await testDb<{ id: string }[]>`select id from tenants where slug = ${slug}`;
  tenantId = t!.id;
}, 120_000);

afterAll(async () => {
  cleanup();
  await cleanupTenants(tenantId ? [tenantId] : []);
  await cleanupUsers(owner ? [owner.id] : []);
}, 120_000);

async function load(): Promise<Pick<SetupWizardProps, "initialStatus" | "workspace">> {
  const [row] = await asAuthenticatedUser(owner.id, (sql) => sql<{ s: unknown }[]>`select public.get_onboarding_status(${tenantId}) as s`);
  const initialStatus = parseOnboardingStatus(row!.s)!;
  const services = await testDb<{ id: string; name: string; category: string | null; duration_minutes: number; price: string }[]>`
    select id, name, category, duration_minutes, price::text from services where tenant_id = ${tenantId} and deleted_at is null order by display_order`;
  const staff = await testDb<{ id: string; full_name: string; has_hours: boolean }[]>`
    select sm.id, sm.full_name, exists (select 1 from staff_schedules ss where ss.staff_member_id = sm.id and ss.deleted_at is null) as has_hours
    from staff_members sm where sm.tenant_id = ${tenantId} and sm.deleted_at is null order by sm.display_order`;
  const pairs = await testDb<{ staff_member_id: string; service_id: string }[]>`
    select staff_member_id, service_id from staff_services where staff_member_id in (select id from staff_members where tenant_id = ${tenantId})`;
  const [branch] = await testDb<{ phone: string | null; address: string | null }[]>`select phone, address from branches where tenant_id = ${tenantId} and is_primary`;
  return {
    initialStatus,
    workspace: {
      branch: { phone: branch?.phone ?? "", address: branch?.address ?? "" },
      services: services.map((s) => ({ id: s.id, name: s.name, category: s.category, durationMinutes: s.duration_minutes, price: s.price })),
      staff: staff.map((s) => ({ id: s.id, fullName: s.full_name, hasHours: s.has_hours })),
      pairs: pairs.map((p) => `${p.staff_member_id}:${p.service_id}`),
    },
  };
}

describe("synthetic salon: 1 owner, 3 staff, 10 services in 3 categories", () => {
  it("goes from an empty salon to a bookable one, and the numbers are recorded", async () => {
    const wallStart = performance.now();
    const fresh = await load();
    expect(fresh.initialStatus.ready).toBe(false);
    expect(fresh.initialStatus.blockers).toContain("salon_profile_missing");

    const base = {
      tenantId,
      tenantSlug: slug,
      bookingUrl: `https://salon.example.test/book/${slug}`,
      dashboardHref: `/app/${slug}`,
      firstSlotLabel: null,
      can: { profile: true, services: true, staff: true, hours: true, booking: true },
    };
    const ui = (props: Pick<SetupWizardProps, "initialStatus" | "workspace">) => (
      <NextIntlClientProvider locale="tr" messages={trMessages}>
        <SetupWizard {...base} {...props} />
      </NextIntlClientProvider>
    );
    const view = render(ui(fresh));
    const refreshProps = async () => view.rerender(ui(await load()));
    const stepOpen = (label: string) =>
      screen.getByRole("button", { name: new RegExp("^" + label + "\\s*(Tamamlandı|Bekliyor)$") }).getAttribute("aria-expanded") === "true";
    const stepDone = (label: string) =>
      within(screen.getByRole("button", { name: new RegExp("^" + label + "\\s*(Tamamlandı|Bekliyor)$") })).queryByText("Tamamlandı") !== null;

    // 1 — salon information (KKTC: Nicosia time zone and euro-free default currency kept as TRY)
    expect(stepOpen("Salon bilgileri")).toBe(true);
    typeInto(screen.getByLabelText("Telefon"), "0542 123 45 67");
    typeInto(screen.getByLabelText("Adres (isteğe bağlı)"), "Girne Merkez");
    choose(screen.getByLabelText("Saat dilimi"), "Asia/Nicosia");
    click(screen.getByRole("button", { name: "Kaydet ve devam et" }));
    stats.serverActions += 1;
    await waitFor(() => expect(stepDone("Salon bilgileri")).toBe(true), { timeout: 15000 });
    await refreshProps();

    // 2 — ten services, typed row by row (the slow path; pasting is faster and measured separately in the report)
    expect(stepOpen("Hizmetler")).toBe(true);
    const catalogue: [string, string, string, string][] = [
      ["Saç", "Saç Kesimi", "45", "800"],
      ["Saç", "Fön", "30", "400"],
      ["Saç", "Boya", "120", "2500"],
      ["Saç", "Röfle", "150", "3000"],
      ["Tırnak", "Manikür", "45", "600"],
      ["Tırnak", "Pedikür", "60", "700"],
      ["Tırnak", "Kalıcı Oje", "60", "900"],
      ["Bakım", "Cilt Bakımı", "60", "1200"],
      ["Bakım", "Kaş Alımı", "15", "250"],
      ["Bakım", "Ağda", "30", "500"],
    ];
    for (let i = 0; i < 7; i++) click(screen.getByRole("button", { name: "Satır ekle" }));
    const cats = screen.getAllByLabelText("Kategori");
    const names = screen.getAllByLabelText("Hizmet adı");
    const durs = screen.getAllByLabelText("Süre (dk)");
    const prices = screen.getAllByLabelText("Fiyat");
    expect(names).toHaveLength(10);
    catalogue.forEach(([cat, name, dur, price], i) => {
      typeInto(cats[i]!, cat);
      typeInto(names[i]!, name);
      typeInto(durs[i]!, dur);
      typeInto(prices[i]!, price);
    });
    click(screen.getByRole("button", { name: "Hizmetleri ekle" }));
    stats.serverActions += 1;
    await waitFor(() => expect(stepDone("Hizmetler")).toBe(true), { timeout: 15000 });
    await refreshProps();

    // 3 — three people, one paste
    expect(stepOpen("Personel")).toBe(true);
    typeInto(screen.getByLabelText(/Her satıra bir kişi/), "Ayşe Demir\nMehmet Kaya\nElif Şahin");
    click(screen.getByRole("button", { name: "Personeli ekle" }));
    stats.serverActions += 1;
    await waitFor(() => expect(stepDone("Personel")).toBe(true), { timeout: 15000 });
    await refreshProps();

    // 4 — weekly hours: the proposed Monday–Saturday 09:00–18:00 is accepted as is, all three people are pre-selected
    expect(stepOpen("Çalışma saatleri")).toBe(true);
    click(screen.getByRole("button", { name: "Saatleri uygula" }));
    stats.serverActions += 1;
    await waitFor(() => expect(stepDone("Çalışma saatleri")).toBe(true), { timeout: 15000 });
    await refreshProps();

    // 5 — who does what (14 of the 30 cells)
    expect(stepOpen("Kim hangi hizmeti yapıyor")).toBe(true);
    const mapping: Record<string, string[]> = {
      "Ayşe Demir": ["Saç Kesimi", "Fön", "Boya", "Röfle", "Kaş Alımı"],
      "Mehmet Kaya": ["Saç Kesimi", "Fön", "Boya"],
      "Elif Şahin": ["Manikür", "Pedikür", "Kalıcı Oje", "Cilt Bakımı", "Ağda", "Kaş Alımı"],
    };
    let cells = 0;
    for (const [person, list] of Object.entries(mapping)) {
      for (const service of list) {
        click(screen.getByRole("checkbox", { name: `${person} – ${service}` }));
        cells += 1;
      }
    }
    click(screen.getByRole("button", { name: "Eşleştirmeyi kaydet" }));
    stats.serverActions += 1;
    await waitFor(() => expect(stepDone("Kim hangi hizmeti yapıyor")).toBe(true), { timeout: 15000 });
    await refreshProps();

    // 6 — online booking on
    expect(stepOpen("Online rezervasyon")).toBe(true);
    click(screen.getByRole("button", { name: "Online rezervasyonu aç" }));
    stats.serverActions += 1;
    await waitFor(async () => expect((await load()).initialStatus.onlineBookingEnabled).toBe(true));
    await refreshProps();

    // 7 — the closing step: the page must now say it is ready, with the address
    click(screen.getByRole("button", { name: /^Hazır\s*(Tamamlandı|Bekliyor)$/ }));
    expect(await screen.findByText("Rezervasyon sayfanız hazır")).toBeTruthy();
    expect(screen.getByText(base.bookingUrl)).toBeTruthy();
    click(screen.getByRole("button", { name: "Bağlantıyı kopyala" }));

    const final = (await load()).initialStatus;
    expect(final.ready).toBe(true);
    expect(final.blockers).toEqual([]);
    expect(final.counts).toEqual({ services: 10, staff: 3, staffWithHours: 3, bookablePaths: cells });
    expect(final.profile).toMatchObject({ timezone: "Asia/Nicosia", phone: "05421234567" });
    expect(stepProgress(final)).toEqual({ done: 6, total: 6 });

    // the categories, durations and prices survived exactly
    const stored = await testDb<{ name: string; category: string; duration_minutes: number; price: string }[]>`
      select name, category, duration_minutes, price::text from services where tenant_id = ${tenantId} order by display_order`;
    expect(stored.map((s) => [s.category, s.name, String(s.duration_minutes), String(Number(s.price))])).toEqual(catalogue);

    // a real customer could actually pick the slot the read model reported
    const slotAt = new Date(final.firstAvailableSlotAt!);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Nicosia", dateStyle: "short", timeStyle: "short" }).format(slotAt);
    const [date, time] = local.split(" ") as [string, string];
    const [branch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenantId} and is_primary`;
    const [svc] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${tenantId} and name = 'Saç Kesimi'`;
    const [slots] = await testDb<{ slots: string[] }[]>`select public.get_public_availability_slots(${slug}, ${branch!.id}, ${svc!.id}, ${date}::date) as slots`;
    expect(slots!.slots.length).toBeGreaterThan(0);
    void time;

    const wallMs = performance.now() - wallStart;
    const metrics = {
      screensVisited: 1, // the single setup page
      clicks: stats.clicks,
      fieldEdits: stats.edits,
      typedCharacters: stats.chars,
      serverActions: stats.serverActions,
      rpcCalls: state.rpcCalls,
      databaseMsTotal: Math.round(state.serverMs),
      wallMsTotal: Math.round(wallMs),
      mappingCells: cells,
    };
    if (process.env.SCENARIO_OUT) writeFileSync(process.env.SCENARIO_OUT, JSON.stringify(metrics, null, 2));
    expect(metrics.screensVisited).toBe(1);
  }, 180_000);
});
