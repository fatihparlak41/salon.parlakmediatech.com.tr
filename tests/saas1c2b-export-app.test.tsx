// @vitest-environment jsdom
/**
 * Faz SAAS.1C.2b - the application layer: RT route handler, AC server action, UI page / panel (real Turkish catalog, a templated message formatted
 * without its values yields its key path exactly like next-intl, so a raw-key regression shows up as "Export.xxx" in the DOM).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import trMessages from "@/messages/tr.json";
import { readZip } from "./export-zip-reader";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  getTenantAccess: vi.fn(),
  redirect: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: (...a: unknown[]) => h.rpc(...a), auth: { getUser: () => h.getUser() } }) }));
vi.mock("@/lib/auth/session", () => ({ getTenantAccess: (...a: unknown[]) => h.getTenantAccess(...a), hasPermission: async () => true }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => h.redirect(u) }));

const lookup = (ns: string, key: string): unknown => {
  let node: unknown = trMessages;
  for (const part of `${ns}.${key}`.split(".")) node = (node as Record<string, unknown>)?.[part];
  return node;
};
const makeT = (ns: string) => (key: string, values?: Record<string, string | number>) => {
  const node = lookup(ns, key);
  if (typeof node !== "string") return `${ns}.${key}`;
  if (node.includes("{")) {
    if (!values) return `${ns}.${key}`;
    return node.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k]));
  }
  return node;
};
vi.mock("next-intl/server", () => ({ getTranslations: async (ns: string) => makeT(ns) }));
vi.mock("next-intl", () => ({ useTranslations: (ns: string) => makeT(ns) }));
vi.mock("@/lib/modules/export/actions", async (orig) => {
  const real = await orig<typeof import("@/lib/modules/export/actions")>();
  return { ...real, prepareTenantExportAction: (...a: unknown[]) => h.prepare(...a) };
});

import { POST } from "@/app/api/tenant-export/route";
import * as routeModule from "@/app/api/tenant-export/route";
import ExportPage from "@/app/[locale]/app/[tenantSlug]/export/page";
import { TenantExportPanel } from "@/components/export/tenant-export-panel";
import { hashToken, newExportToken } from "@/lib/modules/export/token";

const REQ = "5b0d8a0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const GOOD = "A".repeat(43);

beforeEach(() => {
  h.rpc.mockReset();
  h.getUser.mockReset();
  h.getTenantAccess.mockReset();
  h.redirect.mockReset();
  h.prepare.mockReset();
});
afterEach(() => cleanup());

const form = (token: unknown, headers: Record<string, string> = {}) => {
  const fd = new FormData();
  if (token !== undefined) fd.set("token", String(token));
  return new Request("https://salon.example.test/api/tenant-export", { method: "POST", body: fd, headers });
};

function wireRpc(over: { consume?: unknown; failSection?: string } = {}) {
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "consume_tenant_export_token") return { data: over.consume ?? { ok: true, request_id: REQ, fence_at: "2026-11-05T09:29:59Z", tenant_timezone: "Europe/Nicosia", tenant_currency: "TRY" }, error: null };
    if (name === "export_read_section") {
      if (over.failSection && args.p_section === over.failSection) return { data: null, error: { message: "boom", code: "XX000" } };
      return { data: { rows: [], next: null }, error: null };
    }
    if (name === "complete_tenant_export") return { data: { ok: true }, error: null };
    if (name === "fail_tenant_export") return { data: { ok: true }, error: null };
    return { data: null, error: { message: "unexpected " + name } };
  });
}

describe("RT download route", () => {
  it("RT1 only POST is exported (no GET: the token can never travel in a URL)", () => {
    expect(Object.keys(routeModule).filter((k) => ["GET", "PUT", "PATCH", "DELETE", "HEAD"].includes(k))).toEqual([]);
  });
  it("RT2 malformed / missing token -> the one generic 403, no database call", async () => {
    for (const bad of [undefined, "", "short", "x".repeat(44)]) {
      const res = await POST(form(bad));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "export_unavailable" });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("RT3 cross-origin post is refused", async () => {
    const res = await POST(form(GOOD, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("RT4 signed-out caller gets 401 and the token is not consumed", async () => {
    h.getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(form(GOOD));
    expect(res.status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("RT5 a refused consume is the same generic 403 as a malformed token (no enumeration)", async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
    wireRpc({ consume: { ok: false, error: "invalid_token" } });
    const res = await POST(form(GOOD));
    const malformed = await POST(form("x"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(await malformed.json());
  });
  it("RT6 success: streamed zip, attachment, never cached, token only sent as its sha256, completion reported once", async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
    wireRpc();
    const res = await POST(form(GOOD));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="salonos-export-\d{4}-\d{2}-\d{2}-\d{4}\.zip"$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const files = readZip(Buffer.from(await res.arrayBuffer()));
    expect([...files.keys()].some((k) => k.endsWith("metadata.json"))).toBe(true);
    const consumeCall = h.rpc.mock.calls.find((c) => c[0] === "consume_tenant_export_token")!;
    expect(consumeCall[1]).toEqual({ p_token_hash: hashToken(GOOD) });
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain(GOOD);
    const done = h.rpc.mock.calls.filter((c) => c[0] === "complete_tenant_export");
    expect(done.length).toBe(1);
    expect(done[0]![1].p_request_id).toBe(REQ);
    expect(h.rpc.mock.calls.some((c) => c[0] === "fail_tenant_export")).toBe(false);
  });
  it("RT7 a read failure mid-stream aborts the response and reports a failure (never a completion)", async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
    wireRpc({ failSection: "services" });
    const res = await POST(form(GOOD));
    await expect(res.arrayBuffer()).rejects.toThrow();
    await waitFor(() => expect(h.rpc.mock.calls.some((c) => c[0] === "fail_tenant_export")).toBe(true));
    expect(h.rpc.mock.calls.some((c) => c[0] === "complete_tenant_export")).toBe(false);
    const failCall = h.rpc.mock.calls.find((c) => c[0] === "fail_tenant_export")!;
    expect(failCall[1].p_error_code).toMatch(/^[a-z0-9_]{1,40}$/);
  });
});

describe("AC server action", () => {
  it("AC1 unauthenticated / not-a-member / bad slug never reach the database; the raw token is never sent, only its hash", async () => {
    const { prepareTenantExportAction } = await vi.importActual<typeof import("@/lib/modules/export/actions")>("@/lib/modules/export/actions");
    h.getTenantAccess.mockResolvedValue({ reason: "unauthenticated" });
    expect(await prepareTenantExportAction("s")).toEqual({ ok: false, error: "unauthenticated" });
    h.getTenantAccess.mockResolvedValue({ reason: "not_found" });
    expect(await prepareTenantExportAction("s")).toEqual({ ok: false, error: "not_owner" });
    expect(await prepareTenantExportAction("")).toEqual({ ok: false, error: "invalid_request" });
    expect(h.rpc).not.toHaveBeenCalled();

    h.getTenantAccess.mockResolvedValue({ reason: "ok", tenant: { id: "t-1", name: "n", slug: "s", status: "active" }, user: { id: "u" } });
    h.rpc.mockResolvedValue({ data: { ok: true, request_id: REQ, expires_at: "2026-11-05T09:40:00Z", remaining_after: 2 }, error: null });
    const r = await prepareTenantExportAction("s");
    expect(r.ok).toBe(true);
    const args = h.rpc.mock.calls[0]![1];
    expect(args.p_tenant_id).toBe("t-1");
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    if (r.ok) {
      expect(hashToken(r.token)).toBe(args.p_token_hash);
      expect(JSON.stringify(args)).not.toContain(r.token);
    }
    h.rpc.mockResolvedValue({ data: { ok: false, error: "fresh_auth_required" }, error: null });
    expect(await prepareTenantExportAction("s")).toMatchObject({ ok: false, error: "fresh_auth_required" });
    h.rpc.mockResolvedValue({ data: { ok: false, error: "something_new" }, error: null });
    expect(await prepareTenantExportAction("s")).toMatchObject({ ok: false, error: "unexpected" });
  });
});

describe("UI page and panel", () => {
  const status = { allowed: true, remaining: 3, limit: 3, last_export_at: null, next_available_at: null, in_progress: false, fresh_auth: true };
  const RAW = /Export\.[a-zA-Z]/;

  it("UI1 Owner sees the scope, PII warning, fresh-login note, quota and the button; no raw message keys", async () => {
    h.getTenantAccess.mockResolvedValue({ reason: "ok", tenant: { id: "t-1", name: "n", slug: "s", status: "active" }, user: { id: "u" } });
    h.rpc.mockResolvedValue({ data: status, error: null });
    render(await ExportPage({ params: Promise.resolve({ locale: "tr", tenantSlug: "s" }) } as never));
    expect(screen.getByRole("heading", { name: "Verilerimi dışa aktar" })).toBeTruthy();
    expect(screen.getByText(/müşterilerinizin adlarını, telefonlarını/)).toBeTruthy();
    expect(screen.getByText(/son 15 dakika/)).toBeTruthy();
    expect(screen.getByText(/Henüz dışa aktarım yapılmadı/)).toBeTruthy();
    expect(screen.getByText("Bugün kalan hak: 3 / 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dışa aktarımı hazırla ve indir" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(RAW);
  });
  it("UI2 a non-Owner (database says allowed:false) is redirected and sees nothing", async () => {
    h.getTenantAccess.mockResolvedValue({ reason: "ok", tenant: { id: "t-1", name: "n", slug: "s", status: "active" }, user: { id: "u" } });
    h.rpc.mockResolvedValue({ data: { allowed: false }, error: null });
    h.redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
    await expect(ExportPage({ params: Promise.resolve({ locale: "tr", tenantSlug: "s" }) } as never)).rejects.toThrow("NEXT_REDIRECT");
    expect(h.redirect).toHaveBeenCalledWith("/app/s");
  });
  it("UI3 the page is the same in every billing state (it never reads billing at all)", async () => {
    h.getTenantAccess.mockResolvedValue({ reason: "ok", tenant: { id: "t-1", name: "n", slug: "s", status: "active" }, user: { id: "u" } });
    h.rpc.mockResolvedValue({ data: status, error: null });
    await ExportPage({ params: Promise.resolve({ locale: "tr", tenantSlug: "s" }) } as never);
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(["get_tenant_export_status"]);
  });

  const base = { remaining: 3, limit: 3, lastExportLabel: null, nextAvailableLabel: null, inProgress: false };
  it("UI4 quota exhausted or in progress disables the button and says why", () => {
    const { rerender } = render(<TenantExportPanel tenantSlug="s" status={{ ...base, remaining: 0, nextAvailableLabel: "7 Kas 2026 10:00" }} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Yeni dışa aktarım için en erken: 7 Kas 2026 10:00/)).toBeTruthy();
    rerender(<TenantExportPanel tenantSlug="s" status={{ ...base, inProgress: true }} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/şu anda sürüyor/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(RAW);
  });
  it.each(["not_owner", "fresh_auth_required", "rate_limited", "export_in_progress", "too_many_failures", "unauthenticated", "invalid_request", "duplicate_request", "unexpected"])("UI5 error %s renders a Turkish message, never a raw key", async (code) => {
    h.prepare.mockResolvedValue({ ok: false, error: code });
    render(<TenantExportPanel tenantSlug="s" status={base} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).not.toMatch(RAW);
    expect(screen.getByRole("alert").textContent!.length).toBeGreaterThan(10);
    if (code === "fresh_auth_required") expect(screen.getByRole("link", { name: "Yeniden giriş yap" }).getAttribute("href")).toBe("/login?next=%2Fapp%2Fs%2Fexport");
  });
  it("UI6 success posts the token in a hidden POST form body (never a URL) and then forgets it", async () => {
    const t = newExportToken();
    h.prepare.mockResolvedValue({ ok: true, token: t.token, expiresAt: "x", remainingAfter: 2 });
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      expect((this.querySelector('input[name="token"]') as HTMLInputElement).value).toBe(t.token);
      expect(this.method).toBe("post");
      expect(this.getAttribute("action")).toBe("/api/tenant-export");
    });
    render(<TenantExportPanel tenantSlug="s" status={base} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect((document.querySelector('input[name="token"]') as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toMatch(/İndirme başladı/);
    expect(document.body.innerHTML).not.toContain(t.token);
    submit.mockRestore();
  });
});
