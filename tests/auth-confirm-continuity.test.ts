import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { GET as authConfirmGet } from "@/app/auth/confirm/route";
import AcceptInvitePage from "@/app/[locale]/(auth)/accept-invite/page";
import { confirmEmailAction, signUpAction } from "@/lib/modules/auth/actions";
import { acceptTeamInvitationAction } from "@/lib/modules/team/accept-actions";
import { POST_CONFIRM_NEXT_METADATA_KEY } from "@/lib/auth/post-confirm-destination";
import { PENDING_TEAM_INVITATION_COOKIE, captureTeamInvitationToken } from "@/lib/auth/team-invitation-token";
import { getSiteUrl } from "@/lib/site-url";
import {
  admin,
  cleanupTenants,
  cleanupUsers,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  sha256Hex,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * SAAS.1D confirmation-continuity — the exact real-PROD scenario as a
 * regression, end to end against the real DEV Supabase project.
 *
 * What happened in PROD: an invited person clicked the invitation email
 * (the token was parked in an HttpOnly cookie), pressed "Hesap Oluştur",
 * signed up, and opened the confirmation email. PROD's shared "Confirm
 * signup" template forwards NO `next`, so the link was just
 * `/auth/confirm?token_hash=…&type=signup` and the person landed on "/"
 * ("Henüz bir salonunuz yok") instead of /accept-invite.
 *
 * What is REAL here: signUpAction, the GET /auth/confirm route handler,
 * confirmEmailAction, supabase.auth.verifyOtp against Supabase Auth,
 * getCurrentUser, the /accept-invite page function, acceptTeamInvitationAction,
 * the accept_team_invitation RPC, the database. What is substituted: the
 * Next request scope (an in-memory cookie jar + a redirect() that throws,
 * the same narrow seams accept-invite-actions.test.ts uses) and ONE network
 * hop — POST /auth/v1/signup is answered by the admin generateLink API
 * with the same payload the client sent, so the account is created exactly
 * as signUp would create it (same user_metadata, same redirect_to) but
 * Supabase sends no email. The confirmation link is built the way PROD's
 * template builds it, i.e. WITHOUT `next`.
 */

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  type CookieWrite = { name: string; value: string; options: Record<string, unknown> | undefined };
  return { RedirectSignal, jar: new Map<string, string>(), writes: [] as CookieWrite[] };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    has: (name: string) => h.jar.has(name),
    getAll: () => [...h.jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      h.writes.push({ name, value, options });
      // Same as a browser: an empty value or Max-Age=0 removes the cookie.
      if (value === "" || options?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
    delete: (name: string) => {
      h.writes.push({ name, value: "", options: { deleted: true } });
      h.jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

// The /accept-invite page renders through next-intl in the real app. Here
// getTranslations reads the REAL Turkish messages, so the assertions below
// see the same strings a visitor does.
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
  return {
    Link: ({ href, children }: { href: string; children?: React.ReactNode }) => createElement("a", { href }, children),
  };
});

const SITE = getSiteUrl();
const PASSWORD = "Test1234!Test1234!";
const PENDING_CONFIRMATION_COOKIE = "sb-pending-email-confirmation";

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

function uniqueEmail(label: string): string {
  return `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${label}@example.com`;
}

// ---------------------------------------------------------------------------
// The single substituted network hop.
// ---------------------------------------------------------------------------

type SignupCapture = {
  body?: { email: string; password: string; data?: Record<string, unknown>; code_challenge?: string };
  redirectTo?: string | null;
  tokenHash?: string;
  userId?: string;
};

const realFetch = globalThis.fetch;
const supabaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;

/**
 * Redirects only `POST <supabase>/auth/v1/signup`. "create" builds the
 * account through the admin generateLink API from the payload the client
 * really sent (no email is sent, unlike signUp); "capture" creates nothing
 * and just records the payload. Every other request goes to the network.
 */
function interceptSignup(mode: "create" | "capture", capture: SignupCapture): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.origin !== supabaseOrigin || url.pathname !== "/auth/v1/signup") {
      return realFetch(input, init);
    }

    const body = (await request.clone().json()) as NonNullable<SignupCapture["body"]>;
    capture.body = body;
    capture.redirectTo = url.searchParams.get("redirect_to");

    if (mode === "capture") {
      const user = {
        id: randomUUID(),
        aud: "authenticated",
        role: "authenticated",
        email: body.email,
        created_at: new Date().toISOString(),
        app_metadata: { provider: "email" },
        user_metadata: body.data ?? {},
      };
      return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } });
    }

    const { data, error } = await admin.auth.admin.generateLink({
      type: "signup",
      email: body.email,
      password: body.password,
      options: { data: body.data, redirectTo: capture.redirectTo ?? undefined },
    });
    if (error || !data) {
      return new Response(JSON.stringify({ code: 500, msg: "generateLink failed" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    capture.tokenHash = data.properties.hashed_token;
    capture.userId = data.user.id;
    createdUserIds.push(data.user.id);
    return new Response(JSON.stringify(data.user), { status: 200, headers: { "content-type": "application/json" } });
  });
}

// ---------------------------------------------------------------------------
// Console capture — diagnostics and everything else that was printed.
// ---------------------------------------------------------------------------

const consoleLines: string[] = [];
const restoreConsole: Array<() => void> = [];

function startConsoleCapture(): void {
  for (const method of ["info", "log", "warn", "error"] as const) {
    const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
    restoreConsole.push(() => spy.mockRestore());
  }
}

type Continuity = Record<string, unknown> & { tag: "invite-continuity"; hop: string };

function continuityLines(from = 0): Continuity[] {
  return consoleLines
    .slice(from)
    .filter((line) => line.startsWith('{"tag":"invite-continuity"'))
    .map((line) => JSON.parse(line) as Continuity);
}

// ---------------------------------------------------------------------------
// Fixtures and journeys.
// ---------------------------------------------------------------------------

let owner: TestUser;
let ownerClient: SupabaseClient<Database>;
let tenant: TestTenant;
let roleId: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function invite(email: string): Promise<{ id: string; token: string }> {
  // The RPC directly — never createTeamInvitationCore — so no email is sent.
  const { data, error } = await ownerClient.rpc("create_team_invitation", { p_tenant_id: tenant.id, p_email: email, p_role_id: roleId });
  if (error || !data) throw new Error(`invitation setup failed: ${error?.message}`);
  return (data as { id: string; token: string }[])[0]!;
}

type AuthRow = { id: string; confirmed: boolean; meta: Record<string, unknown>; appMeta: Record<string, unknown> };

async function authRow(email: string): Promise<AuthRow> {
  const [row] = await testDb<{ id: string; confirmed: boolean; meta: Record<string, unknown>; app_meta: Record<string, unknown> }[]>`
    select id, email_confirmed_at is not null as confirmed, raw_user_meta_data as meta, raw_app_meta_data as app_meta
    from auth.users where email = ${email}
  `;
  if (!row) throw new Error("expected an auth user");
  return { id: row.id, confirmed: row.confirmed, meta: row.meta, appMeta: row.app_meta };
}

async function invitationState(invitationId: string, userId: string) {
  const [row] = await testDb<{ status: string; accepted_by: string | null }[]>`
    select status, accepted_by from team_invitations where id = ${invitationId}
  `;
  const [members] = await testDb<{ n: number }[]>`
    select count(*)::int as n from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${userId}
  `;
  const [audit] = await testDb<{ n: number }[]>`
    select count(*)::int as n from audit_logs where action = 'team_invitation.accepted' and entity_id = ${invitationId}
  `;
  return { status: row!.status, acceptedBy: row!.accepted_by, memberships: members!.n, acceptedAuditRows: audit!.n };
}

type JarSnapshot = { names: string[]; entries: [string, string][]; hasPendingInvitation: boolean; pendingInvitationValue: string | undefined };

function snapshotJar(): JarSnapshot {
  return {
    names: [...h.jar.keys()].sort(),
    entries: [...h.jar],
    hasPendingInvitation: h.jar.has(PENDING_TEAM_INVITATION_COOKIE),
    pendingInvitationValue: h.jar.get(PENDING_TEAM_INVITATION_COOKIE),
  };
}

function resetRequestScope(): void {
  h.jar.clear();
  h.writes.length = 0;
}

/** Parks the invitation token exactly as the real proxy capture does. */
function parkViaRealCapture(token: string): void {
  const response = captureTeamInvitationToken(new NextRequest(`${SITE}/accept-invite?token=${token}`, { method: "GET" }));
  const value = response?.cookies.get(PENDING_TEAM_INVITATION_COOKIE)?.value;
  if (!value) throw new Error("capture did not park a cookie");
  h.jar.set(PENDING_TEAM_INVITATION_COOKIE, value);
}

/** The confirmation link as PROD's template builds it: token_hash + type, NO next. */
function prodConfirmationLink(tokenHash: string, extra = ""): string {
  return `${SITE}/auth/confirm?token_hash=${tokenHash}&type=signup${extra}`;
}

type ConfirmRecord = {
  link: string;
  getStatus: number;
  getLocation: string | null;
  pendingConfirmation: { tokenHash: string; type: string; next: string } | null;
  outcome: Outcome<void>;
  jarAfter: JarSnapshot;
  logs: Continuity[];
};

/** GET the emailed link, then press the confirm button (POST /confirm-email). */
async function openLinkAndConfirm(link: string): Promise<ConfirmRecord> {
  const logFrom = consoleLines.length;
  const response = await authConfirmGet(new Request(link));
  const raw = h.jar.get(PENDING_CONFIRMATION_COOKIE);
  const pendingConfirmation = raw ? (JSON.parse(raw) as ConfirmRecord["pendingConfirmation"]) : null;
  const outcome = await run(() => confirmEmailAction());
  return {
    link,
    getStatus: response.status,
    getLocation: response.headers.get("location"),
    pendingConfirmation,
    outcome,
    jarAfter: snapshotJar(),
    logs: continuityLines(logFrom),
  };
}

/** A fresh, UNCONFIRMED account created by the admin API (no email), for journeys that need a specific user_metadata. */
async function createUnconfirmed(label: string, data: Record<string, unknown>): Promise<{ email: string; id: string; tokenHash: string }> {
  const email = uniqueEmail(label);
  const { data: generated, error } = await admin.auth.admin.generateLink({ type: "signup", email, password: PASSWORD, options: { data } });
  if (error || !generated) throw new Error(`fixture setup failed: ${error?.message}`);
  createdUserIds.push(generated.user.id);
  return { email, id: generated.user.id, tokenHash: generated.properties.hashed_token };
}

// The recorded journeys ------------------------------------------------------

let invitation: { id: string; token: string };
let inviteeEmail: string;

// A: the real PROD scenario — invited sign-up, link WITHOUT next, cookie intact.
const A = {} as {
  jarBeforeSignUp: JarSnapshot;
  signUpOutcome: Outcome<unknown>;
  capture: SignupCapture;
  rowAfterSignUp: AuthRow;
  stateAfterSignUp: Awaited<ReturnType<typeof invitationState>>;
  writesAfterSignUp: typeof h.writes;
  confirm: ConfirmRecord;
  rowAfterConfirm: AuthRow;
  stateAfterConfirm: Awaited<ReturnType<typeof invitationState>>;
  writesAfterConfirm: typeof h.writes;
  pageHtml: string;
  pageLogs: Continuity[];
  signUpLogs: Continuity[];
  jarForAccept: JarSnapshot;
};

// B: explicit next in the link beats the stored hint.
const B = {} as { confirm: ConfirmRecord };
// C: a tampered / hostile hint is rejected.
const C = {} as { confirm: ConfirmRecord };
// D: an ordinary sign-up (no next) — nothing stored, lands on "/".
const D = {} as { capture: SignupCapture; signUpOutcome: Outcome<unknown>; rowAfterSignUp: AuthRow; confirm: ConfirmRecord };
// F: the hint carries the destination even if the invitation cookie is gone.
const F = {} as { confirm: ConfirmRecord; pageHtml: string; pageLogs: Continuity[] };
// G: sign-ups whose `next` is not the invitation route (wiring only, nothing created).
const G = {} as Record<"accountNext" | "hostileNext" | "protocolRelative" | "absoluteForeign", { capture: SignupCapture }>;

async function renderAcceptPage(): Promise<{ html: string; logs: Continuity[] }> {
  const logFrom = consoleLines.length;
  const html = renderToStaticMarkup(await AcceptInvitePage());
  return { html, logs: continuityLines(logFrom) };
}

/** Everything the page's visible text says — the i18n payload never ships in the static markup, only in real Next's flight data. */
function visibleText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

beforeAll(async () => {
  startConsoleCapture();

  owner = await createTestUser("acc-owner");
  createdUserIds.push(owner.id);
  tenant = await createTestTenant(`test-tenant-acc-${Date.now().toString(36)}`, owner.id);
  createdTenantIds.push(tenant.id);
  roleId = await createRoleForTenant(tenant.id, "Davet Rolü", ["appointments.view"]);
  ownerClient = await signInAs(owner);

  // ---- A: the exact real PROD scenario ------------------------------------
  inviteeEmail = uniqueEmail("invitee");
  invitation = await invite(inviteeEmail);
  resetRequestScope();
  parkViaRealCapture(invitation.token); // [1]
  A.jarBeforeSignUp = snapshotJar();

  const signUpLogFrom = consoleLines.length;
  A.capture = {};
  interceptSignup("create", A.capture);
  try {
    A.signUpOutcome = await run(() =>
      signUpAction(null, form({ fullName: "Ayşe Davetli", email: inviteeEmail, password: PASSWORD, next: "/accept-invite" })),
    );
  } finally {
    vi.unstubAllGlobals();
  }
  A.signUpLogs = continuityLines(signUpLogFrom);
  A.rowAfterSignUp = await authRow(inviteeEmail);
  A.stateAfterSignUp = await invitationState(invitation.id, A.rowAfterSignUp.id);
  A.writesAfterSignUp = [...h.writes];

  const writesBeforeConfirm = h.writes.length;
  A.confirm = await openLinkAndConfirm(prodConfirmationLink(A.capture.tokenHash!));
  A.writesAfterConfirm = h.writes.slice(writesBeforeConfirm);
  A.rowAfterConfirm = await authRow(inviteeEmail);
  A.stateAfterConfirm = await invitationState(invitation.id, A.rowAfterConfirm.id);

  const page = await renderAcceptPage();
  A.pageHtml = page.html;
  A.pageLogs = page.logs;
  A.jarForAccept = snapshotJar();

  // ---- B: explicit next wins over the stored hint -------------------------
  resetRequestScope();
  {
    const user = await createUnconfirmed("explicit", { full_name: "Açık Hedef", [POST_CONFIRM_NEXT_METADATA_KEY]: "/accept-invite" });
    B.confirm = await openLinkAndConfirm(prodConfirmationLink(user.tokenHash, `&next=${encodeURIComponent("/account")}`));
  }

  // ---- C: a hostile stored hint is rejected --------------------------------
  resetRequestScope();
  {
    const user = await createUnconfirmed("hostile", { full_name: "Kötü Niyetli", [POST_CONFIRM_NEXT_METADATA_KEY]: "//evil.example/accept-invite" });
    C.confirm = await openLinkAndConfirm(prodConfirmationLink(user.tokenHash));
  }

  // ---- D: ordinary sign-up, nothing to do with invitations -----------------
  resetRequestScope();
  {
    const email = uniqueEmail("plain");
    D.capture = {};
    interceptSignup("create", D.capture);
    try {
      D.signUpOutcome = await run(() => signUpAction(null, form({ fullName: "Sıradan Kullanıcı", email, password: PASSWORD })));
    } finally {
      vi.unstubAllGlobals();
    }
    D.rowAfterSignUp = await authRow(email);
    D.confirm = await openLinkAndConfirm(prodConfirmationLink(D.capture.tokenHash!));
  }

  // ---- F: the invitation cookie is gone by confirmation time ---------------
  resetRequestScope();
  {
    const user = await createUnconfirmed("nocookie", { full_name: "Çerezsiz", [POST_CONFIRM_NEXT_METADATA_KEY]: "/accept-invite" });
    F.confirm = await openLinkAndConfirm(prodConfirmationLink(user.tokenHash));
    const page2 = await renderAcceptPage();
    F.pageHtml = page2.html;
    F.pageLogs = page2.logs;
  }

  // ---- G: sign-ups whose next is not the invitation route -------------------
  const variants: Array<[keyof typeof G, string]> = [
    ["accountNext", "/account"],
    ["hostileNext", "https://evil.example/accept-invite"],
    ["protocolRelative", "//evil.example/accept-invite"],
    ["absoluteForeign", "javascript:alert(1)"],
  ];
  for (const [key, next] of variants) {
    resetRequestScope();
    const capture: SignupCapture = {};
    interceptSignup("capture", capture);
    try {
      await run(() => signUpAction(null, form({ fullName: "Yönlendirme", email: uniqueEmail(`g-${key}`), password: PASSWORD, next })));
    } finally {
      vi.unstubAllGlobals();
    }
    G[key] = { capture };
  }
}, 240000);

afterAll(async () => {
  for (const restore of restoreConsole) restore();
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

// ---------------------------------------------------------------------------
// The real PROD scenario, requirement by requirement.
// ---------------------------------------------------------------------------

describe("SAAS.1D confirmation continuity — invited sign-up, confirmation link WITHOUT next", () => {
  it("[1] the pending team-invitation cookie exists before sign-up, parked by the real capture code", () => {
    expect(A.jarBeforeSignUp.hasPendingInvitation).toBe(true);
    expect(A.jarBeforeSignUp.pendingInvitationValue).toBe(invitation.token);
  });

  it("[2] a fresh, UNCONFIRMED account is created by the sign-up", () => {
    expect(A.signUpOutcome).toMatchObject({ kind: "returned", value: { success: true } });
    expect(A.rowAfterSignUp.confirmed).toBe(false);
  });

  it("[3] signUpAction receives next=/accept-invite and forwards it as the email redirect, unchanged from before", () => {
    expect(A.capture.redirectTo).toBe(`${SITE}/accept-invite`);
    expect(A.capture.body?.email).toBe(inviteeEmail);
  });

  it("[4] user_metadata carries post_confirm_next = /accept-invite and nothing else of ours besides the display name", () => {
    expect(A.capture.body?.data).toEqual({ full_name: "Ayşe Davetli", [POST_CONFIRM_NEXT_METADATA_KEY]: "/accept-invite" });
    expect(A.rowAfterSignUp.meta).toEqual({ full_name: "Ayşe Davetli", [POST_CONFIRM_NEXT_METADATA_KEY]: "/accept-invite" });
  });

  it("[5] the confirmation link carries NO next parameter, matching the real PROD template", () => {
    const link = new URL(A.confirm.link);
    expect(link.pathname).toBe("/auth/confirm");
    expect([...link.searchParams.keys()].sort()).toEqual(["token_hash", "type"]);
    expect(link.searchParams.get("type")).toBe("signup");
    // The route handler parked the confirmation with no explicit destination.
    expect(A.confirm.getStatus).toBe(307);
    expect(new URL(A.confirm.getLocation!).pathname).toBe("/confirm-email");
    expect(A.confirm.pendingConfirmation).toMatchObject({ type: "signup", next: "/" });
  });

  it("[6] the confirmation succeeds: the account is confirmed and a session exists", () => {
    expect(A.rowAfterConfirm.confirmed).toBe(true);
    expect(A.confirm.jarAfter.names.some((n) => /^sb-.+-auth-token(\.\d+)?$/.test(n))).toBe(true);
    expect(A.confirm.jarAfter.names).not.toContain(PENDING_CONFIRMATION_COOKIE);
  });

  it("[7] the destination becomes /accept-invite through the metadata fallback", () => {
    expect(A.confirm.outcome).toEqual({ kind: "redirected", url: "/accept-invite" });
    const success = A.confirm.logs.find((l) => l.hop === "confirm-email-success");
    expect(success).toMatchObject({ explicitNextPresent: false, metadataNextPresent: true, metadataNextAccepted: true, destinationSource: "metadata" });
  });

  it("[8] the invitation cookie is still present, byte for byte, after confirmation", () => {
    expect(A.confirm.jarAfter.hasPendingInvitation).toBe(true);
    expect(A.confirm.jarAfter.pendingInvitationValue).toBe(invitation.token);
    expect(A.writesAfterConfirm.some((w) => w.name === PENDING_TEAM_INVITATION_COOKIE)).toBe(false);
  });

  it("[9] confirming does not touch the invitation: it is still pending", () => {
    expect(A.stateAfterSignUp.status).toBe("pending");
    expect(A.stateAfterConfirm).toMatchObject({ status: "pending", acceptedBy: null });
    expect(A.stateAfterConfirm.acceptedAuditRows).toBe(0);
  });

  it("[10] confirming creates no membership", () => {
    expect(A.stateAfterSignUp.memberships).toBe(0);
    expect(A.stateAfterConfirm.memberships).toBe(0);
  });

  it("[11] /accept-invite renders the accept panel for the confirmed, signed-in invitee", () => {
    const text = visibleText(A.pageHtml);
    expect(text).toContain("Ekip davetini kabul et");
    expect(text).toContain("Daveti Kabul Et");
    expect(text).not.toContain("Davet bağlantısı bulunamadı");
    expect(text).not.toContain("Hesap Oluştur");
    expect(A.pageLogs).toEqual([
      {
        tag: "invite-continuity",
        hop: "accept-invite-render",
        pendingInvitationCookiePresent: true,
        pendingInvitationCookieShapeValid: true,
        authenticated: true,
        view: "accept-panel",
      },
    ]);
  });

  it("[12][13] only the explicit acceptance creates the membership: exactly one, with exactly one audit transition", async () => {
    // Nothing above created one.
    expect(A.stateAfterConfirm.memberships).toBe(0);
    expect(A.stateAfterConfirm.acceptedAuditRows).toBe(0);

    // The person presses "Daveti Kabul Et": same session, same parked cookie.
    resetRequestScope();
    for (const [name, value] of A.jarForAccept.entries) h.jar.set(name, value);
    const outcome = await run(() => acceptTeamInvitationAction(null));

    expect(outcome).toEqual({ kind: "redirected", url: `/app/${tenant.slug}` });
    expect(await invitationState(invitation.id, A.rowAfterConfirm.id)).toEqual({
      status: "accepted",
      acceptedBy: A.rowAfterConfirm.id,
      memberships: 1,
      acceptedAuditRows: 1,
    });
    // ...and the parked token is consumed only now.
    expect(h.jar.has(PENDING_TEAM_INVITATION_COOKIE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Privacy: the token (and every other secret) is nowhere it must not be.
// ---------------------------------------------------------------------------

describe("SAAS.1D confirmation continuity — nothing sensitive leaks", () => {
  const tokenHash = () => sha256Hex(invitation.token);

  it("[14] user_metadata never contains the invitation token, its hash, or any invitation/tenant/role/user id", () => {
    for (const meta of [A.rowAfterSignUp.meta, A.rowAfterConfirm.meta, A.rowAfterConfirm.appMeta]) {
      const serialized = JSON.stringify(meta);
      for (const secret of [invitation.token, tokenHash(), invitation.id, tenant.id, roleId, owner.id, A.rowAfterConfirm.id, inviteeEmail, A.capture.tokenHash!]) {
        expect(serialized).not.toContain(secret);
      }
    }
    // What WE wrote is exactly two keys; anything else in there is GoTrue's own bookkeeping.
    expect(Object.keys(A.rowAfterSignUp.meta).sort()).toEqual(["full_name", POST_CONFIRM_NEXT_METADATA_KEY].sort());
    expect(A.rowAfterConfirm.meta[POST_CONFIRM_NEXT_METADATA_KEY]).toBe("/accept-invite");
  });

  it("[15] the confirmation link and the sign-up request contain no invitation token", () => {
    expect(A.confirm.link).not.toContain(invitation.token);
    expect(A.confirm.link).not.toContain(tokenHash());
    const requestJson = JSON.stringify([A.capture.body, A.capture.redirectTo]);
    expect(requestJson).not.toContain(invitation.token);
    expect(requestJson).not.toContain(tokenHash());
    expect(A.capture.redirectTo).not.toMatch(/token/i);
  });

  it("[16] the rendered /accept-invite HTML contains no token, hash, identity or invitation id", () => {
    for (const secret of [invitation.token, tokenHash(), invitation.id, tenant.id, roleId, inviteeEmail, A.rowAfterConfirm.id]) {
      expect(A.pageHtml).not.toContain(secret);
    }
    expect(A.pageHtml).not.toMatch(/[0-9a-f]{64}/);
  });

  it("[17] the token reaches no client-readable storage: no cookie write ever contains it, and only the HttpOnly cookie ever held it", () => {
    // Every cookie the sign-up and the confirmation wrote (the Supabase PKCE verifiers, the session,
    // the pending-confirmation cookie): none is the invitation cookie, none carries the token or its hash.
    const allWrites = [...A.writesAfterSignUp, ...A.writesAfterConfirm];
    expect(allWrites.length).toBeGreaterThan(0);
    expect(allWrites.map((w) => w.name)).not.toContain(PENDING_TEAM_INVITATION_COOKIE);
    for (const write of allWrites) {
      expect(write.value, write.name).not.toContain(invitation.token);
      expect(write.value, write.name).not.toContain(tokenHash());
    }
    // The cookies a browser script could read (not HttpOnly) are exactly Supabase-owned ones.
    const clientReadable = allWrites.filter((w) => w.options?.httpOnly !== true && w.value !== "").map((w) => w.name);
    expect(clientReadable.length).toBeGreaterThan(0);
    for (const name of clientReadable) expect(name, name).toMatch(/^sb-[a-z0-9]+-auth-token(-|\.|$)/);
    // The only place the token lives in the jar is the parked cookie itself.
    const holders = A.jarForAccept.entries.filter(([, value]) => value.includes(invitation.token)).map(([name]) => name);
    expect(holders).toEqual([PENDING_TEAM_INVITATION_COOKIE]);
  });

  it("[18] diagnostics are presence-only: closed shape, and no token, hash, URL, email, id or cookie value in ANY captured output", () => {
    const journeyLines = [...A.signUpLogs, ...A.confirm.logs, ...A.pageLogs];
    expect(journeyLines.map((l) => l.hop)).toEqual(["sign-up", "auth-confirm-get", "confirm-email-success", "accept-invite-render"]);

    const ALLOWED_KEYS = new Set([
      "tag",
      "hop",
      "confirmType",
      "destinationSource",
      "view",
      "pendingInvitationCookiePresent",
      "pendingInvitationCookieShapeValid",
      "pendingConfirmationCookiePresent",
      "explicitNextPresent",
      "metadataNextPresent",
      "metadataNextAccepted",
      "metadataHintWritten",
      "authenticated",
      "sweptCookieCount",
      "preservedCookieCount",
      "pendingInvitationCookiePreserved",
    ]);
    const ENUMS: Record<string, string[]> = {
      confirmType: ["signup", "invite", "magiclink", "recovery", "email_change", "email"],
      destinationSource: ["explicit", "metadata", "default"],
      view: ["no-pending", "continuation", "accept-panel"],
    };
    for (const line of continuityLines()) {
      for (const [key, value] of Object.entries(line)) {
        expect(ALLOWED_KEYS.has(key), `unexpected diagnostic field ${key}`).toBe(true);
        if (key === "tag") expect(value).toBe("invite-continuity");
        else if (key === "hop") expect(typeof value).toBe("string");
        else if (ENUMS[key]) expect(ENUMS[key]).toContain(value);
        else expect(["boolean", "number"], `${key} must be a boolean or count`).toContain(typeof value);
      }
    }

    const forbidden = [
      invitation.token,
      tokenHash(),
      A.capture.tokenHash!,
      A.confirm.link,
      inviteeEmail,
      owner.email,
      invitation.id,
      tenant.id,
      roleId,
      A.rowAfterConfirm.id,
      ...A.confirm.jarAfter.entries.map(([, value]) => value).filter((v) => v.length >= 8),
    ];
    const everythingPrinted = consoleLines.join("\n");
    for (const secret of forbidden) expect(everythingPrinted).not.toContain(secret);
  });

  it("the diagnostics report the truth at each hop of the real scenario", () => {
    const byHop = Object.fromEntries([...A.signUpLogs, ...A.confirm.logs, ...A.pageLogs].map((l) => [l.hop, l]));
    expect(byHop["sign-up"]).toEqual({
      tag: "invite-continuity",
      hop: "sign-up",
      pendingInvitationCookiePresent: true,
      pendingInvitationCookieShapeValid: true,
      metadataHintWritten: true,
    });
    expect(byHop["auth-confirm-get"]).toEqual({
      tag: "invite-continuity",
      hop: "auth-confirm-get",
      pendingInvitationCookiePresent: true,
      pendingInvitationCookieShapeValid: true,
      confirmType: "signup",
      pendingConfirmationCookiePresent: true,
      explicitNextPresent: false,
    });
    expect(byHop["confirm-email-success"]).toEqual({
      tag: "invite-continuity",
      hop: "confirm-email-success",
      pendingInvitationCookiePresent: true,
      pendingInvitationCookieShapeValid: true,
      confirmType: "signup",
      pendingConfirmationCookiePresent: true,
      explicitNextPresent: false,
      metadataNextPresent: true,
      metadataNextAccepted: true,
      destinationSource: "metadata",
    });
  });
});

// ---------------------------------------------------------------------------
// Precedence, tampering, and the unchanged ordinary sign-up.
// ---------------------------------------------------------------------------

describe("SAAS.1D confirmation continuity — precedence and safety", () => {
  it("[19] an explicit valid next in the link overrides the stored hint", () => {
    expect(B.confirm.pendingConfirmation).toMatchObject({ type: "signup", next: "/account" });
    expect(B.confirm.outcome).toEqual({ kind: "redirected", url: "/account" });
    expect(B.confirm.logs.find((l) => l.hop === "confirm-email-success")).toMatchObject({
      explicitNextPresent: true,
      metadataNextPresent: true,
      destinationSource: "explicit",
    });
  });

  it("[20] a hostile stored hint is rejected: the confirmation lands on / and the diagnostics say the hint was refused", () => {
    expect(C.confirm.outcome).toEqual({ kind: "redirected", url: "/" });
    expect(C.confirm.logs.find((l) => l.hop === "confirm-email-success")).toMatchObject({
      metadataNextPresent: true,
      metadataNextAccepted: false,
      destinationSource: "default",
    });
  });

  it("[21] an ordinary sign-up is unchanged: nothing extra is stored, the redirect is the bare site URL, and it lands on /", () => {
    expect(D.signUpOutcome).toMatchObject({ kind: "returned", value: { success: true } });
    expect(D.capture.redirectTo).toBe(SITE);
    expect(D.capture.body?.data).toEqual({ full_name: "Sıradan Kullanıcı" });
    expect(Object.keys(D.rowAfterSignUp.meta)).toEqual(["full_name"]);
    expect(D.confirm.outcome).toEqual({ kind: "redirected", url: "/" });
    expect(D.confirm.logs.find((l) => l.hop === "confirm-email-success")).toMatchObject({
      metadataNextPresent: false,
      metadataNextAccepted: false,
      destinationSource: "default",
    });
  });

  it("a sign-up whose next is not the invitation route stores no hint and keeps its existing redirect_to behavior", () => {
    expect(G.accountNext.capture.body?.data).toEqual({ full_name: "Yönlendirme" });
    expect(G.accountNext.capture.redirectTo).toBe(`${SITE}/account`);

    for (const key of ["hostileNext", "protocolRelative", "absoluteForeign"] as const) {
      // Off-site / non-web values are neutralized to the site root by the existing guard, exactly as before.
      expect(G[key].capture.body?.data, key).toEqual({ full_name: "Yönlendirme" });
      expect(G[key].capture.redirectTo, key).toBe(SITE);
    }
  });

  it("the hint is scoped to the invitation route: it is the only value the sign-up writes, for any next", () => {
    const written = [A.capture, D.capture, G.accountNext.capture, G.hostileNext.capture, G.protocolRelative.capture, G.absoluteForeign.capture]
      .map((c) => c.body?.data?.[POST_CONFIRM_NEXT_METADATA_KEY])
      .filter((v) => v !== undefined);
    expect(written).toEqual(["/accept-invite"]);
  });

  it("if the invitation cookie is lost, the account still returns to /accept-invite, and the page honestly asks for the email link again", () => {
    expect(F.confirm.outcome).toEqual({ kind: "redirected", url: "/accept-invite" });
    expect(F.confirm.logs.find((l) => l.hop === "confirm-email-success")).toMatchObject({
      pendingInvitationCookiePresent: false,
      destinationSource: "metadata",
    });
    const text = visibleText(F.pageHtml);
    expect(text).toContain("Davet bağlantısı bulunamadı");
    expect(text).not.toContain("Daveti Kabul Et");
    expect(F.pageLogs[0]).toMatchObject({ view: "no-pending", authenticated: true, pendingInvitationCookiePresent: false });
  });

  it("every confirmation is single-use: the pending-confirmation cookie is consumed whatever the destination", () => {
    for (const record of [A.confirm, B.confirm, C.confirm, D.confirm, F.confirm]) {
      expect(record.pendingConfirmation, record.link.replace(/token_hash=[^&]+/, "token_hash=…")).not.toBeNull();
      expect(record.jarAfter.names).not.toContain(PENDING_CONFIRMATION_COOKIE);
    }
  });
});
