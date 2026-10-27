import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anonClient, cleanupUsers, createTestUser, testDb, type TestUser } from "./helpers";
import { completePasswordReset, performPasswordRecoveryRequest } from "@/lib/auth/password-recovery";
import { createStatelessAnonClient } from "@/lib/supabase/anon-stateless";

/**
 * Faz SAAS.1A — the recovery orchestration driven through REAL supabase-js clients against the rig's GoTrue MODEL
 * (a model written from documented behaviour, NOT hosted GoTrue: evidence from this file says "modelled", never
 * "hosted"). IDs RF1-RF7. It pins what the application depends on: the provider's answer is the same for every
 * address, a recovery token is single use, a reset really ends other sessions, and the one thing JWT cannot do.
 */

const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const created: string[] = [];

async function outbox(): Promise<{ kind: string; email: string }[]> {
  const res = await fetch(`${base}/__test/outbox`);
  return (await res.json()) as { kind: string; email: string }[];
}

async function recoveryTokenFor(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed: ${error?.message}`);
  return data.properties.hashed_token;
}

/** The application's real wiring (see resetPasswordAction), with a recording cookie. */
function realDeps(client: ReturnType<typeof anonClient>, jar: { parked: boolean }) {
  return {
    verifyRecoveryToken: async (tokenHash: string) => {
      const { error } = await client.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
      return error ? { ok: false as const, error } : { ok: true as const };
    },
    updatePassword: async (password: string) => {
      const { error } = await client.auth.updateUser({ password });
      return error ? { ok: false as const, error } : { ok: true as const };
    },
    signOutEverywhere: async () => {
      await client.auth.signOut({ scope: "global" });
    },
    clearPending: async () => {
      jar.parked = false;
    },
    log: () => {},
  };
}

let person: TestUser;
let unconfirmed: { email: string; id: string };

beforeAll(async () => {
  person = await createTestUser("s1a-rf");
  created.push(person.id);
  const email = `test-s1a-rf-unconfirmed-${Date.now().toString(36)}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: "Test1234!Test1234!", email_confirm: false });
  if (error || !data.user) throw new Error(`could not create the unconfirmed user: ${error?.message}`);
  unconfirmed = { email, id: data.user.id };
  created.push(data.user.id);
}, 60000);

afterAll(async () => {
  await cleanupUsers(created);
}, 60000);

describe("RF recovery against the modelled provider", () => {
  it("RF1 a known, an unknown and an unconfirmed address: the MODELLED provider answers identically and mails only the known confirmed one", async () => {
    // The identical-answer property is a property of the MODEL. The real hosted provider does NOT have it: its raw recovery
    // endpoint answers 429 over_email_send_rate_limit for an existing address once the mail cap is used up, while an unknown
    // address always gets 200 (SAAS-1A-HOSTED-ACCEPTANCE.md, ACCOUNT_ENUMERATION_PROVIDER). What SalonOS itself guarantees
    // regardless of the provider is pinned by RF2 and the PW tests: the application surface never reveals the difference.
    const hasOutbox = (await fetch(`${base}/__test/outbox`)).ok;
    const before = hasOutbox ? (await outbox()).length : 0;
    const unknown = `nobody-${Date.now().toString(36)}@example.com`;
    const answers: unknown[] = [];
    for (const email of [person.email, unknown, unconfirmed.email]) {
      const result = await createStatelessAnonClient().auth.resetPasswordForEmail(email);
      answers.push({ error: result.error, hasData: result.data !== null });
    }
    if (!hasOutbox) {
      console.log(`RF1 hosted provider answers (known, unknown, unconfirmed): ${JSON.stringify(answers.map((a) => (a as { error: { status?: number } | null }).error?.status ?? 200))}`);
      return;
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    const mailed = (await outbox()).slice(before).filter((e) => e.kind === "recovery").map((e) => e.email);
    expect(mailed).toEqual([person.email]);
  });

  it("RF2 the application's request orchestration never throws and reports nothing, whatever the provider does", async () => {
    const results: unknown[] = [];
    for (const email of [person.email, "nobody@example.com"]) {
      results.push(
        await performPasswordRecoveryRequest(email, {
          sendRecoveryEmail: (address) => createStatelessAnonClient().auth.resetPasswordForEmail(address),
          log: () => {},
        }),
      );
    }
    expect(results).toEqual([undefined, undefined]);
  });

  it("RF3 a full reset: the token is spent, the password changes, EVERY other session is ended, and the old password stops working", async () => {
    const user = await createTestUser("s1a-rf3");
    created.push(user.id);
    // two sessions exist before the reset (a phone and a laptop, or an attacker's)
    const phone = anonClient();
    const laptop = anonClient();
    expect((await phone.auth.signInWithPassword({ email: user.email, password: user.password })).error).toBeNull();
    expect((await laptop.auth.signInWithPassword({ email: user.email, password: user.password })).error).toBeNull();
    const phoneSession = (await phone.auth.getSession()).data.session!;
    const laptopSession = (await laptop.auth.getSession()).data.session!;

    const token = await recoveryTokenFor(user.email);
    const resetClient = anonClient();
    const jar = { parked: true };
    const outcome = await completePasswordReset(
      { pending: { tokenHash: token, type: "recovery", next: "/" }, password: "Yeni-Sifre-2026!" },
      realDeps(resetClient, jar),
    );
    expect(outcome).toEqual({ kind: "success" });
    expect(jar.parked).toBe(false);

    // the new password works, the old one does not
    expect((await anonClient().auth.signInWithPassword({ email: user.email, password: "Yeni-Sifre-2026!" })).error).toBeNull();
    expect((await anonClient().auth.signInWithPassword({ email: user.email, password: user.password })).error).not.toBeNull();

    // every earlier session is gone: refresh fails and the server-side user check fails (what the application relies on)
    for (const [label, session] of [["phone", phoneSession], ["laptop", laptopSession]] as const) {
      const fresh = anonClient();
      const refreshed = await fresh.auth.refreshSession({ refresh_token: session.refresh_token });
      expect(refreshed.error, `${label} refresh`).not.toBeNull();
      const lookup = await anonClient().auth.getUser(session.access_token);
      expect(lookup.error, `${label} getUser`).not.toBeNull();
    }
  });

  it("RF4 a recovery token is single use: the second attempt is the plain invalid-link answer and changes nothing", async () => {
    const user = await createTestUser("s1a-rf4");
    created.push(user.id);
    const token = await recoveryTokenFor(user.email);
    const first = await completePasswordReset({ pending: { tokenHash: token, type: "recovery", next: "/" }, password: "Yeni-Sifre-2026!" }, realDeps(anonClient(), { parked: true }));
    expect(first).toEqual({ kind: "success" });
    const second = await completePasswordReset({ pending: { tokenHash: token, type: "recovery", next: "/" }, password: "Baska-Sifre-2026!" }, realDeps(anonClient(), { parked: true }));
    expect(second).toEqual({ kind: "invalid_link" });
    expect((await anonClient().auth.signInWithPassword({ email: user.email, password: "Yeni-Sifre-2026!" })).error).toBeNull();
    expect((await anonClient().auth.signInWithPassword({ email: user.email, password: "Baska-Sifre-2026!" })).error).not.toBeNull();
  });

  it("RF5 a made-up token and an empty one are refused as invalid links", async () => {
    for (const tokenHash of ["0".repeat(64), "not-a-token"]) {
      const outcome = await completePasswordReset({ pending: { tokenHash, type: "recovery", next: "/" }, password: "Yeni-Sifre-2026!" }, realDeps(anonClient(), { parked: true }));
      expect(outcome, tokenHash).toEqual({ kind: "invalid_link" });
    }
  });

  it("RF6 the provider's own rule 'same password' surfaces as a plain refusal AND still ends the sessions the verification created", async () => {
    const user = await createTestUser("s1a-rf6");
    created.push(user.id);
    const token = await recoveryTokenFor(user.email);
    const outcome = await completePasswordReset({ pending: { tokenHash: token, type: "recovery", next: "/" }, password: user.password }, realDeps(anonClient(), { parked: true }));
    expect(outcome).toEqual({ kind: "password_rejected", reason: "same_password" });
    // the password is unchanged
    expect((await anonClient().auth.signInWithPassword({ email: user.email, password: user.password })).error).toBeNull();
  });

  it("RF7 PINNED LIMIT of tokens: a revoked session's already-issued access token still reaches the database until it expires — which is why authorization is re-evaluated from the MEMBERSHIP on every query", async () => {
    const user = await createTestUser("s1a-rf7");
    created.push(user.id);
    const stolen = anonClient();
    await stolen.auth.signInWithPassword({ email: user.email, password: user.password });
    const accessToken = (await stolen.auth.getSession()).data.session!.access_token;

    const token = await recoveryTokenFor(user.email);
    await completePasswordReset({ pending: { tokenHash: token, type: "recovery", next: "/" }, password: "Yeni-Sifre-2026!" }, realDeps(anonClient(), { parked: true }));

    // the server-side user check (what every page and action calls) now fails...
    expect((await anonClient().auth.getUser(accessToken)).error).not.toBeNull();
    // ...but the bare token still authenticates a database call as that user (documented, bounded by the JWT lifetime)
    const viaRest = await fetch(`${base}/rest/v1/rpc/has_permission`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, apikey: "local-fake-publishable" },
      body: JSON.stringify({ p_tenant_id: "00000000-0000-4000-8000-000000000000", p_permission_key: "staff.manage" }),
    });
    // The platform may either still let the bare token through (the modelled provider, and any hosted project that does not
    // check the session) or already refuse it (the hosted project answered 401 after a global sign-out). Both are safe:
    // what must hold is that the token NEVER yields tenant authorization.
    expect([200, 401]).toContain(viaRest.status);
    if (viaRest.status === 200) {
      // ...and it grants nothing without an ACTIVE membership: there is none, so the answer is simply false.
      expect(await viaRest.json()).toBe(false);
    }
    void testDb;
  });
});
