import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAccountMagicLinkAction } from "@/lib/modules/customer-account/actions";
import { confirmEmailAction } from "@/lib/modules/auth/actions";
import { POST_CONFIRM_NEXT_METADATA_KEY } from "@/lib/auth/post-confirm-destination";
import { getSiteUrl } from "@/lib/site-url";

/**
 * SAAS.1D confirmation-continuity — customer-auth regression.
 *
 * The customer flows (public-booking verified claim, customer-portal magic
 * link) share the prefetch-safe confirmation infrastructure with the staff
 * sign-up that this fix touches: GET /auth/confirm -> /confirm-email ->
 * confirmEmailAction. The fix must not change what they do. This file pins
 * that, without a network:
 *
 *  1. the customer OTP / magic-link requests still send exactly what they
 *     sent before — no user_metadata, no hint;
 *  2. a customer confirmation (magiclink, or a signup whose link DID carry
 *     `next`) still lands on its explicit destination, and a hint can never
 *     redirect a magic-link confirmation;
 *  3. the hint key exists only in the invitation code path.
 *
 * (The customer suites that need the database — customer-account-*,
 * salon-assisted-link, future-booking-claim, booking-gateway — are
 * unaffected by construction and run as part of the regression set.)
 */

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { RedirectSignal, jar: new Map<string, string>(), client: null as unknown };
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
      if (value === "" || options?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
    delete: (name: string) => {
      h.jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
// revalidatePath needs Next's request scope; the customer actions import it.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const SITE = getSiteUrl();

async function run(fn: () => Promise<unknown>): Promise<{ kind: "returned"; value: unknown } | { kind: "redirected"; url: string }> {
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

beforeEach(() => {
  h.jar.clear();
  h.client = null;
});

describe("customer portal magic-link request is unchanged", () => {
  function install() {
    const signInWithOtp = vi.fn(async () => ({ data: {}, error: null }));
    h.client = { auth: { signInWithOtp } };
    return signInWithOtp;
  }

  it("sends exactly { email, shouldCreateUser, emailRedirectTo } — no user_metadata, no post-confirm hint", async () => {
    const signInWithOtp = install();

    const outcome = await run(() => requestAccountMagicLinkAction(null, form({ email: "musteri@example.com" })));

    expect(outcome).toMatchObject({ kind: "returned", value: { success: true } });
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "musteri@example.com",
      options: { shouldCreateUser: true, emailRedirectTo: `${SITE}/auth/confirm?next=${encodeURIComponent("/account")}` },
    });
    const [payload] = signInWithOtp.mock.calls[0] as unknown as [{ options: Record<string, unknown> }];
    expect(Object.keys(payload.options).sort()).toEqual(["emailRedirectTo", "shouldCreateUser"]);
    expect(JSON.stringify(payload)).not.toContain(POST_CONFIRM_NEXT_METADATA_KEY);
  });

  it("a guarded-route return path still rides in the redirect URL, exactly as before", async () => {
    const signInWithOtp = install();

    await run(() => requestAccountMagicLinkAction(null, form({ email: "musteri@example.com", next: "/account/link-salon/some-salon" })));

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "musteri@example.com",
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${SITE}/auth/confirm?next=${encodeURIComponent("/account/link-salon/some-salon")}`,
      },
    });
  });

  it("even a request for the invitation route from the customer form writes no hint (it is not a sign-up)", async () => {
    const signInWithOtp = install();

    await run(() => requestAccountMagicLinkAction(null, form({ email: "musteri@example.com", next: "/accept-invite" })));

    const [payload] = signInWithOtp.mock.calls[0] as unknown as [{ options: Record<string, unknown> }];
    expect(payload.options).not.toHaveProperty("data");
    expect(JSON.stringify(payload)).not.toContain(POST_CONFIRM_NEXT_METADATA_KEY);
  });
});

describe("customer confirmations keep their explicit destination", () => {
  function pending(type: string, next: string) {
    h.jar.set("sb-pending-email-confirmation", JSON.stringify({ tokenHash: "hash-for-tests", type, next }));
  }
  function install(userMetadata: Record<string, unknown>) {
    const verifyOtp = vi.fn(async () => ({ data: { user: { user_metadata: userMetadata }, session: {} }, error: null }));
    h.client = { auth: { verifyOtp } };
    return verifyOtp;
  }
  const hinted = { full_name: "Kişi", [POST_CONFIRM_NEXT_METADATA_KEY]: "/accept-invite" };

  it("a magic-link confirmation lands on the customer's own explicit next (claim completion)", async () => {
    const claimRoute = "/account/claim/complete/0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";
    pending("magiclink", claimRoute);
    const verifyOtp = install({});

    const outcome = await run(() => confirmEmailAction());

    expect(outcome).toEqual({ kind: "redirected", url: claimRoute });
    expect(verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "hash-for-tests" });
  });

  it("a NEW customer's signup confirmation whose link carries next still lands there, hint or not", async () => {
    pending("signup", "/account");
    install({});
    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/account" });

    h.jar.clear();
    pending("signup", "/account");
    install(hinted);
    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/account" });
  });

  it("a stored next that would re-normalize to an off-site path is discarded, never followed (open-redirect guard)", async () => {
    // The pending-confirmation cookie is client-influenced state and is re-validated when it is read. This is
    // what the 747ea33 GET route stored for a crafted link (its resolveSafeNext returned protocol-relative paths
    // and was not idempotent): normalizing it once more would produce the off-site "//evil.example".
    const stored = `//${new URL(SITE).host}//evil.example`;

    for (const type of ["magiclink", "signup", "recovery"]) {
      h.jar.clear();
      pending(type, stored);
      install({});
      expect(await run(() => confirmEmailAction()), type).toEqual({ kind: "redirected", url: "/" });
    }

    // An invited sign-up whose link carries such a next still returns to the invitation, never off-site.
    h.jar.clear();
    pending("signup", stored);
    install(hinted);
    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/accept-invite" });
  });

  it("a magic-link confirmation NEVER inherits the invitation hint, even for an account that carries one", async () => {
    pending("magiclink", "/");
    install(hinted);

    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/" });
  });

  it("recovery, email-change and invite confirmations never inherit it either", async () => {
    for (const type of ["recovery", "email_change", "invite", "email"]) {
      h.jar.clear();
      pending(type, "/");
      install(hinted);
      expect(await run(() => confirmEmailAction()), type).toEqual({ kind: "redirected", url: "/" });
    }
  });

  it("a NEW customer's signup confirmation with no next and no hint is unchanged: /", async () => {
    pending("signup", "/");
    install({});

    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/" });
  });

  it("a failed verification still redirects back to /confirm-email and consumes the pending cookie", async () => {
    pending("signup", "/");
    h.client = { auth: { verifyOtp: vi.fn(async () => ({ data: { user: null, session: null }, error: { code: "otp_expired", status: 403 } })) } };
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/confirm-email" });
    expect(h.jar.has("sb-pending-email-confirmation")).toBe(false);
  });

  it("no pending confirmation at all still goes to /confirm-email without ever calling verifyOtp", async () => {
    const verifyOtp = install(hinted);

    expect(await run(() => confirmEmailAction())).toEqual({ kind: "redirected", url: "/confirm-email" });
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The hint exists only in the invitation code path.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const relative = `${dir}/${entry}`;
    if (statSync(path.join(ROOT, relative)).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      sourceFiles(relative, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(relative);
    }
  }
  return out;
}

describe("the post-confirm hint is confined to the invitation code path", () => {
  const files = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")];

  it("only the hint module and the two staff-auth actions that use it reference the key or its helpers", () => {
    const users = files.filter((file) => /post_confirm_next|post-confirm-destination|POST_CONFIRM_NEXT_METADATA_KEY/.test(readFileSync(path.join(ROOT, file), "utf8")));
    expect(users.sort()).toEqual(["lib/auth/post-confirm-destination.ts", "lib/modules/auth/actions.ts"].sort());
  });

  it("the customer-facing actions do not mention it, and their signInWithOtp options never carry user_metadata", () => {
    for (const file of ["lib/modules/customer-account/actions.ts", "lib/modules/public-booking/actions.ts"]) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source, file).not.toMatch(/post_confirm_next|post-confirm-destination|POST_CONFIRM_NEXT_METADATA_KEY/);

      const otpCalls = source.match(/signInWithOtp\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
      expect(otpCalls.length, file).toBeGreaterThan(0);
      for (const call of otpCalls) {
        expect(call, file).toContain("shouldCreateUser: true");
        expect(call, file).toContain("emailRedirectTo:");
        expect(call, file).not.toMatch(/\bdata\s*:/);
      }
    }
  });
});
