import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * Faz LAUNCH.1A — the APPLICATION half of the owner-approval gate on salon creation, with no database and no network.
 * The authority is the database (launch1a-tenant-provisioning-gate.test.ts proves an unapproved caller cannot create a
 * tenant even by calling the RPC directly). What is pinned here is everything around it: the fail-closed status helper,
 * the mapping of the database's refusal, the platform-owner approval actions, and that the pages show an explanation
 * instead of a form that could not succeed.
 */

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return {
    RedirectSignal,
    order: [] as string[],
    requireUser: vi.fn(),
    requirePlatformAdmin: vi.fn(),
    getCurrentUser: vi.fn(),
    getUserMemberships: vi.fn(),
    isPlatformAdmin: vi.fn(),
    getMyAccountProfile: vi.fn(),
    rpc: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: h.requireUser,
  requirePlatformAdmin: h.requirePlatformAdmin,
  getCurrentUser: h.getCurrentUser,
  getUserMemberships: h.getUserMemberships,
  isPlatformAdmin: h.isPlatformAdmin,
}));
vi.mock("@/lib/modules/customer-account/queries", () => ({ getMyAccountProfile: h.getMyAccountProfile }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    h.order.push("createClient");
    return { rpc: h.rpc };
  },
}));
vi.mock("next-intl/server", async () => {
  const { default: messages } = await import("@/messages/tr.json");
  return {
    getTranslations: async (namespace: string) => (key: string) => {
      const value = `${namespace}.${key}`.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
      return typeof value === "string" ? value : `${namespace}.${key}`;
    },
  };
});
vi.mock("@/lib/i18n/navigation", async () => {
  const { createElement } = await import("react");
  return { Link: ({ href, children }: { href: string; children?: React.ReactNode }) => createElement("a", { href }, children) };
});
vi.mock("@/components/onboarding/create-tenant-form", async () => {
  const { createElement } = await import("react");
  return { CreateTenantForm: () => createElement("div", { "data-marker": "create-tenant-form" }) };
});
vi.mock("@/components/auth/sign-up-form", async () => {
  const { createElement } = await import("react");
  return { SignUpForm: () => createElement("div", { "data-marker": "sign-up-form" }) };
});

import messages from "@/messages/tr.json";
import {
  TENANT_PROVISIONING_NOT_APPROVED_MESSAGE,
  getMyTenantProvisioningStatus,
  isTenantProvisioningNotApprovedError,
} from "@/lib/modules/tenants/provisioning";
import { createTenantAction } from "@/lib/modules/tenants/actions";
import { mapApprovalError } from "@/lib/modules/platform/approval-errors";
import { approveTenantOwnerSchema, revokeTenantOwnerApprovalSchema } from "@/lib/modules/platform/schemas";
import { listTenantOwnerApprovals } from "@/lib/modules/platform/approvals";
import { approveTenantOwnerAction, revokeTenantOwnerApprovalAction } from "@/lib/modules/platform/actions";
import OnboardingPage from "@/app/[locale]/onboarding/page";
import HomePage from "@/app/[locale]/page";
import SignUpPage from "@/app/[locale]/(auth)/sign-up/page";
import type { SupabaseClient } from "@supabase/supabase-js";

type Outcome<T> = { kind: "returned"; value: T } | { kind: "redirected"; url: string };
async function run<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { kind: "returned", value: await fn() };
  } catch (error) {
    if (error instanceof h.RedirectSignal) return { kind: "redirected", url: error.url };
    throw error;
  }
}
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const fakeClient = (rpc: unknown) => ({ rpc }) as unknown as SupabaseClient<never>;

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.order.length = 0;
  for (const fn of [h.requireUser, h.requirePlatformAdmin, h.getCurrentUser, h.getUserMemberships, h.isPlatformAdmin, h.getMyAccountProfile, h.rpc, h.revalidatePath]) fn.mockReset();
  h.requireUser.mockImplementation(async () => {
    h.order.push("requireUser");
    return { id: "user" };
  });
  h.requirePlatformAdmin.mockImplementation(async () => {
    h.order.push("requirePlatformAdmin");
    return { id: "admin" };
  });
  h.getCurrentUser.mockResolvedValue({ id: "user" });
  h.getUserMemberships.mockResolvedValue([]);
  h.isPlatformAdmin.mockResolvedValue(false);
  h.getMyAccountProfile.mockResolvedValue({ fullName: "Ayşe Yılmaz" });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("getMyTenantProvisioningStatus — fails CLOSED", () => {
  it("is true only for an exact boolean true from the database", async () => {
    h.rpc.mockResolvedValue({ data: true, error: null });
    expect(await getMyTenantProvisioningStatus(fakeClient(h.rpc))).toBe(true);
    expect(h.rpc).toHaveBeenCalledWith("get_my_tenant_provisioning_status");
  });

  it.each([false, null, undefined, "true", 1, "t", {}, []])("%j is NOT approval", async (data) => {
    h.rpc.mockResolvedValue({ data, error: null });
    expect(await getMyTenantProvisioningStatus(fakeClient(h.rpc))).toBe(false);
  });

  it("an error (including the function being absent because the application was released before the migration) is NOT approval", async () => {
    h.rpc.mockResolvedValue({ data: true, error: { code: "PGRST202", message: "Could not find the function" } });
    expect(await getMyTenantProvisioningStatus(fakeClient(h.rpc))).toBe(false);
  });

  it("asks about the caller only — the call carries no argument that could name somebody else", async () => {
    h.rpc.mockResolvedValue({ data: false, error: null });
    await getMyTenantProvisioningStatus(fakeClient(h.rpc));
    expect(h.rpc.mock.calls[0]).toEqual(["get_my_tenant_provisioning_status"]);
  });
});

describe("isTenantProvisioningNotApprovedError", () => {
  it("recognises the database's exact exception text, nothing else", () => {
    expect(isTenantProvisioningNotApprovedError({ message: "tenant_provisioning_not_approved" })).toBe(true);
    expect(isTenantProvisioningNotApprovedError({ message: "ERROR: tenant_provisioning_not_approved" })).toBe(true);
    for (const error of [null, undefined, {}, { message: "" }, { message: "invalid slug format" }, { message: "authentication required" }]) {
      expect(isTenantProvisioningNotApprovedError(error as never), JSON.stringify(error)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("createTenantAction — what the person sees", () => {
  const input = () => form({ name: "Bella Hair", slug: "bella-hair" });

  it("an unapproved caller gets the explanatory refusal (UNAUTHORIZED), never a generic failure — and the slug is never reflected", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "tenant_provisioning_not_approved" } });
    const outcome = await run(() => createTenantAction(null, input()));
    expect(outcome).toEqual({
      kind: "returned",
      value: { success: false, error: { code: "UNAUTHORIZED", message: TENANT_PROVISIONING_NOT_APPROVED_MESSAGE } },
    });
    expect(JSON.stringify(outcome)).not.toContain("bella-hair");
  });

  it("the unapproved answer is the SAME whether the typed slug is free or taken (the database refuses before it looks at the slug)", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "tenant_provisioning_not_approved" } });
    const free = await run(() => createTenantAction(null, form({ name: "A", slug: "free-slug" })));
    const taken = await run(() => createTenantAction(null, form({ name: "A", slug: "taken-slug" })));
    expect(taken).toEqual(free);
  });

  it("an approved caller who picks a taken slug still gets the slug conflict; success redirects into the new salon", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key" } });
    expect(await run(() => createTenantAction(null, input()))).toMatchObject({ value: { success: false, error: { code: "CONFLICT" } } });

    h.rpc.mockResolvedValue({ data: "tenant-id", error: null });
    expect(await run(() => createTenantAction(null, input()))).toEqual({ kind: "redirected", url: "/app/bella-hair" });
  });

  it("requires a signed-in user before anything else, and validates the form before calling the database", async () => {
    h.requireUser.mockRejectedValue(new h.RedirectSignal("/login"));
    expect(await run(() => createTenantAction(null, input()))).toEqual({ kind: "redirected", url: "/login" });
    expect(h.rpc).not.toHaveBeenCalled();

    h.requireUser.mockResolvedValue({ id: "user" });
    const invalid = await run(() => createTenantAction(null, form({ name: "", slug: "x" })));
    expect(invalid).toMatchObject({ value: { success: false, error: { code: "VALIDATION" } } });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the platform-owner approval actions", () => {
  it("approve: the page door (requirePlatformAdmin) comes first; a rejected door means no database call at all", async () => {
    h.requirePlatformAdmin.mockRejectedValue(new h.RedirectSignal("/"));
    expect(await run(() => approveTenantOwnerAction(null, form({ email: "a@example.com", validDays: "30" })))).toEqual({ kind: "redirected", url: "/" });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("approve: sends the trimmed address, the note (omitted when empty) and the validity as a NUMBER; refreshes /super-admin on success", async () => {
    h.rpc.mockResolvedValue({ data: [{ email: "salon.sahibi@example.com" }], error: null });
    const result = await approveTenantOwnerAction(null, form({ email: "  Salon.Sahibi@Example.com ", note: "  Pilot salon önerisi  ", validDays: "14" }));
    expect(result).toEqual({ success: true, data: { email: "salon.sahibi@example.com" } });
    expect(h.rpc).toHaveBeenCalledWith("platform_approve_tenant_owner", {
      p_email: "Salon.Sahibi@Example.com",
      p_note: "Pilot salon önerisi",
      p_valid_days: 14,
    });
    expect(h.revalidatePath).toHaveBeenCalledWith("/super-admin");

    h.rpc.mockClear();
    h.rpc.mockResolvedValue({ data: [], error: null });
    await approveTenantOwnerAction(null, form({ email: "b@example.com", validDays: "30" }));
    expect(h.rpc.mock.calls[0]![1]).toEqual({ p_email: "b@example.com", p_note: undefined, p_valid_days: 30 });
  });

  it.each([
    ["not an e-mail", { email: "nope", validDays: "30" }],
    ["validity 0", { email: "a@example.com", validDays: "0" }],
    ["validity 91", { email: "a@example.com", validDays: "91" }],
    ["fractional validity", { email: "a@example.com", validDays: "1.5" }],
    ["non-numeric validity", { email: "a@example.com", validDays: "abc" }],
    ["note over 500 characters", { email: "a@example.com", validDays: "30", note: "x".repeat(501) }],
  ])("approve: %s is rejected by the form check before the database is called", async (_label, fields) => {
    const result = await approveTenantOwnerAction(null, form(fields));
    expect(result).toMatchObject({ success: false, error: { code: "VALIDATION" } });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("approve: a database refusal (a support-level admin is not a platform owner) is shown mapped, with no refresh", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "platform_owner_required" } });
    const result = await approveTenantOwnerAction(null, form({ email: "a@example.com", validDays: "30" }));
    expect(result).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Bu işlemi yalnızca platform sahibi yapabilir" } });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("revoke: door first; a malformed id never reaches the database; success refreshes; a refusal is mapped", async () => {
    h.requirePlatformAdmin.mockRejectedValueOnce(new h.RedirectSignal("/"));
    expect(await run(() => revokeTenantOwnerApprovalAction(null, form({ approvalId: APPROVAL_ID })))).toEqual({ kind: "redirected", url: "/" });
    expect(h.rpc).not.toHaveBeenCalled();

    expect(await revokeTenantOwnerApprovalAction(null, form({ approvalId: "not-a-uuid" }))).toMatchObject({ success: false, error: { code: "VALIDATION" } });
    expect(await revokeTenantOwnerApprovalAction(null, new FormData())).toMatchObject({ success: false, error: { code: "VALIDATION" } });
    expect(h.rpc).not.toHaveBeenCalled();

    h.rpc.mockResolvedValue({ data: null, error: null });
    expect(await revokeTenantOwnerApprovalAction(null, form({ approvalId: APPROVAL_ID }))).toEqual({ success: true, data: null });
    expect(h.rpc).toHaveBeenCalledWith("platform_revoke_tenant_owner_approval", { p_approval_id: APPROVAL_ID });
    expect(h.revalidatePath).toHaveBeenCalledWith("/super-admin");

    h.revalidatePath.mockClear();
    h.rpc.mockResolvedValue({ data: null, error: { message: "approval_already_consumed" } });
    expect(await revokeTenantOwnerApprovalAction(null, form({ approvalId: APPROVAL_ID }))).toMatchObject({ success: false, error: { code: "CONFLICT" } });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("mapApprovalError / schemas / listTenantOwnerApprovals", () => {
  it.each([
    ["authentication required", "UNAUTHENTICATED"],
    ["platform_owner_required", "UNAUTHORIZED"],
    ["invalid_email", "VALIDATION"],
    ["invalid_validity", "VALIDATION"],
    ["note_too_long", "VALIDATION"],
    ["approval_not_found", "NOT_FOUND"],
    ["approval_already_consumed", "CONFLICT"],
    ["something unexpected happened", "UNEXPECTED"],
  ])("%s -> %s", (message, code) => {
    expect(mapApprovalError({ message })).toMatchObject({ success: false, error: { code } });
  });

  it("an empty error maps to the generic failure, never a thrown exception", () => {
    expect(mapApprovalError(null)).toMatchObject({ success: false, error: { code: "UNEXPECTED" } });
    expect(mapApprovalError(undefined)).toMatchObject({ success: false, error: { code: "UNEXPECTED" } });
  });

  it("the approve schema coerces the validity to an integer 1..90 and trims the note", () => {
    expect(approveTenantOwnerSchema.parse({ email: " a@b.co ", note: "  hi ", validDays: "90" })).toEqual({ email: "a@b.co", note: "hi", validDays: 90 });
    expect(approveTenantOwnerSchema.safeParse({ email: "a@b.co", validDays: 1 }).success).toBe(true);
    for (const validDays of [0, 91, -1, 2.5, "x", ""]) {
      expect(approveTenantOwnerSchema.safeParse({ email: "a@b.co", validDays }).success, String(validDays)).toBe(false);
    }
  });

  it("the revoke schema accepts only a uuid", () => {
    expect(revokeTenantOwnerApprovalSchema.safeParse({ approvalId: APPROVAL_ID }).success).toBe(true);
    for (const approvalId of ["", "1", "not-a-uuid", null, undefined]) {
      expect(revokeTenantOwnerApprovalSchema.safeParse({ approvalId }).success, String(approvalId)).toBe(false);
    }
  });

  it("listTenantOwnerApprovals maps rows and FAILS CLOSED ({ allowed: false }) on any error", async () => {
    h.rpc.mockResolvedValue({
      data: [
        {
          id: APPROVAL_ID,
          email: "a@example.com",
          note: null,
          status: "approved",
          effective_status: "expired",
          approved_at: "2026-10-01T10:00:00Z",
          expires_at: "2026-10-08T10:00:00Z",
          consumed_at: null,
          consumed_tenant_name: null,
          revoked_at: null,
        },
      ],
      error: null,
    });
    const result = await listTenantOwnerApprovals(fakeClient(h.rpc));
    expect(result).toEqual({
      allowed: true,
      rows: [
        {
          id: APPROVAL_ID,
          email: "a@example.com",
          note: null,
          status: "approved",
          effectiveStatus: "expired",
          approvedAt: "2026-10-01T10:00:00Z",
          expiresAt: "2026-10-08T10:00:00Z",
          consumedAt: null,
          consumedTenantName: null,
          revokedAt: null,
        },
      ],
    });

    for (const error of [{ message: "platform_owner_required" }, { code: "PGRST202", message: "function not found" }, { message: "timeout" }]) {
      h.rpc.mockResolvedValue({ data: null, error });
      expect(await listTenantOwnerApprovals(fakeClient(h.rpc)), error.message).toEqual({ allowed: false });
    }
    h.rpc.mockResolvedValue({ data: null, error: null });
    expect(await listTenantOwnerApprovals(fakeClient(h.rpc))).toEqual({ allowed: true, rows: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the pages", () => {
  const O = messages.Onboarding;
  const HOME = messages.Home.signedIn;

  async function renderOnboarding() {
    return renderToStaticMarkup((await OnboardingPage()) as ReactElement);
  }

  /** HomePage returns the (async) SignedInHome element; resolve it the way the server renderer would. */
  async function renderHome() {
    const element = (await HomePage({ searchParams: Promise.resolve({}) } as never)) as ReactElement<unknown>;
    const Component = element.type as (props: unknown) => Promise<ReactElement>;
    return renderToStaticMarkup(await Component(element.props));
  }

  it("onboarding: an APPROVED caller gets the create-salon form", async () => {
    h.rpc.mockResolvedValue({ data: true, error: null });
    const html = await renderOnboarding();
    expect(html).toContain('data-marker="create-tenant-form"');
    expect(html).not.toContain(O.pendingApprovalTitle);
  });

  it.each([
    ["not approved", { data: false, error: null }],
    ["status unknown (error)", { data: null, error: { message: "boom" } }],
    ["status function missing", { data: null, error: { code: "PGRST202", message: "not found" } }],
  ])("onboarding: %s -> the explanation, no form (fails closed), with a way back home", async (_label, answer) => {
    h.rpc.mockResolvedValue(answer);
    const html = await renderOnboarding();
    expect(html).toContain(O.pendingApprovalTitle);
    expect(html).toContain(O.pendingApprovalDescription);
    expect(html).not.toContain('data-marker="create-tenant-form"');
    expect(html).toContain('href="/"');
  });

  it("onboarding: requires a signed-in user first", async () => {
    h.requireUser.mockRejectedValue(new h.RedirectSignal("/login"));
    expect(await run(() => OnboardingPage())).toEqual({ kind: "redirected", url: "/login" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("home, signed in with NO salon and approved: the create-salon button points at /onboarding", async () => {
    h.rpc.mockResolvedValue({ data: true, error: null });
    const html = await renderHome();
    expect(html).toContain(HOME.noSalons);
    expect(html).toContain('href="/onboarding"');
    expect(html).toContain(HOME.createSalon);
    expect(html).not.toContain(HOME.createSalonPending);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("home, signed in with NO salon and NOT approved (or unknown): the pending explanation, no button", async () => {
    for (const answer of [{ data: false, error: null }, { data: null, error: { message: "boom" } }]) {
      h.rpc.mockResolvedValue(answer);
      const html = await renderHome();
      expect(html).toContain(HOME.createSalonPending);
      expect(html).not.toContain('href="/onboarding"');
    }
  });

  it("home, with two salons: the chooser lists them and the approval status is not even asked (no extra round trip)", async () => {
    h.getUserMemberships.mockResolvedValue([
      { tenantId: "t1", tenantName: "Bella Hair", tenantSlug: "bella-hair", roleName: "Salon Sahibi" },
      { tenantId: "t2", tenantName: "Ada Studio", tenantSlug: "ada-studio", roleName: "Yönetici" },
    ]);
    const html = await renderHome();
    expect(html).toContain("Bella Hair");
    expect(html).toContain('href="/app/ada-studio"');
    expect(html).not.toContain('href="/onboarding"');
    expect(html).not.toContain(HOME.createSalonPending);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("sign-up stays open but says up front that opening a salon needs SalonOS's approval", async () => {
    const html = renderToStaticMarkup((await SignUpPage({ searchParams: Promise.resolve({}) } as never)) as ReactElement);
    expect(html).toContain(messages.Auth.signUp.inviteOnlyNotice);
    expect(html).toContain('data-marker="sign-up-form"');
  });
});
