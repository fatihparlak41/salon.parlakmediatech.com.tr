import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import {
  PENDING_TEAM_INVITATION_COOKIE,
  TEAM_INVITATION_ROUTE_PATH,
  captureTeamInvitationToken,
} from "@/lib/auth/team-invitation-token";
import { buildAcceptUrl } from "@/lib/modules/team/helpers";

/**
 * Faz SAAS.1D.2 — structural guarantees that can't be observed from a
 * single request: WHO is allowed to touch the raw token and the acceptance
 * RPC, and what the browser-facing files may never contain.
 *
 * These read source text (comments stripped, so prose that merely
 * discusses "accept_team_invitation" doesn't count) because the property
 * is negative and global — "nothing else in the app ever does X" — which a
 * behavioral test can only sample, never prove. Same approach, and the
 * same reason, as the source-level checks elsewhere in this suite.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function code(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(rel);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  for (const dir of ["app", "components", "lib"]) walk(dir);
  out.push("proxy.ts");
  return out;
}

const GENERATED_TYPES = "lib/supabase/database.types.ts";
const TOKEN_CAPTURE = "lib/auth/team-invitation-token.ts";
const PENDING_COOKIE = "lib/auth/pending-team-invitation.ts";
const ACCEPT_CORE = "lib/modules/team/accept-invitation.ts";
const ACCEPT_ACTION = "lib/modules/team/accept-actions.ts";
const ACCEPT_PAGE = "app/[locale]/(auth)/accept-invite/page.tsx";
const ACCEPT_PANEL = "components/auth/accept-invite-panel.tsx";

function filesContaining(needle: string | RegExp, excluding: string[] = []): string[] {
  return sourceFiles()
    .filter((f) => f !== GENERATED_TYPES && !excluding.includes(f))
    .filter((f) => (typeof needle === "string" ? code(f).includes(needle) : needle.test(code(f))))
    .sort();
}

describe("who may accept an invitation", () => {
  it("accept_team_invitation is called from exactly one place in the app", () => {
    expect(filesContaining("accept_team_invitation")).toEqual([ACCEPT_CORE]);
  });

  it("the acceptance core is used by exactly one caller: the explicit-POST Server Action", () => {
    expect(filesContaining("acceptTeamInvitationCore", [ACCEPT_CORE])).toEqual([ACCEPT_ACTION]);
  });

  it("the accept action is referenced only by the confirmation panel's button", () => {
    expect(filesContaining("acceptTeamInvitationAction", [ACCEPT_ACTION])).toEqual([ACCEPT_PANEL]);
  });

  it.each([
    ["the token-capture step", TOKEN_CAPTURE],
    ["proxy.ts", "proxy.ts"],
    ["the auth callback route", "app/auth/callback/route.ts"],
    ["the email-confirmation route", "app/auth/confirm/route.ts"],
    ["the pending-confirmation cookie helper", "lib/auth/pending-confirmation.ts"],
    ["the auth Server Actions (login, sign-up, confirm, sign-out)", "lib/modules/auth/actions.ts"],
    ["the accept page (a GET render)", ACCEPT_PAGE],
    ["the login page", "app/[locale]/(auth)/login/page.tsx"],
    ["the sign-up page", "app/[locale]/(auth)/sign-up/page.tsx"],
  ])("%s never references acceptance in any form", (_label, rel) => {
    const src = code(rel);
    expect(src).not.toMatch(/accept_team_invitation|acceptTeamInvitation|accept-invitation|accept-actions/);
  });

  it("the token-capture module never touches the database or an auth client", () => {
    const src = code(TOKEN_CAPTURE);
    expect(src).not.toMatch(/supabase|createClient|\.rpc\(|\.from\(|getUser|postgres/i);
  });

  it("the accept page performs no database query at all — it can't reveal anything about an invitation to an anonymous visitor", () => {
    const src = code(ACCEPT_PAGE);
    expect(src).not.toMatch(/\.rpc\(|\.from\(|createClient|team_invitations/);
  });

  it("the accept page never reads the query string (so a token left in a URL by any path is inert)", () => {
    const src = code(ACCEPT_PAGE);
    expect(src).not.toMatch(/searchParams|useSearchParams|request\.url|headers\(\)/);
  });
});

describe("who may read the raw token", () => {
  it("getPendingTeamInvitationToken is used only by the accept Server Action", () => {
    expect(filesContaining("getPendingTeamInvitationToken", [PENDING_COOKIE])).toEqual([ACCEPT_ACTION]);
  });

  it("the accept page uses only the boolean hasPendingTeamInvitation()", () => {
    const src = code(ACCEPT_PAGE);
    expect(src).toContain("hasPendingTeamInvitation");
    expect(src).not.toContain("getPendingTeamInvitationToken");
    expect(filesContaining("hasPendingTeamInvitation", [PENDING_COOKIE])).toEqual([ACCEPT_PAGE]);
  });

  it("the cookie name is read/written only by the three token modules", () => {
    expect(filesContaining("PENDING_TEAM_INVITATION_COOKIE", [TOKEN_CAPTURE, PENDING_COOKIE])).toEqual([]);
    expect(filesContaining("sb-pending-team-invitation")).toEqual([TOKEN_CAPTURE]);
  });

  it("the pending-cookie helper is server-only", () => {
    expect(code(PENDING_COOKIE)).toMatch(/import\s+"server-only"/);
  });
});

describe("the browser-facing surface carries no token", () => {
  it("the client panel is a client component with no token prop, storage, cookie access or logging", () => {
    const src = code(ACCEPT_PANEL);
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
    expect(src).not.toMatch(/token/i);
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
    // The only prop is a bag of already-translated labels.
    expect(src).toMatch(/AcceptInvitePanel\(\{ labels \}: \{ labels: Labels \}\)/);
  });

  it("the accept page renders no token and no invited address into markup or props", () => {
    const src = code(ACCEPT_PAGE);
    expect(src).not.toMatch(/token/i);
    expect(src).not.toMatch(/email/i);
  });

  it.each([
    ["capture", TOKEN_CAPTURE],
    ["pending cookie helper", PENDING_COOKIE],
    ["acceptance core", ACCEPT_CORE],
    ["accept action", ACCEPT_ACTION],
    ["accept page", ACCEPT_PAGE],
    ["accept panel", ACCEPT_PANEL],
  ])("the %s never logs, and never handles token_hash or NEXT_PUBLIC values", (_label, rel) => {
    const src = code(rel);
    expect(src).not.toMatch(/console\.|logger/);
    expect(src).not.toMatch(/token_hash|tokenHash/);
    expect(src).not.toMatch(/NEXT_PUBLIC_/);
  });

  it('"use server" files keep to async exports only (a Next.js rule this phase edited around)', () => {
    for (const rel of [ACCEPT_ACTION, "lib/modules/auth/actions.ts"]) {
      const src = code(rel);
      expect(src.trimStart().startsWith('"use server"'), rel).toBe(true);
      const exportLines = src.split("\n").filter((line) => /^export\s/.test(line));
      expect(exportLines.length, rel).toBeGreaterThan(0);
      for (const line of exportLines) expect(line, rel).toMatch(/^export async function /);
    }
  });

  it("the accept page asks search engines not to index it", () => {
    expect(readFileSync(path.join(root, ACCEPT_PAGE), "utf8")).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});

describe("proxy wiring", () => {
  const proxySrc = readFileSync(path.join(root, "proxy.ts"), "utf8");

  it("captures the token before next-intl routing, session refresh, or anything else can run", () => {
    const capture = proxySrc.indexOf("captureTeamInvitationToken(request)");
    const routing = proxySrc.indexOf("handleI18nRouting(request)");
    const sessionRefresh = proxySrc.indexOf("supabase.auth.getUser()");
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(routing);
    expect(capture).toBeLessThan(sessionRefresh);
  });

  it("returns the capture response directly (a redirect), rather than falling through to a page render", () => {
    expect(proxySrc).toMatch(/if \(invitationCapture\) return invitationCapture;/);
  });

  it("the proxy matcher includes /accept-invite (otherwise the capture would silently never run) and still excludes /auth/*", () => {
    const match = /matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"\s*\]/.exec(proxySrc);
    expect(match).not.toBeNull();
    const regex = new RegExp(`^${JSON.parse(`"${match![1]}"`)}$`);

    expect(regex.test("/accept-invite")).toBe(true);
    expect(regex.test("/login")).toBe(true);
    expect(regex.test("/auth/confirm")).toBe(false);
    expect(regex.test("/_next/static/chunk.js")).toBe(false);
  });
});

describe("the invitation email's link and the capture step agree", () => {
  const token = "9f".repeat(32);

  it("buildAcceptUrl points at exactly the URL the capture step handles, carrying the token as its only parameter", () => {
    const url = buildAcceptUrl(token);
    const parsed = new URL(url);

    expect(parsed.pathname).toBe(TEAM_INVITATION_ROUTE_PATH);
    expect([...parsed.searchParams.keys()]).toEqual(["token"]);
    expect(parsed.searchParams.get("token")).toBe(token);
  });

  it("following that link parks the very same token and lands on a token-free URL", () => {
    const url = buildAcceptUrl(token);
    const response = captureTeamInvitationToken(new NextRequest(url));

    expect(response).not.toBeNull();
    expect(response!.cookies.get(PENDING_TEAM_INVITATION_COOKIE)?.value).toBe(token);
    expect(response!.headers.get("location")).not.toContain(token);
    expect(new URL(response!.headers.get("location")!).pathname).toBe("/accept-invite");
  });
});

describe("login and sign-up carry the return path safely", () => {
  it.each([
    ["login page", "app/[locale]/(auth)/login/page.tsx"],
    ["sign-up page", "app/[locale]/(auth)/sign-up/page.tsx"],
  ])("the %s validates `next` with the shared open-redirect guard before using it", (_label, rel) => {
    const src = code(rel);
    expect(src).toContain("resolveSafeNext(");
    expect(src).toContain("getSiteUrl()");
  });

  it.each([
    ["login form", "components/auth/login-form.tsx"],
    ["sign-up form", "components/auth/sign-up-form.tsx"],
  ])("the %s forwards it as a hidden field only when one was validated", (_label, rel) => {
    const src = code(rel);
    expect(src).toMatch(/type="hidden"\s+name="next"/);
    expect(src).toMatch(/next\s*\?/);
  });

  it("the Server Actions re-validate the hidden field instead of trusting it", () => {
    const src = code("lib/modules/auth/actions.ts");
    expect(src).toContain("resolveSafeNext(raw, getSiteUrl())");
    expect(src).toMatch(/redirect\(readSafeNext\(formData\) \?\? "\/"\)/);
    expect(src).toMatch(/redirect\(readSafeNext\(formData\) \?\? "\/"\);?\s*}\s*$/m);
  });

  it("login completion, sign-up and sign-out never call the accept action or read the pending token", () => {
    const src = code("lib/modules/auth/actions.ts");
    expect(src).not.toMatch(/pending-team-invitation|getPendingTeamInvitationToken|clearPendingTeamInvitation/);
  });
});

describe("i18n: every message the accept UI asks for exists", () => {
  const messages = JSON.parse(readFileSync(path.join(root, "messages/tr.json"), "utf8")) as Record<string, unknown>;
  const ns = messages.AcceptInvite as Record<string, unknown>;

  function resolve(key: string): unknown {
    return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], ns);
  }

  it("has an AcceptInvite namespace", () => {
    expect(ns).toBeTypeOf("object");
  });

  it("every t('…') key used by the accept page resolves to a non-empty Turkish string", () => {
    const keys = [...code(ACCEPT_PAGE).matchAll(/\bt\("([\w.]+)"\)/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThanOrEqual(10);
    for (const key of keys) {
      const value = resolve(key);
      expect(value, key).toBeTypeOf("string");
      expect((value as string).trim().length, key).toBeGreaterThan(0);
    }
  });

  it("no message discloses an address or a token placeholder", () => {
    const flat = JSON.stringify(ns);
    expect(flat).not.toMatch(/@|\{token\}|\{email\}/i);
  });
});
