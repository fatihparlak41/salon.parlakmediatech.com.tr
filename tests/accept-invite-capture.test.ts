import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PENDING_TEAM_INVITATION_COOKIE,
  PENDING_TEAM_INVITATION_COOKIE_PATH,
  PENDING_TEAM_INVITATION_TTL_SECONDS,
  captureTeamInvitationToken,
  isValidTeamInvitationTokenShape,
  pendingTeamInvitationCookieOptions,
} from "@/lib/auth/team-invitation-token";
import { acceptTeamInvitationCore } from "@/lib/modules/team/accept-invitation";
import { resolveSafeNext } from "@/app/auth/confirm/route";
import { getSiteUrl } from "@/lib/site-url";
import {
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
 * Faz SAAS.1D.2 — the GET side of the invitation flow.
 *
 * The contract under test: `GET /accept-invite?token=...` may only PARK the
 * token (HttpOnly cookie) and redirect to a token-free URL. It must never
 * accept, never touch the database, and never be able to burn a
 * single-use token — because the real, observed threat is an email
 * scanner (Google Workspace's Safe Browsing prefetch) fetching every link
 * in a message before the human does.
 *
 * captureTeamInvitationToken is exercised directly with real NextRequest
 * objects. proxy() itself can't be imported under Vitest (next-intl's ESM
 * middleware imports "next/server" extension-less, which Node's own
 * resolver rejects outside Next's bundler), so the wiring of that
 * function into proxy.ts is asserted structurally in
 * accept-invite-privacy.test.ts, and the end-to-end HTTP behavior
 * (307 + Set-Cookie + Cache-Control: no-store, locale-prefixed and
 * trailing-slash variants normalized by the framework before capture,
 * malformed/empty tokens dropped) was verified against a real dev server
 * during this phase's manual smoke.
 */

const ORIGIN = "https://salon.example.com";
const VALID_TOKEN = "0123456789abcdef".repeat(4);

function get(url: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, { method: "GET", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("captureTeamInvitationToken", () => {
  it("parks a well-formed token in an HttpOnly cookie and redirects to the token-free URL", () => {
    const response = captureTeamInvitationToken(get(`${ORIGIN}/accept-invite?token=${VALID_TOKEN}`));

    expect(response).not.toBeNull();
    expect(response!.status).toBe(307);

    const location = new URL(response!.headers.get("location")!);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/accept-invite");
    expect(location.search).toBe("");
    expect(response!.headers.get("location")).not.toContain(VALID_TOKEN);

    const cookie = response!.cookies.get(PENDING_TEAM_INVITATION_COOKIE);
    expect(cookie?.value).toBe(VALID_TOKEN);
  });

  it("sets the cookie HttpOnly, SameSite=Lax, path=/, with a finite Max-Age far shorter than the invitation's own 7-day expiry", () => {
    const response = captureTeamInvitationToken(get(`${ORIGIN}/accept-invite?token=${VALID_TOKEN}`))!;
    const cookie = response.cookies.get(PENDING_TEAM_INVITATION_COOKIE)!;

    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.path).toBe(PENDING_TEAM_INVITATION_COOKIE_PATH);
    expect(cookie.path).toBe("/");
    expect(cookie.maxAge).toBe(PENDING_TEAM_INVITATION_TTL_SECONDS);
    expect(Number.isFinite(cookie.maxAge)).toBe(true);
    expect(cookie.maxAge!).toBeGreaterThan(0);
    expect(cookie.maxAge!).toBeLessThan(7 * 24 * 60 * 60);
    // Not a session cookie either: a finite lifetime, so it can't outlive
    // the reason it was set on a shared machine that never closes its browser.
    expect(response.headers.getSetCookie().join(";")).toMatch(/Max-Age=\d+/i);
  });

  it("marks the cookie Secure in production and only in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(pendingTeamInvitationCookieOptions().secure).toBe(true);
    const prod = captureTeamInvitationToken(get(`${ORIGIN}/accept-invite?token=${VALID_TOKEN}`))!;
    expect(prod.cookies.get(PENDING_TEAM_INVITATION_COOKIE)?.secure).toBe(true);
    expect(prod.headers.getSetCookie().join(";")).toMatch(/;\s*Secure/i);

    vi.stubEnv("NODE_ENV", "development");
    expect(pendingTeamInvitationCookieOptions().secure).toBe(false);
  });

  it("marks the redirect no-store so a shared cache can never replay someone else's Set-Cookie", () => {
    const response = captureTeamInvitationToken(get(`${ORIGIN}/accept-invite?token=${VALID_TOKEN}`))!;
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("drops every other query parameter, so a crafted URL can't turn the redirect into anything but /accept-invite", () => {
    const response = captureTeamInvitationToken(
      get(`${ORIGIN}/accept-invite?token=${VALID_TOKEN}&next=https://evil.example&utm_source=mail`),
    )!;
    const location = response.headers.get("location")!;
    expect(new URL(location).pathname).toBe("/accept-invite");
    expect(location).not.toContain("?");
    expect(location).not.toContain("evil.example");
  });

  it("a new token overwrites one already parked (re-clicking the email link is the recovery path)", () => {
    const newer = "fedcba9876543210".repeat(4);
    const response = captureTeamInvitationToken(
      get(`${ORIGIN}/accept-invite?token=${newer}`, {
        cookie: `${PENDING_TEAM_INVITATION_COOKIE}=${VALID_TOKEN}`,
      }),
    )!;
    expect(response.cookies.get(PENDING_TEAM_INVITATION_COOKIE)?.value).toBe(newer);
  });

  describe.each([
    ["empty", ""],
    ["too short", "abc123"],
    ["63 chars", "a".repeat(63)],
    ["65 chars", "a".repeat(65)],
    ["uppercase hex", "A".repeat(64)],
    ["non-hex letters", "g".repeat(64)],
    ["contains a space", `${"a".repeat(63)} `],
    ["script injection", "<script>alert(1)</script>"],
    ["path traversal", "../../etc/passwd"],
    ["CRLF header injection", `${"a".repeat(64)}%0d%0aSet-Cookie:evil=1`],
  ])("malformed token (%s)", (_label, value) => {
    it("is never parked, never reflected, and still redirects to the token-free page", () => {
      const response = captureTeamInvitationToken(
        get(`${ORIGIN}/accept-invite?token=${encodeURIComponent(value)}`),
      );

      expect(response).not.toBeNull();
      expect(response!.status).toBe(307);
      expect(response!.headers.getSetCookie()).toEqual([]);
      expect(response!.cookies.get(PENDING_TEAM_INVITATION_COOKIE)).toBeUndefined();

      const location = response!.headers.get("location")!;
      expect(new URL(location).search).toBe("");
      if (value) expect(location).not.toContain(value);
    });
  });

  it("a bare `?token` (no value) is treated as an empty, malformed token", () => {
    const response = captureTeamInvitationToken(get(`${ORIGIN}/accept-invite?token`))!;
    expect(response.status).toBe(307);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  describe("passes everything else through untouched (returns null)", () => {
    it.each([
      ["a different path", `${ORIGIN}/login?token=${VALID_TOKEN}`],
      ["home", `${ORIGIN}/`],
      ["a sub-path", `${ORIGIN}/accept-invite/extra?token=${VALID_TOKEN}`],
      ["a look-alike path", `${ORIGIN}/accept-invitee?token=${VALID_TOKEN}`],
      ["a prefixed path", `${ORIGIN}/x/accept-invite?token=${VALID_TOKEN}`],
      ["the accept page with no token", `${ORIGIN}/accept-invite`],
      ["the accept page with only other params", `${ORIGIN}/accept-invite?foo=bar`],
    ])("GET: %s", (_label, url) => {
      expect(captureTeamInvitationToken(get(url))).toBeNull();
    });

    it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
      "%s to the token URL is not intercepted — capture is GET-only",
      (method) => {
        const request = new NextRequest(`${ORIGIN}/accept-invite?token=${VALID_TOKEN}`, { method });
        expect(captureTeamInvitationToken(request)).toBeNull();
      },
    );
  });
});

describe("isValidTeamInvitationTokenShape", () => {
  it("accepts exactly 64 lowercase hex characters", () => {
    expect(isValidTeamInvitationTokenShape(VALID_TOKEN)).toBe(true);
    expect(isValidTeamInvitationTokenShape("0".repeat(64))).toBe(true);
  });

  it.each([
    undefined,
    null,
    42,
    {},
    [],
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}\n`,
    ` ${"a".repeat(63)}`,
  ])("rejects %j", (value) => {
    expect(isValidTeamInvitationTokenShape(value)).toBe(false);
  });
});

describe("open-redirect safety of the auth return path (`next`)", () => {
  // The same derivation lib/modules/auth/actions.ts and the login/sign-up
  // pages use: resolveSafeNext(rawNext, getSiteUrl()). A separate fixed
  // origin also exercises the production-shaped host.
  const prod = "https://salon.parlakmediatech.com.tr";

  it.each([
    ["/accept-invite", "/accept-invite"],
    ["/app", "/app"],
    ["/app/example", "/app/example"],
    ["/app/example/team", "/app/example/team"],
  ])("allows the same-origin path %s", (input, expected) => {
    expect(resolveSafeNext(input, prod)).toBe(expected);
    expect(resolveSafeNext(input, getSiteUrl())).toBe(expected);
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with a path", "//evil.com/accept-invite"],
    ["backslash host", "/\\evil.com"],
    ["double backslash host", "\\\\evil.com"],
    ["absolute https", "https://evil.example"],
    ["absolute http with an /accept-invite path", "http://evil.example/accept-invite"],
    ["look-alike suffix host", `${prod}.evil.example/accept-invite`],
    ["userinfo trick", "https://salon.parlakmediatech.com.tr@evil.example/"],
    ["javascript: URL", "javascript:alert(1)"],
    ["data: URL", "data:text/html,<script>alert(1)</script>"],
    ["tab inside the slashes", "/\t/evil.com"],
    ["newline inside the slashes", "/\n/evil.com"],
    ["malformed", "http://[::1"],
  ])("falls back to / for %s", (_label, input) => {
    expect(resolveSafeNext(input, prod)).toBe("/");
    expect(resolveSafeNext(input, getSiteUrl())).toBe("/");
  });

  it("keeps an encoded-slash path on this origin (it is a path, not a host)", () => {
    const result = resolveSafeNext("/%2F%2Fevil.com", prod);
    expect(result.startsWith("/")).toBe(true);
    expect(new URL(result, prod).origin).toBe(prod);
  });
});

describe("scanner / prefetch safety against a real invitation (no SMTP, DEV database)", () => {
  let owner: TestUser;
  let tenant: TestTenant;
  let roleId: string;
  let ownerClient: SupabaseClient;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    owner = await createTestUser("aic-owner");
    createdUserIds.push(owner.id);

    tenant = await createTestTenant(`test-tenant-aic-${Date.now().toString(36)}`, owner.id);
    roleId = await createRoleForTenant(tenant.id, "Sınırlı Davet Rolü", ["appointments.view"]);
    ownerClient = await signInAs(owner);
  }, 60000);

  afterAll(async () => {
    await cleanupTenants([tenant.id]);
    await cleanupUsers(createdUserIds);
  }, 60000);

  type Fixture = {
    user: TestUser;
    client: SupabaseClient;
    staffId: string;
    invitation: { id: string; token: string };
  };

  /** Own user + staff member + invitation per test, so no test depends on
   * another's leftover state (one pending invitation per email/tenant). */
  async function freshFixture(label: string): Promise<Fixture> {
    const user = await createTestUser(label);
    createdUserIds.push(user.id);
    const client = await signInAs(user);

    const [staff] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${tenant.id}, ${label}) returning id
    `;

    // create_team_invitation directly — the RPC, not createTeamInvitationCore,
    // so NO email is sent from this file, ever.
    const { data, error } = await ownerClient.rpc("create_team_invitation", {
      p_tenant_id: tenant.id,
      p_email: user.email,
      p_role_id: roleId,
      p_staff_member_id: staff!.id,
    });
    if (error || !data) throw new Error(`invitation setup failed: ${error?.message}`);

    return { user, client, staffId: staff!.id, invitation: (data as { id: string; token: string }[])[0]! };
  }

  async function groundTruth(f: Fixture) {
    const [row] = await testDb<
      { status: string; accepted_at: Date | null; accepted_by: string | null; token_hash: string }[]
    >`select status, accepted_at, accepted_by, token_hash from team_invitations where id = ${f.invitation.id}`;
    const [memberships] = await testDb<{ n: number }[]>`
      select count(*)::int as n from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${f.user.id}
    `;
    const [linked] = await testDb<{ linked: boolean }[]>`
      select tenant_membership_id is not null as linked from staff_members where id = ${f.staffId}
    `;
    const [audit] = await testDb<{ n: number }[]>`
      select count(*)::int as n from audit_logs
      where action = 'team_invitation.accepted' and entity_id = ${f.invitation.id}
    `;
    return { row: row!, memberships: memberships!.n, staffLinked: linked!.linked, acceptedAuditEvents: audit!.n };
  }

  it("repeated token GETs (scanner, prefetch, human) accept nothing and change nothing", async () => {
    const f = await freshFixture("aic-scan");
    const url = `${ORIGIN}/accept-invite?token=${f.invitation.token}`;

    for (let i = 0; i < 3; i++) {
      const response = captureTeamInvitationToken(get(url));
      expect(response).not.toBeNull();
      expect(response!.status).toBe(307);
      expect(response!.headers.get("location")).not.toContain(f.invitation.token);
    }

    const state = await groundTruth(f);
    expect(state.row.status).toBe("pending");
    expect(state.row.accepted_at).toBeNull();
    expect(state.row.accepted_by).toBeNull();
    expect(state.row.token_hash).toBe(sha256Hex(f.invitation.token));
    expect(state.memberships).toBe(0);
    expect(state.staffLinked).toBe(false);
    expect(state.acceptedAuditEvents).toBe(0);
  });

  it("the token survives those GETs: the real, email-matching invitee can still accept afterwards", async () => {
    const f = await freshFixture("aic-survive");
    for (let i = 0; i < 3; i++) {
      captureTeamInvitationToken(get(`${ORIGIN}/accept-invite?token=${f.invitation.token}`));
    }

    const result = await acceptTeamInvitationCore(f.client, f.invitation.token);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.outcome).toBe("accepted");

    const state = await groundTruth(f);
    expect(state.row.status).toBe("accepted");
    expect(state.row.accepted_by).toBe(f.user.id);
    expect(state.memberships).toBe(1);
    expect(state.staffLinked).toBe(true);
    expect(state.acceptedAuditEvents).toBe(1);
  });

  it("even a GET carrying the matching invitee's own live session does not accept — a signed-in click still needs the explicit button", async () => {
    const f = await freshFixture("aic-session");
    const { data: session } = await f.client.auth.getSession();
    const accessToken = session.session!.access_token;

    const response = captureTeamInvitationToken(
      get(`${ORIGIN}/accept-invite?token=${f.invitation.token}`, {
        authorization: `Bearer ${accessToken}`,
        cookie: `sb-access-token=${accessToken}`,
      }),
    );
    expect(response).not.toBeNull();
    // The session material is neither read nor echoed back.
    expect(response!.headers.getSetCookie().join(";")).not.toContain(accessToken);
    expect(response!.headers.get("location")).not.toContain(accessToken);

    const state = await groundTruth(f);
    expect(state.row.status).toBe("pending");
    expect(state.row.accepted_by).toBeNull();
    expect(state.memberships).toBe(0);
    expect(state.acceptedAuditEvents).toBe(0);
  });
});
