/**
 * Faz FIN.1B.1 — the navigation entry and the page gate (matrix F12). The tenant layout and the expenses page are async
 * Server Components, so they are called directly as functions with the session, permission and read boundaries mocked; the
 * element they return is inspected. No database, no DOM, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantAccess: vi.fn(),
  hasPermission: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
  getMessages: vi.fn(),
  getBranchOptions: vi.fn(),
  getExpenseCategories: vi.fn(),
  getExpenseOverview: vi.fn(),
  getExpensesFirstPage: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getTenantAccess: mocks.getTenantAccess,
  hasPermission: mocks.hasPermission,
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
  getMessages: mocks.getMessages,
}));
vi.mock("@/lib/pwa/device-owner-tag", () => ({ deviceOwnerTag: () => "tag" }));
vi.mock("@/components/tenant-app/app-shell", () => ({
  TenantAppShell: () => null,
}));
vi.mock("@/lib/modules/staff/queries", () => ({
  getBranchOptions: mocks.getBranchOptions,
}));
vi.mock("@/lib/modules/expenses/queries", () => ({
  getExpenseCategories: mocks.getExpenseCategories,
  getExpenseOverview: mocks.getExpenseOverview,
  getExpensesFirstPage: mocks.getExpensesFirstPage,
}));
vi.mock("@/components/expenses/expenses-page-client", () => ({
  ExpensesPageClient: () => null,
}));
vi.mock("@/components/expenses/expenses-error-state", () => ({
  ExpensesErrorState: () => null,
}));

import TenantAppLayout from "@/app/[locale]/app/[tenantSlug]/layout";
import ExpensesPage from "@/app/[locale]/app/[tenantSlug]/finance/expenses/page";
import { ExpensesPageClient } from "@/components/expenses/expenses-page-client";
import { ExpensesErrorState } from "@/components/expenses/expenses-error-state";
import trMessages from "@/messages/tr.json";

const SLUG = "bella-hair";
const TENANT = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Bella Hair",
  slug: SLUG,
};
const BRANCH_ID = "55555555-5555-4555-8555-555555555555";

const OK_ACCESS = {
  reason: "ok",
  tenant: TENANT,
  roleName: "Sahip",
  user: { id: "user-1", email: "owner@example.test" },
};

function grant(...keys: string[]) {
  const set = new Set(keys);
  mocks.hasPermission.mockImplementation(
    async (_tenantId: string, key: string) => set.has(key),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getTenantAccess.mockResolvedValue(OK_ACCESS);
  mocks.redirect.mockImplementation((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  });
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.getMessages.mockResolvedValue({ Expenses: trMessages.Expenses });
  mocks.getBranchOptions.mockResolvedValue([
    { id: BRANCH_ID, name: "Merkez Şube", isPrimary: true },
  ]);
  mocks.getExpenseCategories.mockResolvedValue({
    ok: true,
    data: [{ key: "rent", kind: "fixed", displayOrder: 10 }],
  });
  mocks.getExpenseOverview.mockResolvedValue({
    ok: true,
    data: {
      month: "2026-09-01",
      referenceDate: "2026-09-15",
      primaryCurrency: "TRY",
      byCurrency: [],
    },
  });
  mocks.getExpensesFirstPage.mockResolvedValue({
    ok: true,
    data: { items: [], nextCursor: null },
  });
});

type NavItem = { href: string; label: string };

async function navItemsFor(...permissions: string[]): Promise<NavItem[]> {
  grant(...permissions);
  const element = (await TenantAppLayout({
    children: null,
    params: Promise.resolve({ tenantSlug: SLUG }),
  } as never)) as { props: { navItems: NavItem[] } };
  return element.props.navItems;
}

describe("F12 navigation", () => {
  it("shows Giderler (/finance/expenses) for finance.view, between Hizmetler and Raporlar", async () => {
    const items = await navItemsFor(
      "services.view",
      "reports.staff",
      "finance.view",
    );
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toContain("/finance/expenses");
    expect(hrefs.indexOf("/finance/expenses")).toBe(
      hrefs.indexOf("/services") + 1,
    );
    expect(hrefs.indexOf("/reports/staff")).toBe(
      hrefs.indexOf("/finance/expenses") + 1,
    );
    expect(items.find((i) => i.href === "/finance/expenses")!.label).toBe(
      "TenantApp.nav.expenses",
    );
  });

  it("is gated by finance.view alone: finance.manage without view, other permissions, and no permission at all hide it", async () => {
    for (const permissions of [
      ["finance.manage"],
      ["reports.financial"],
      ["appointments.view", "customers.view", "services.view"],
      [],
    ]) {
      const items = await navItemsFor(...permissions);
      expect(
        items.map((i) => i.href),
        permissions.join(","),
      ).not.toContain("/finance/expenses");
    }
  });

  it("asks for finance.view in the resolved tenant (never a client-supplied id)", async () => {
    await navItemsFor("finance.view");
    expect(mocks.hasPermission).toHaveBeenCalledWith(TENANT.id, "finance.view");
  });

  it("adding the entry did not remove or reorder any other item", async () => {
    const without = (
      await navItemsFor(
        "staff.view",
        "services.view",
        "customers.view",
        "appointments.view",
        "settings.manage",
        "reports.staff",
        "staff.manage",
      )
    ).map((i) => i.href);
    const withFinance = (
      await navItemsFor(
        "staff.view",
        "services.view",
        "customers.view",
        "appointments.view",
        "settings.manage",
        "reports.staff",
        "staff.manage",
        "finance.view",
      )
    ).map((i) => i.href);
    expect(withFinance.filter((h) => h !== "/finance/expenses")).toEqual(
      without,
    );
  });
});

async function renderPage(
  search: Record<string, string | string[] | undefined> = {},
) {
  return (await ExpensesPage({
    params: Promise.resolve({ tenantSlug: SLUG, locale: "tr" }),
    searchParams: Promise.resolve(search),
  } as never)) as { type: unknown; props: Record<string, unknown> } | null;
}

describe("F12 page gate", () => {
  it("redirects without finance.view and reads nothing", async () => {
    grant("finance.manage"); // manage alone is not enough to see the page
    await expect(renderPage()).rejects.toThrow(`NEXT_REDIRECT:/app/${SLUG}`);
    expect(mocks.redirect).toHaveBeenCalledWith(`/app/${SLUG}`);
    expect(mocks.getExpenseCategories).not.toHaveBeenCalled();
    expect(mocks.getExpenseOverview).not.toHaveBeenCalled();
    expect(mocks.getExpensesFirstPage).not.toHaveBeenCalled();
    expect(mocks.getBranchOptions).not.toHaveBeenCalled();
  });

  it("renders nothing for a user who is not a member (the layout already 404s)", async () => {
    grant("finance.view");
    mocks.getTenantAccess.mockResolvedValue({ reason: "not_found" });
    expect(await renderPage()).toBeNull();
    expect(mocks.getExpenseOverview).not.toHaveBeenCalled();
  });

  it("view without manage renders the page with canManage false", async () => {
    grant("finance.view");
    const element = (await renderPage())!;
    expect(element.type).toBe(ExpensesPageClient);
    expect(element.props.canManage).toBe(false);
    expect(element.props.tenantId).toBe(TENANT.id);
    expect(element.props.tenantSlug).toBe(SLUG);
  });

  it("view plus manage renders the page with canManage true", async () => {
    grant("finance.view", "finance.manage");
    const element = (await renderPage())!;
    expect(element.type).toBe(ExpensesPageClient);
    expect(element.props.canManage).toBe(true);
  });

  it("the labels are the Expenses namespace and the filters come from the URL", async () => {
    grant("finance.view");
    const element = (await renderPage({
      month: "2026-07",
      branch: "general",
      category: "rent",
      status: "paid",
      cancelled: "1",
      q: " kira ",
    }))!;
    expect(element.props.labels).toBe(trMessages.Expenses);
    expect(element.props.filters).toMatchObject({
      month: "2026-07",
      branch: "general",
      category: "rent",
      status: "paid",
      includeCancelled: true,
      search: "kira",
    });
  });

  it("reads the overview for the URL month and branch scope, then the list for the month the OVERVIEW used", async () => {
    grant("finance.view");
    // the URL has no month: the database's default month comes back in the overview and drives the list window
    await renderPage({ branch: "general" });
    expect(mocks.getExpenseOverview).toHaveBeenCalledWith(TENANT.id, {
      month: null,
      branchId: null,
      generalOnly: true,
    });
    expect(mocks.getExpensesFirstPage).toHaveBeenCalledTimes(1);
    const [tenantId, params, referenceDate] =
      mocks.getExpensesFirstPage.mock.calls[0]!;
    expect(tenantId).toBe(TENANT.id);
    expect(params).toMatchObject({
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
      generalOnly: true,
      branchId: null,
    });
    expect(referenceDate).toBe("2026-09-15");

    mocks.getExpenseOverview.mockClear();
    await renderPage({ month: "2026-07", branch: BRANCH_ID });
    expect(mocks.getExpenseOverview).toHaveBeenCalledWith(TENANT.id, {
      month: "2026-07-01",
      branchId: BRANCH_ID,
      generalOnly: false,
    });
  });

  it("all months and overdue-only lists are not month-scoped", async () => {
    grant("finance.view");
    await renderPage({ month: "all" });
    expect(mocks.getExpensesFirstPage.mock.calls[0]![1]).toMatchObject({
      fromDate: null,
      toDate: null,
    });
    await renderPage({ overdue: "1" });
    expect(mocks.getExpensesFirstPage.mock.calls[1]![1]).toMatchObject({
      fromDate: null,
      toDate: null,
      overdueOnly: true,
    });
  });

  it("a failed read renders an explicit error state, never a blank page", async () => {
    grant("finance.view");
    for (const failing of ["categories", "overview", "list"]) {
      mocks.getExpenseCategories.mockResolvedValue(
        failing === "categories"
          ? { ok: false, code: "PGRST000" }
          : { ok: true, data: [] },
      );
      mocks.getExpenseOverview.mockResolvedValue(
        failing === "overview"
          ? { ok: false, code: null }
          : {
              ok: true,
              data: {
                month: "2026-09-01",
                referenceDate: "2026-09-15",
                primaryCurrency: "TRY",
                byCurrency: [],
              },
            },
      );
      mocks.getExpensesFirstPage.mockResolvedValue(
        failing === "list"
          ? { ok: false, code: "FN002" }
          : { ok: true, data: { items: [], nextCursor: null } },
      );
      const element = (await renderPage())!;
      expect(element, failing).not.toBeNull();
      expect(element.type, failing).toBe(ExpensesErrorState);
    }
  });
});
