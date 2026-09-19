import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  TERMINAL_ACCEPT_FAILURE_REASONS,
  acceptInvitationFailure,
  acceptTeamInvitationCore,
  mapAcceptInvitationError,
  type AcceptInvitationFailureReason,
  type AcceptInvitationResult,
} from "@/lib/modules/team/accept-invitation";
import {
  addMembership,
  admin,
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  randomTokenHex,
  sha256Hex,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1D.2 — the acceptance step itself, against the real DEV
 * database with REAL signed-in clients (never admin/testDb for the
 * security-boundary calls; testDb is only ever used to read ground truth
 * or to build fixtures). Invitations are created through the
 * create_team_invitation RPC directly, so no email is ever sent from this
 * file.
 *
 * accept_team_invitation stays the sole authorization authority. These
 * tests prove the orchestration around it maps its real outcomes and
 * errors correctly, never widens what it allows, and never hands the
 * browser anything sensitive.
 */

let owner: TestUser;
let ownerClient: SupabaseClient<Database>;
let tenant: TestTenant;
let roleId: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

beforeAll(async () => {
  owner = await createTestUser("aif-owner");
  createdUserIds.push(owner.id);
  tenant = await createTestTenant(`test-tenant-aif-${Date.now().toString(36)}`, owner.id);
  createdTenantIds.push(tenant.id);
  roleId = await createRoleForTenant(tenant.id, "Davet Rolü", ["appointments.view", "staff.manage"]);
  ownerClient = await signInAs(owner);
}, 60000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 90000);

async function newUser(label: string): Promise<{ user: TestUser; client: SupabaseClient<Database> }> {
  const user = await createTestUser(label);
  createdUserIds.push(user.id);
  return { user, client: await signInAs(user) };
}

async function invite(
  email: string,
  opts: { staffMemberId?: string | null; tenantId?: string; roleId?: string } = {},
): Promise<{ id: string; token: string; email: string }> {
  const { data, error } = await ownerClient.rpc("create_team_invitation", {
    p_tenant_id: opts.tenantId ?? tenant.id,
    p_email: email,
    p_role_id: opts.roleId ?? roleId,
    p_staff_member_id: opts.staffMemberId ?? undefined,
  });
  if (error || !data) throw new Error(`invitation setup failed: ${error?.message}`);
  return (data as { id: string; token: string; email: string }[])[0]!;
}

async function newStaff(name: string): Promise<string> {
  const [staff] = await testDb<{ id: string }[]>`
    insert into staff_members (tenant_id, full_name) values (${tenant.id}, ${name}) returning id
  `;
  return staff!.id;
}

async function membershipsFor(userId: string, tenantId = tenant.id) {
  return testDb<{ id: string; role_id: string; status: string }[]>`
    select id, role_id, status from tenant_memberships where tenant_id = ${tenantId} and user_id = ${userId}
  `;
}

async function invitationRow(id: string) {
  const [row] = await testDb<{ status: string; accepted_by: string | null; accepted_at: Date | null }[]>`
    select status, accepted_by, accepted_at from team_invitations where id = ${id}
  `;
  return row!;
}

/** Nothing the browser is ever handed may contain a secret or an internal id. */
function expectNoSensitive(result: AcceptInvitationResult, sensitive: string[]) {
  const json = JSON.stringify(result);
  for (const value of sensitive) {
    expect(json.includes(value), `result leaked a sensitive value starting ${value.slice(0, 6)}…`).toBe(false);
  }
  expect(json).not.toMatch(/token_hash|tokenHash|membership_id|membershipId|role_id|roleId|tenant_id|tenantId/);
}

describe("existing SalonOS user accepts an invitation", () => {
  it("creates exactly one active membership with the invitation's role and lands in the accepted salon", async () => {
    const { user, client } = await newUser("aif-exist");
    const staffId = await newStaff("Ayşe Yılmaz");
    const invitation = await invite(user.email, { staffMemberId: staffId });

    const result = await acceptTeamInvitationCore(client, invitation.token);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.outcome).toBe("accepted");
    expect(result.data.destination).toBe(`/app/${tenant.slug}`);
    expect(result.data.staffLinked).toBe(true);
    expect(Object.keys(result.data).sort()).toEqual(["destination", "outcome", "staffLinked"]);

    const memberships = await membershipsFor(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role_id).toBe(roleId);
    expect(memberships[0]!.status).toBe("active");

    const row = await invitationRow(invitation.id);
    expect(row.status).toBe("accepted");
    expect(row.accepted_by).toBe(user.id);
    expect(row.accepted_at).not.toBeNull();

    const [linked] = await testDb<{ tenant_membership_id: string | null }[]>`
      select tenant_membership_id from staff_members where id = ${staffId}
    `;
    expect(linked!.tenant_membership_id).toBe(memberships[0]!.id);

    expectNoSensitive(result, [
      invitation.token,
      sha256Hex(invitation.token),
      tenant.id,
      roleId,
      memberships[0]!.id,
      user.email,
    ]);
  });

  it("without a staff link still succeeds, reporting staffLinked=false", async () => {
    const { user, client } = await newUser("aif-nostaff");
    const invitation = await invite(user.email);

    const result = await acceptTeamInvitationCore(client, invitation.token);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outcome).toBe("accepted");
      expect(result.data.staffLinked).toBe(false);
    }
  });

  it("accepts across differing address case/whitespace: the comparison is on normalized (lower/trim) emails", async () => {
    const { user, client } = await newUser("aif-case");
    // Invite with shouting-case + padding; the account itself is the plain lowercase address.
    const invitation = await invite(`  ${user.email.toUpperCase()}  `);

    const result = await acceptTeamInvitationCore(client, invitation.token);
    expect(result.success).toBe(true);
  });
});

describe("brand-new user: invitation created before the account exists", () => {
  it("the account created + confirmed afterwards can accept — the invitation is matched by normalized email, not by user id", async () => {
    const email = `test-aif-newuser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;

    // 1. The salon invites an address that has NO SalonOS account yet.
    const existing = await testDb<{ id: string }[]>`select id from auth.users where email = ${email}`;
    expect(existing).toHaveLength(0);
    const invitation = await invite(email);

    // 2. The person signs up and confirms their email. (admin.createUser with
    // email_confirm is the same end state as signup + confirmation-link click,
    // without sending any mail; the real signup/confirm plumbing is covered by
    // auth-hardening.test.ts and the accept-invite-actions tests.)
    const password = "Test1234!Test1234!";
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(error).toBeNull();
    createdUserIds.push(created.user!.id);
    const client = await signInAs({ id: created.user!.id, email, password });

    // 3. They return to /accept-invite and press the button.
    const result = await acceptTeamInvitationCore(client, invitation.token);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.outcome).toBe("accepted");
    const memberships = await membershipsFor(created.user!.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.status).toBe("active");
  });
});

describe("wrong signed-in user (email mismatch)", () => {
  it("is refused without revealing the invited address, creates nothing, and does not burn the token", async () => {
    const invited = await newUser("aif-invited");
    const wrong = await newUser("aif-wrong");
    const invitation = await invite(invited.user.email);

    const attempt = await acceptTeamInvitationCore(wrong.client, invitation.token);

    expect(attempt.success).toBe(false);
    if (attempt.success) return;
    expect(attempt.error.reason).toBe("email_mismatch");
    expect(attempt.error.code).toBe("UNAUTHORIZED");
    // Never says WHICH address the invitation is for.
    const invitedLocal = invited.user.email.split("@")[0]!;
    expect(attempt.error.message).not.toContain(invited.user.email);
    expect(attempt.error.message).not.toContain(invitedLocal);
    expect(attempt.error.message).not.toContain("@");
    expectNoSensitive(attempt, [invitation.token, sha256Hex(invitation.token), tenant.id, roleId, invited.user.email]);

    // Nothing was created for the wrong user, and the invitation is untouched.
    expect(await membershipsFor(wrong.user.id)).toHaveLength(0);
    const row = await invitationRow(invitation.id);
    expect(row.status).toBe("pending");
    expect(row.accepted_by).toBeNull();

    // The right user — the one who signs in after the switch-account button —
    // can still use the very same token.
    const retry = await acceptTeamInvitationCore(invited.client, invitation.token);
    expect(retry.success).toBe(true);
    expect(await membershipsFor(invited.user.id)).toHaveLength(1);
  });

  it("plus-addressing is a different address: only an exact normalized match is accepted", async () => {
    const { user, client } = await newUser("aif-plus");
    const [local, domain] = user.email.split("@");
    const plusAddress = `${local}+extra@${domain}`;
    const invitation = await invite(plusAddress);

    const attempt = await acceptTeamInvitationCore(client, invitation.token);

    expect(attempt.success).toBe(false);
    if (!attempt.success) expect(attempt.error.reason).toBe("email_mismatch");
    expect(await membershipsFor(user.id)).toHaveLength(0);
  });

  it("possessing the token is not sufficient, even for a user who is a member of the same salon already", async () => {
    // owner is an active member (owner) of `tenant`; the invitation is for someone else.
    const invited = await newUser("aif-notowner");
    const invitation = await invite(invited.user.email);

    const attempt = await acceptTeamInvitationCore(ownerClient, invitation.token);

    expect(attempt.success).toBe(false);
    if (!attempt.success) expect(attempt.error.reason).toBe("email_mismatch");
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });
});

describe("unauthenticated caller", () => {
  it("can never succeed — the database refuses a session-less accept", async () => {
    const invited = await newUser("aif-unauth");
    const invitation = await invite(invited.user.email);

    const attempt = await acceptTeamInvitationCore(anonClient(), invitation.token);

    expect(attempt.success).toBe(false);
    if (!attempt.success) {
      // Either the RPC's own "authentication required" or a grant-level
      // refusal for the anon role — both are safe failures. (The Server
      // Action never even reaches this call without a user.)
      expect(["unauthenticated", "unexpected"]).toContain(attempt.error.reason);
    }
    const row = await invitationRow(invitation.id);
    expect(row.status).toBe("pending");
    expect(row.accepted_by).toBeNull();
    expect(await membershipsFor(invited.user.id)).toHaveLength(0);
  });
});

describe("expired, revoked, unknown and malformed tokens", () => {
  it("an expired invitation is refused with the expiry message and creates no membership", async () => {
    const { user, client } = await newUser("aif-expired");
    const rawToken = randomTokenHex();
    await testDb`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenant.id}, ${user.email}, ${roleId}, ${owner.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
    `;

    const attempt = await acceptTeamInvitationCore(client, rawToken);

    expect(attempt.success).toBe(false);
    if (attempt.success) return;
    expect(attempt.error.reason).toBe("expired");
    expect(attempt.error.message).toBe("Bu davetin süresi dolmuş.");
    expect(TERMINAL_ACCEPT_FAILURE_REASONS.has(attempt.error.reason)).toBe(true);
    expect(await membershipsFor(user.id)).toHaveLength(0);
  });

  it("a revoked invitation is refused with the revocation message and creates no membership", async () => {
    const { user, client } = await newUser("aif-revoked");
    const invitation = await invite(user.email);
    const { error } = await ownerClient.rpc("revoke_team_invitation", { p_invitation_id: invitation.id });
    expect(error).toBeNull();

    const attempt = await acceptTeamInvitationCore(client, invitation.token);

    expect(attempt.success).toBe(false);
    if (attempt.success) return;
    expect(attempt.error.reason).toBe("revoked");
    expect(attempt.error.message).toBe("Bu davet iptal edilmiş.");
    expect(TERMINAL_ACCEPT_FAILURE_REASONS.has(attempt.error.reason)).toBe(true);
    expect(await membershipsFor(user.id)).toHaveLength(0);
  });

  it("a well-formed token that matches no invitation is not_found", async () => {
    const { client } = await newUser("aif-unknown");

    const attempt = await acceptTeamInvitationCore(client, randomTokenHex());

    expect(attempt.success).toBe(false);
    if (!attempt.success) expect(attempt.error.reason).toBe("not_found");
  });

  it("a malformed token is rejected as not_found WITHOUT calling the database at all", async () => {
    const rpc = vi.fn();
    const client = { rpc, from: vi.fn() } as unknown as SupabaseClient<Database>;

    for (const bad of ["", "abc", "A".repeat(64), "z".repeat(64), `${"a".repeat(64)}x`, "<script>"]) {
      const attempt = await acceptTeamInvitationCore(client, bad);
      expect(attempt.success).toBe(false);
      if (!attempt.success) expect(attempt.error.reason).toBe("not_found");
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("replay and pre-existing membership", () => {
  it("the same user replaying an accepted invitation is idempotent success (already_accepted), with no second membership", async () => {
    const { user, client } = await newUser("aif-replay");
    const invitation = await invite(user.email);

    const first = await acceptTeamInvitationCore(client, invitation.token);
    const replay = await acceptTeamInvitationCore(client, invitation.token);

    expect(first.success).toBe(true);
    expect(replay.success).toBe(true);
    if (first.success && replay.success) {
      expect(first.data.outcome).toBe("accepted");
      expect(replay.data.outcome).toBe("already_accepted");
      expect(replay.data.destination).toBe(first.data.destination);
    }
    expect(await membershipsFor(user.id)).toHaveLength(1);
  });

  it("a different user replaying an accepted invitation gets the generic 'not valid' message — it doesn't disclose that someone used it", async () => {
    const accepter = await newUser("aif-accepter");
    const other = await newUser("aif-other");
    const invitation = await invite(accepter.user.email);
    expect((await acceptTeamInvitationCore(accepter.client, invitation.token)).success).toBe(true);

    const attempt = await acceptTeamInvitationCore(other.client, invitation.token);

    expect(attempt.success).toBe(false);
    if (attempt.success) return;
    expect(attempt.error.reason).toBe("already_accepted_by_other");
    const notFound = acceptInvitationFailure("not_found");
    if (notFound.success) throw new Error("unreachable: a failure was requested");
    expect(attempt.error.message).toBe(notFound.error.message);
    expect(TERMINAL_ACCEPT_FAILURE_REASONS.has(attempt.error.reason)).toBe(true);
    expect(await membershipsFor(other.user.id)).toHaveLength(0);
  });

  it("a member who already joined another way is accepted as already_member — no duplicate membership row", async () => {
    const { user, client } = await newUser("aif-already-member");
    const invitation = await invite(user.email);
    const existingMembershipId = await addMembership(tenant.id, user.id, roleId);

    const result = await acceptTeamInvitationCore(client, invitation.token);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.outcome).toBe("already_member");
    const memberships = await membershipsFor(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.id).toBe(existingMembershipId);
  });

  it("a suspended member is refused and NOT silently reactivated; the invitation stays pending", async () => {
    const { user, client } = await newUser("aif-suspended");
    const invitation = await invite(user.email);
    const membershipId = await addMembership(tenant.id, user.id, roleId);
    await testDb`update tenant_memberships set status = 'suspended' where id = ${membershipId}`;

    const attempt = await acceptTeamInvitationCore(client, invitation.token);

    expect(attempt.success).toBe(false);
    if (attempt.success) return;
    expect(attempt.error.reason).toBe("membership_suspended");
    // Not terminal: a suspended member may be reinstated by the salon, after
    // which the same parked token would work.
    expect(TERMINAL_ACCEPT_FAILURE_REASONS.has(attempt.error.reason)).toBe(false);
    const memberships = await membershipsFor(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.status).toBe("suspended");
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });
});

describe("mapAcceptInvitationError — the live RPC error strings", () => {
  it.each<[string, AcceptInvitationFailureReason]>([
    ["authentication required", "unauthenticated"],
    ["invitation_email_mismatch", "email_mismatch"],
    ["invitation_expired", "expired"],
    ["invitation_revoked", "revoked"],
    ["invitation_already_accepted", "already_accepted_by_other"],
    ["invitation_not_found", "not_found"],
    ["membership_suspended", "membership_suspended"],
  ])("%s → %s", (message, reason) => {
    const mapped = mapAcceptInvitationError({ message });
    expect(mapped.success).toBe(false);
    if (!mapped.success) expect(mapped.error.reason).toBe(reason);
  });

  it("anything unrecognized becomes 'unexpected' and never echoes the raw error text (which can embed addresses or SQL)", () => {
    const raw = 'duplicate key value violates unique constraint "x" — Key (email)=(someone@example.com) already exists';
    const mapped = mapAcceptInvitationError({ message: raw });

    expect(mapped.success).toBe(false);
    if (mapped.success) return;
    expect(mapped.error.reason).toBe("unexpected");
    expect(JSON.stringify(mapped)).not.toContain("someone@example.com");
    expect(JSON.stringify(mapped)).not.toContain("duplicate key");
  });

  it("only failures after which the parked token can never work are terminal", () => {
    expect([...TERMINAL_ACCEPT_FAILURE_REASONS].sort()).toEqual(
      ["already_accepted_by_other", "expired", "not_found", "revoked"].sort(),
    );
    for (const retryable of ["email_mismatch", "unauthenticated", "membership_suspended", "unexpected", "missing_token"] as const) {
      expect(TERMINAL_ACCEPT_FAILURE_REASONS.has(retryable)).toBe(false);
    }
  });

  it("every failure carries a Turkish, non-empty, address-free message and a stable shape", () => {
    const reasons: AcceptInvitationFailureReason[] = [
      "missing_token",
      "unauthenticated",
      "email_mismatch",
      "expired",
      "revoked",
      "not_found",
      "already_accepted_by_other",
      "membership_suspended",
      "unexpected",
    ];
    for (const reason of reasons) {
      const failure = acceptInvitationFailure(reason);
      expect(failure.success).toBe(false);
      if (failure.success) continue;
      expect(Object.keys(failure.error).sort()).toEqual(["code", "message", "reason"]);
      expect(failure.error.reason).toBe(reason);
      expect(failure.error.message.length).toBeGreaterThan(5);
      expect(failure.error.message).not.toContain("@");
    }
  });
});

describe("acceptTeamInvitationCore result handling (fake client)", () => {
  const token = "ab".repeat(32);

  function fake(opts: {
    rpc: { data: unknown; error: { message: string } | null };
    tenant?: { slug: string } | null;
  }) {
    const rpc = vi.fn(async () => opts.rpc);
    const maybeSingle = vi.fn(async () => ({ data: opts.tenant ?? null, error: null }));
    const client = {
      rpc,
      from: () => ({ select: () => ({ eq: () => ({ is: () => ({ maybeSingle }) }) }) }),
    } as unknown as SupabaseClient<Database>;
    return { client, rpc, maybeSingle };
  }

  const okRow = { membership_id: "m", tenant_id: "t", role_id: "r", outcome: "accepted", staff_linked: false, staff_link_reason: null };

  it("passes the token to accept_team_invitation as p_token and nothing else", async () => {
    const { client, rpc } = fake({ rpc: { data: [okRow], error: null }, tenant: { slug: "salon" } });
    await acceptTeamInvitationCore(client, token);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("accept_team_invitation", { p_token: token });
  });

  it("an unknown outcome from the RPC is 'unexpected', not silently treated as success", async () => {
    const { client } = fake({ rpc: { data: [{ ...okRow, outcome: "something_new" }], error: null } });
    const result = await acceptTeamInvitationCore(client, token);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.reason).toBe("unexpected");
  });

  it.each([[[]], [null]])("an empty RPC result (%j) is 'unexpected'", async (data) => {
    const { client } = fake({ rpc: { data, error: null } });
    const result = await acceptTeamInvitationCore(client, token);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.reason).toBe("unexpected");
  });

  it("falls back to / (never a made-up /app path) when the tenant slug can't be resolved", async () => {
    const { client } = fake({ rpc: { data: [okRow], error: null }, tenant: null });
    const result = await acceptTeamInvitationCore(client, token);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.destination).toBe("/");
  });

  it("URL-encodes the slug in the destination", async () => {
    const { client } = fake({ rpc: { data: [okRow], error: null }, tenant: { slug: "a b/c?d" } });
    const result = await acceptTeamInvitationCore(client, token);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.destination).toBe("/app/a%20b%2Fc%3Fd");
  });

  it("does not consult the tenants table when the RPC failed", async () => {
    const { client, maybeSingle } = fake({ rpc: { data: null, error: { message: "invitation_expired" } } });
    const result = await acceptTeamInvitationCore(client, token);
    expect(result.success).toBe(false);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("staffLinked is true only for a literal true", async () => {
    for (const [value, expected] of [[true, true], [false, false], [null, false], ["true", false], [1, false]] as const) {
      const { client } = fake({ rpc: { data: [{ ...okRow, staff_linked: value }], error: null }, tenant: { slug: "s" } });
      const result = await acceptTeamInvitationCore(client, token);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.staffLinked).toBe(expected);
    }
  });
});

describe("double submit (double-click on the accept button)", () => {
  it("two concurrent accepts by the same user both succeed — exactly one membership and exactly one 'accepted' audit event", async () => {
    const { user, client } = await newUser("aif-race");
    const invitation = await invite(user.email);

    // The invitation row is locked `for update` inside accept_team_invitation,
    // so the loser of the race waits, then replays as already_accepted.
    const [a, b] = await Promise.all([
      acceptTeamInvitationCore(client, invitation.token),
      acceptTeamInvitationCore(client, invitation.token),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    const outcomes = [a, b].map((r) => (r.success ? r.data.outcome : "failed")).sort();
    expect(outcomes).toEqual(["accepted", "already_accepted"]);

    expect(await membershipsFor(user.id)).toHaveLength(1);
    const [audit] = await testDb<{ n: number }[]>`
      select count(*)::int as n from audit_logs
      where action = 'team_invitation.accepted' and entity_id = ${invitation.id}
    `;
    expect(audit!.n).toBe(1);
  });
});
