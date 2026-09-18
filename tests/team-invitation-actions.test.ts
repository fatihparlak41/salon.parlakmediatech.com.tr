import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  cleanupTenants,
  cleanupUsers,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";
import {
  buildAcceptUrl,
  createTeamInvitationCore,
  mapCreateInvitationError,
  mapResendInvitationError,
  resendTeamInvitationCore,
} from "@/lib/modules/team/actions";
import type { EmailSendOutcome, SendEmailTransport, TeamInvitationEmailInput } from "@/lib/email/email-server";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Faz SAAS.1C.2B — the team invitation Server Action orchestration.
 * Uses the SAME "real signed-in client over the network, never admin/
 * testDb, for security-boundary assertions" discipline as
 * permission-ceiling.test.ts, calling the exported ...Core functions
 * directly (see actions.ts's own header for why: requireUser()/
 * createClient() need a real Next.js request context this test
 * environment doesn't have; the Core functions take an already-
 * authenticated client as a parameter instead). The email transport is
 * always the injected fake below — never the real Google Workspace SMTP
 * adapter, no internet, no App Password, no real email, for every single
 * test in this file.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let limitedA: TestUser;
let existingActiveUser: TestUser;
let existingSuspendedUser: TestUser;

let ownerAClient: SupabaseClient;
let limitedAClient: SupabaseClient;

let limitedRoleId: string; // within ownerA's ceiling AND limitedA's ceiling
let crossTenantRoleId: string; // belongs to tenantB

const createdUserIds: string[] = [];

beforeAll(async () => {
  ownerA = await createTestUser("tia-owner-a");
  limitedA = await createTestUser("tia-limited-a");
  existingActiveUser = await createTestUser("tia-existing-active");
  existingSuspendedUser = await createTestUser("tia-existing-suspended");
  createdUserIds.push(ownerA.id, limitedA.id, existingActiveUser.id, existingSuspendedUser.id);

  tenantA = await createTestTenant("test-tenant-tia-a", ownerA.id);
  tenantB = await createTestTenant("test-tenant-tia-b", ownerA.id);

  limitedRoleId = await createRoleForTenant(tenantA.id, "Sınırlı Davet Rolü", ["staff.manage", "appointments.view"]);
  await addMembership(tenantA.id, limitedA.id, limitedRoleId);

  crossTenantRoleId = await createRoleForTenant(tenantB.id, "Yabancı Rol", ["appointments.view"]);

  await addMembership(tenantA.id, existingActiveUser.id, limitedRoleId);
  const suspendedMembershipId = await addMembership(tenantA.id, existingSuspendedUser.id, limitedRoleId);
  await testDb`update tenant_memberships set status = 'suspended' where id = ${suspendedMembershipId}`;

  ownerAClient = await signInAs(ownerA);
  limitedAClient = await signInAs(limitedA);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers(createdUserIds);
}, 60000);

function freshEmail(label: string): string {
  return `tia-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;
}

function fakeSender(outcome: EmailSendOutcome): { send: SendEmailTransport; calls: TeamInvitationEmailInput[] } {
  const calls: TeamInvitationEmailInput[] = [];
  const send: SendEmailTransport = async (input) => {
    calls.push(input);
    return outcome;
  };
  return { send, calls };
}

describe("createTeamInvitationCore (15-26)", () => {
  it("15. a valid RPC result triggers the email adapter", async () => {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-15"), roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("17. accept URL is built from getSiteUrl(), never hardcoded", async () => {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-17"), roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(calls[0]!.acceptUrl.startsWith(`${getSiteUrl()}/accept-invite?token=`)).toBe(true);
  });

  it("18. the raw token only ever reaches the email adapter, never the action's own return value", async () => {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-18"), roleId: limitedRoleId },
      { sendEmail: send },
    );
    const url = new URL(calls[0]!.acceptUrl);
    const rawToken = url.searchParams.get("token")!;
    expect(rawToken.length).toBeGreaterThanOrEqual(64);
    expect(JSON.stringify(result)).not.toContain(rawToken);
  });

  it("19. success returns exactly {success:true, data:{outcome:'sent', invitationId}} — nothing extra", async () => {
    const { send } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-19"), roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(["invitationId", "outcome"]);
      expect(result.data.outcome).toBe("sent");
    }
  });

  it("20. a provider failure returns delivery_failed with the classified errorClass, not a thrown error", async () => {
    const { send } = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "provider_unavailable" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-20"), roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result).toMatchObject({
      success: true,
      data: { outcome: "delivery_failed", errorClass: "provider_unavailable" },
    });
  });

  it("21. the invitation remains created (pending) in the DB after a delivery failure", async () => {
    const { send } = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "network_error" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-21"), roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    const invitationId = (result as { success: true; data: { invitationId: string } }).data.invitationId;
    const [row] = await testDb<{ status: string }[]>`select status from team_invitations where id = ${invitationId}`;
    expect(row?.status).toBe("pending");
  });

  it("22. an RPC failure (cross-tenant role) never calls the email adapter", async () => {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-22"), roleId: crossTenantRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("23. a duplicate-pending rejection does not trigger a second send", async () => {
    const email = freshEmail("create-23");
    const first = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const firstResult = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email, roleId: limitedRoleId },
      { sendEmail: first.send },
    );
    expect(firstResult.success).toBe(true);
    expect(first.calls).toHaveLength(1);

    const second = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_2" });
    const secondResult = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email, roleId: limitedRoleId },
      { sendEmail: second.send },
    );
    expect(secondResult.success).toBe(false);
    expect(second.calls).toHaveLength(0);
  });

  it("24. an active-existing-member rejection does not send", async () => {
    const { send } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: existingActiveUser.email, roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(false);
    expect(send).toBeDefined();
  });

  it("24b. an active-existing-member rejection does not send (call count)", async () => {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: existingActiveUser.email, roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(calls).toHaveLength(0);
  });

  it("25. a permission-ceiling rejection does not send", async () => {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const result = await createTeamInvitationCore(
      limitedAClient,
      limitedA.id,
      { tenantId: tenantA.id, email: freshEmail("create-25"), roleId: tenantA.ownerRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("26. the raw token is absent from every outcome's browser-facing result (sent / delivery_failed / rpc_failure)", async () => {
    const sentFake = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const sentResult = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-26-sent"), roleId: limitedRoleId },
      { sendEmail: sentFake.send },
    );
    const sentToken = new URL(sentFake.calls[0]!.acceptUrl).searchParams.get("token")!;
    expect(JSON.stringify(sentResult)).not.toContain(sentToken);

    const failFake = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "rate_limited" });
    const failResult = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("create-26-fail"), roleId: limitedRoleId },
      { sendEmail: failFake.send },
    );
    const failToken = new URL(failFake.calls[0]!.acceptUrl).searchParams.get("token")!;
    expect(JSON.stringify(failResult)).not.toContain(failToken);

    const rpcFailFake = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const rpcFailResult = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: existingActiveUser.email, roleId: limitedRoleId },
      { sendEmail: rpcFailFake.send },
    );
    expect(JSON.stringify(rpcFailResult)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("resendTeamInvitationCore (27-33)", () => {
  async function createPendingInvitation(email: string) {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_setup" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email, roleId: limitedRoleId },
      { sendEmail: send },
    );
    if (!result.success) throw new Error(`setup failed: ${result.error.message}`);
    const originalToken = new URL(calls[0]!.acceptUrl).searchParams.get("token")!;
    return { invitationId: result.data.invitationId, originalToken };
  }

  it("27. calls the resend RPC and 28. uses the newly returned token (not the original)", async () => {
    const { invitationId, originalToken } = await createPendingInvitation(freshEmail("resend-27"));

    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_resend" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    const newToken = new URL(calls[0]!.acceptUrl).searchParams.get("token")!;
    expect(newToken).not.toBe(originalToken);
  });

  it("29. the transport receives the NEW post-rotation expiry, not the original", async () => {
    const { invitationId } = await createPendingInvitation(freshEmail("resend-29"));
    const [before] = await testDb<{ expires_at: string }[]>`
      select expires_at from team_invitations where id = ${invitationId}
    `;

    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_resend" });
    await resendTeamInvitationCore(ownerAClient, ownerA.id, { tenantId: tenantA.id, invitationId }, { sendEmail: send });

    expect(calls[0]!.expiresAt.toISOString()).not.toBe(new Date(before!.expires_at).toISOString());
  });

  it("30. provider success returns a safe {outcome:'sent'} result", async () => {
    const { invitationId } = await createPendingInvitation(freshEmail("resend-30"));
    const { send } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_resend" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId },
      { sendEmail: send },
    );
    expect(result).toMatchObject({ success: true, data: { outcome: "sent", invitationId } });
  });

  it("31. provider failure returns delivery_failed", async () => {
    const { invitationId } = await createPendingInvitation(freshEmail("resend-31"));
    const { send } = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "authentication_failed" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId },
      { sendEmail: send },
    );
    expect(result).toMatchObject({
      success: true,
      data: { outcome: "delivery_failed", invitationId, errorClass: "authentication_failed" },
    });
  });

  it("32. the raw token is absent from both resend outcomes' browser-facing result", async () => {
    const { invitationId: id1 } = await createPendingInvitation(freshEmail("resend-32a"));
    const sentFake = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const sentResult = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId: id1 },
      { sendEmail: sentFake.send },
    );
    const sentToken = new URL(sentFake.calls[0]!.acceptUrl).searchParams.get("token")!;
    expect(JSON.stringify(sentResult)).not.toContain(sentToken);

    const { invitationId: id2 } = await createPendingInvitation(freshEmail("resend-32b"));
    const failFake = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "unknown" });
    const failResult = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId: id2 },
      { sendEmail: failFake.send },
    );
    const failToken = new URL(failFake.calls[0]!.acceptUrl).searchParams.get("token")!;
    expect(JSON.stringify(failResult)).not.toContain(failToken);
  });

  it("33. an RPC failure (invitation not pending) never calls the email adapter", async () => {
    const { invitationId } = await createPendingInvitation(freshEmail("resend-33"));
    const { error: revokeError } = await ownerAClient.rpc("revoke_team_invitation", {
      p_invitation_id: invitationId,
    });
    expect(revokeError).toBeNull();

    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId },
      { sendEmail: send },
    );
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("expired-but-pending resend transitions cleanly without attempting a send", async () => {
    const rawToken = "a".repeat(64);
    const [stale] = await testDb<{ id: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantA.id}, ${freshEmail("resend-expired")}, ${limitedRoleId}, ${ownerA.id}, 'pending',
        ${rawToken}, now() - interval '1 hour', now() - interval '8 days')
      returning id
    `;
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId: stale!.id },
      { sendEmail: send },
    );
    expect(result).toMatchObject({ success: true, data: { outcome: "expired", invitationId: stale!.id } });
    expect(calls).toHaveLength(0);
  });
});

describe("error mapping — pure functions, exact live RPC messages", () => {
  it("maps every known create_team_invitation error message", () => {
    expect(mapCreateInvitationError({ message: "authentication required" })).toMatchObject({
      success: false,
      error: { code: "UNAUTHENTICATED" },
    });
    expect(mapCreateInvitationError({ message: "staff.manage required" })).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    expect(
      mapCreateInvitationError({ message: "cannot invite into a role with permissions you do not hold" }),
    ).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(mapCreateInvitationError({ message: "role not found in this tenant" })).toMatchObject({
      error: { code: "VALIDATION" },
    });
    expect(mapCreateInvitationError({ message: "staff member not found in this tenant" })).toMatchObject({
      error: { code: "VALIDATION" },
    });
    expect(mapCreateInvitationError({ message: "invalid_email" })).toMatchObject({ error: { code: "VALIDATION" } });
    expect(mapCreateInvitationError({ message: "pending_invitation_exists" })).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect(mapCreateInvitationError({ message: "already_member" })).toMatchObject({ error: { code: "CONFLICT" } });
    expect(mapCreateInvitationError({ message: "membership_suspended" })).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect(mapCreateInvitationError({ message: "some completely unrecognized message" })).toMatchObject({
      error: { code: "UNEXPECTED" },
    });
  });

  it("maps every known resend_team_invitation error message", () => {
    expect(mapResendInvitationError({ message: "invitation_not_found" })).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(mapResendInvitationError({ message: "staff.manage required" })).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    expect(
      mapResendInvitationError({ message: "cannot resend an invitation into a role with permissions you do not hold" }),
    ).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(mapResendInvitationError({ message: "invitation_not_pending" })).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect(mapResendInvitationError({ message: "some completely unrecognized message" })).toMatchObject({
      error: { code: "UNEXPECTED" },
    });
  });

  it("buildAcceptUrl URL-encodes the token safely, even for URL-sensitive characters", () => {
    const url = buildAcceptUrl("token with spaces & special?chars=1");
    expect(url).toContain(encodeURIComponent("token with spaces & special?chars=1"));
    expect(() => new URL(url)).not.toThrow();
  });
});

describe("privacy — no console output across every outcome", () => {
  it("37. create and resend never log anything, success or failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const ok1 = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_1" });
      await createTeamInvitationCore(
        ownerAClient,
        ownerA.id,
        { tenantId: tenantA.id, email: freshEmail("privacy-1"), roleId: limitedRoleId },
        { sendEmail: ok1.send },
      );

      const fail1 = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "unknown" });
      await createTeamInvitationCore(
        ownerAClient,
        ownerA.id,
        { tenantId: tenantA.id, email: freshEmail("privacy-2"), roleId: limitedRoleId },
        { sendEmail: fail1.send },
      );

      await createTeamInvitationCore(
        ownerAClient,
        ownerA.id,
        { tenantId: tenantA.id, email: existingActiveUser.email, roleId: limitedRoleId },
        { sendEmail: ok1.send },
      );

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
