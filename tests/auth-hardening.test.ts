import { describe, expect, it } from "vitest";
import { isStaleSessionError } from "@/lib/auth/session-errors";
import {
  admin,
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createTestTenant,
  createTestUser,
  signInAs,
} from "./helpers";

/**
 * Regression suite for the auth-hardening pass that replaced the PKCE
 * email-confirmation flow with token_hash/verifyOtp() (see
 * app/auth/confirm/route.ts) and made proxy.ts/getCurrentUser() fail
 * closed on a stale refresh-token cookie instead of throwing (see
 * lib/auth/session-errors.ts). Every assertion either exercises the
 * actual Supabase Auth API a real user's browser would hit, or a real
 * signed-in session's client — never routes around what real traffic
 * experiences.
 */

describe("token_hash email confirmation", () => {
  it("verifyOtp succeeds with a valid token_hash and establishes a session", async () => {
    const email = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-token-hash@example.com`;
    const password = "Test1234!Test1234!";

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password,
    });
    expect(linkError).toBeNull();
    const tokenHash = linkData?.properties?.hashed_token;
    expect(tokenHash).toBeTruthy();

    // The exact call app/auth/confirm/route.ts makes — no code_verifier
    // cookie involved at all, unlike exchangeCodeForSession().
    const client = anonClient();
    const { data: verifyData, error: verifyError } = await client.auth.verifyOtp({
      type: "signup",
      token_hash: tokenHash!,
    });
    expect(verifyError).toBeNull();
    expect(verifyData.session).toBeTruthy();
    expect(verifyData.user?.email).toBe(email);

    await admin.auth.admin.deleteUser(linkData!.user!.id);
  });

  it("verifyOtp rejects an invalid token_hash", async () => {
    const client = anonClient();
    const { data, error } = await client.auth.verifyOtp({
      type: "signup",
      token_hash: "not-a-real-token-hash-00000000",
    });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it("possessing a token_hash without calling verifyOtp does not confirm the user (prefetch-safe GET)", async () => {
    // The actual property app/auth/confirm/route.ts's GET relies on:
    // generating/holding a token_hash is inert on its own. This is what
    // makes storing it in a cookie and redirecting — without ever
    // calling verifyOtp() — safe against an email scanner's automated
    // GET (observed in practice: Google Workspace Safe Browsing
    // prefetching links in incoming mail, which previously consumed the
    // single-use token before the real user's click).
    const email = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-prefetch-safe@example.com`;
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password: "Test1234!Test1234!",
    });
    expect(linkError).toBeNull();

    const { data: userAfter } = await admin.auth.admin.getUserById(linkData!.user!.id);
    expect(userAfter.user?.email_confirmed_at).toBeFalsy();

    await admin.auth.admin.deleteUser(linkData!.user!.id);
  });

  it("a token_hash already consumed by verifyOtp is rejected on a second attempt", async () => {
    const email = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-single-use@example.com`;
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password: "Test1234!Test1234!",
    });
    expect(linkError).toBeNull();
    const tokenHash = linkData!.properties!.hashed_token;

    const first = anonClient();
    const { error: firstError } = await first.auth.verifyOtp({ type: "signup", token_hash: tokenHash });
    expect(firstError).toBeNull();

    // Exactly what happens if the real emailed link is opened a second
    // time (scanner + human, or a double-click) — confirmEmailAction's
    // single verifyOtp() call must be the only one that can ever succeed.
    const second = anonClient();
    const { error: secondError } = await second.auth.verifyOtp({ type: "signup", token_hash: tokenHash });
    expect(secondError).not.toBeNull();

    await admin.auth.admin.deleteUser(linkData!.user!.id);
  });
});

describe("isStaleSessionError classification", () => {
  it("recognizes the known stale-session codes", () => {
    expect(isStaleSessionError({ code: "refresh_token_not_found" })).toBe(true);
    expect(isStaleSessionError({ code: "refresh_token_already_used" })).toBe(true);
    expect(isStaleSessionError({ code: "session_not_found" })).toBe(true);
    expect(isStaleSessionError({ code: "session_expired" })).toBe(true);
  });

  it("does not classify unrelated auth errors or non-error values as stale-session", () => {
    expect(isStaleSessionError({ code: "weak_password" })).toBe(false);
    expect(isStaleSessionError({ code: "email_address_invalid" })).toBe(false);
    expect(isStaleSessionError(new Error("plain error, no code"))).toBe(false);
    expect(isStaleSessionError(null)).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
    expect(isStaleSessionError("a string, not an error object")).toBe(false);
  });
});

describe("stale refresh token → safe signed-out behavior", () => {
  it("a revoked refresh token is rejected with a code isStaleSessionError recognizes", async () => {
    const user = await createTestUser("stale-refresh");
    const client = await signInAs(user);

    const { data: before } = await client.auth.getSession();
    const staleRefreshToken = before.session?.refresh_token;
    expect(staleRefreshToken).toBeTruthy();

    // Normal (non-admin) sign-out revokes the session server-side —
    // mirrors what actually happens to a real cookie that later shows up
    // stale (session revoked elsewhere), without the FK complication of
    // deleting a user who still has live rows referencing them.
    await client.auth.signOut();

    const fresh = anonClient();
    const { error } = await fresh.auth.refreshSession({
      refresh_token: staleRefreshToken!,
    });
    expect(error).not.toBeNull();
    expect(isStaleSessionError(error)).toBe(true);

    await cleanupUsers([user.id]);
  });
});

describe("protected tenant route grants no privilege on a stale token", () => {
  it("once a revoked refresh token fails to renew, that client has no privileged access", async () => {
    // Note on scope: an already-issued access token (JWT) stays valid
    // until its own natural expiry regardless of server-side session
    // revocation — verified directly while designing this test (a
    // revoked session's still-unexpired access token kept working
    // against PostgREST). That's standard JWT behavior, not something
    // this app's code controls, so it's not what this test asserts.
    // What proxy.ts/getCurrentUser() actually do — and what a real
    // stale cookie actually triggers — is an attempt to REFRESH an
    // access token that's already expired. This mirrors that: once the
    // refresh itself is rejected (proven above), the resulting
    // session-less client must get zero privileged access, exactly like
    // an anonymous one, even though the tenant/membership rows a valid
    // session would unlock still exist untouched.
    const owner = await createTestUser("stale-privilege");
    const tenant = await createTestTenant("test-tenant-stale-token", owner.id);
    const client = await signInAs(owner);

    const { data: baseline } = await client.from("tenants").select("id").eq("id", tenant.id);
    expect(baseline).toHaveLength(1);

    const { data: sessionBefore } = await client.auth.getSession();
    const staleRefreshToken = sessionBefore.session?.refresh_token;
    expect(staleRefreshToken).toBeTruthy();

    await client.auth.signOut();

    const fresh = anonClient();
    const { error: refreshError } = await fresh.auth.refreshSession({
      refresh_token: staleRefreshToken!,
    });
    expect(refreshError).not.toBeNull();

    // No session was established, so this client is functionally
    // anonymous — anon has zero table grants (Faz 1.5), so the query
    // fails at the permission-check stage, same as an anonymous client.
    const { data: afterFailedRefresh, error: queryError } = await fresh
      .from("tenants")
      .select("id")
      .eq("id", tenant.id);
    expect(queryError).not.toBeNull();
    expect(afterFailedRefresh).toBeNull();

    await cleanupTenants([tenant.id]);
    await cleanupUsers([owner.id]);
  });
});
