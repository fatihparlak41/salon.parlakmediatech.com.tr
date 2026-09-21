import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
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
import { createTeamInvitationCore, resendTeamInvitationCore } from "@/lib/modules/team/actions";
import type { EmailSendOutcome, SendEmailTransport, TeamInvitationEmailInput } from "@/lib/email/email-server";

/**
 * Faz SAAS.1C.2C — resend optimistic concurrency fencing and the
 * service_role-only email delivery audit RPC (20260918070000). Direct
 * RPC tests use the real service_role `admin` client from tests/
 * helpers.ts (the only place that client is meant to stand in for
 * "trusted server-side code" in this test suite) or real signed-in
 * clients, never a mock — same discipline as every other security-
 * boundary test in this codebase. Orchestration tests use
 * createTeamInvitationCore/resendTeamInvitationCore with an injected
 * fake email transport — real RPCs, zero network/App Password/real email.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let managerA: TestUser; // staff.manage + within ceiling, distinct actor from ownerA
let unrelatedUser: TestUser; // member of tenantB only

let ownerAClient: SupabaseClient;
let managerAClient: SupabaseClient;

let limitedRoleId: string;

const createdUserIds: string[] = [];

beforeAll(async () => {
  ownerA = await createTestUser("tea-owner-a");
  managerA = await createTestUser("tea-manager-a");
  unrelatedUser = await createTestUser("tea-unrelated");
  createdUserIds.push(ownerA.id, managerA.id, unrelatedUser.id);

  tenantA = await createTestTenant("test-tenant-tea-a", ownerA.id);
  tenantB = await createTestTenant("test-tenant-tea-b", unrelatedUser.id);

  limitedRoleId = await createRoleForTenant(tenantA.id, "Sınırlı Rol", ["staff.manage", "appointments.view"]);
  // Faz SAAS.1E.0 part 2: a non-owner may resend/revoke an invitation only when
  // the invited role's permissions are a STRICT subset of their own, so the
  // manager holds one permission MORE (services.view) than the invited role
  // instead of sharing it (equal authority is now refused — see
  // tests/invitation-target-authority.test.ts).
  const managerRoleId = await createRoleForTenant(tenantA.id, "Üst Sınırlı Rol", [
    "staff.manage",
    "appointments.view",
    "services.view",
  ]);
  await addMembership(tenantA.id, managerA.id, managerRoleId);

  ownerAClient = await signInAs(ownerA);
  managerAClient = await signInAs(managerA);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers(createdUserIds);
}, 60000);

function freshEmail(label: string): string {
  return `tea-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;
}

type CreateRow = { id: string; expires_at: string; token: string };

async function createInvitation(email: string, roleId = limitedRoleId): Promise<CreateRow> {
  const { data, error } = await ownerAClient.rpc("create_team_invitation", {
    p_tenant_id: tenantA.id,
    p_email: email,
    p_role_id: roleId,
  });
  if (error || !data) throw new Error(`fixture create failed: ${error?.message}`);
  return (data as CreateRow[])[0]!;
}

function fakeSender(outcome: EmailSendOutcome): { send: SendEmailTransport; calls: TeamInvitationEmailInput[] } {
  const calls: TeamInvitationEmailInput[] = [];
  const send: SendEmailTransport = async (input) => {
    calls.push(input);
    return outcome;
  };
  return { send, calls };
}

describe("log_team_invitation_email_delivery — direct RPC tests (1-18)", () => {
  it("1. a 'sent' event is written to audit_logs", async () => {
    const inv = await createInvitation(freshEmail("audit-1"));
    const { error } = await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_1",
    });
    expect(error).toBeNull();

    const rows = await testDb<{ action: string }[]>`
      select action from audit_logs where entity_type = 'team_invitation' and entity_id = ${inv.id} and action = 'team_invitation.email_sent'
    `;
    expect(rows).toHaveLength(1);
  });

  it("2. a 'failed' event is written to audit_logs", async () => {
    const inv = await createInvitation(freshEmail("audit-2"));
    const { error } = await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "failed",
      p_provider: "google_workspace_smtp",
      p_error_class: "provider_unavailable",
    });
    expect(error).toBeNull();

    const rows = await testDb<{ action: string }[]>`
      select action from audit_logs where entity_type = 'team_invitation' and entity_id = ${inv.id} and action = 'team_invitation.email_send_failed'
    `;
    expect(rows).toHaveLength(1);
  });

  it("3. attempt_type='create' is stored correctly", async () => {
    const inv = await createInvitation(freshEmail("audit-3"));
    await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_3",
    });
    const [row] = await testDb<{ after: { attempt_type: string } }[]>`
      select after from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_sent'
    `;
    expect(row?.after.attempt_type).toBe("create");
  });

  it("4. attempt_type='resend' is stored correctly", async () => {
    const inv = await createInvitation(freshEmail("audit-4"));
    await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "resend",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_4",
    });
    const [row] = await testDb<{ after: { attempt_type: string } }[]>`
      select after from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_sent'
    `;
    expect(row?.after.attempt_type).toBe("resend");
  });

  it("5. provider_message_id is stored for a success event", async () => {
    const inv = await createInvitation(freshEmail("audit-5"));
    await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_distinctive_5",
    });
    const [row] = await testDb<{ after: { provider_message_id: string } }[]>`
      select after from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_sent'
    `;
    expect(row?.after.provider_message_id).toBe("msg_distinctive_5");
  });

  it("6. error_class is stored for a failure event", async () => {
    const inv = await createInvitation(freshEmail("audit-6"));
    await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "failed",
      p_provider: "google_workspace_smtp",
      p_error_class: "rate_limited",
    });
    const [row] = await testDb<{ after: { error_class: string } }[]>`
      select after from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_send_failed'
    `;
    expect(row?.after.error_class).toBe("rate_limited");
  });

  it("7. duration_ms is stored", async () => {
    const inv = await createInvitation(freshEmail("audit-7"));
    await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_7",
      p_duration_ms: 1234,
    });
    const [row] = await testDb<{ after: { duration_ms: number } }[]>`
      select after from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_sent'
    `;
    expect(row?.after.duration_ms).toBe(1234);
  });

  it("8. tenant_id on the written row is derived from the invitation, never trusted from the caller", async () => {
    const inv = await createInvitation(freshEmail("audit-8"));
    await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_8",
    });
    const [row] = await testDb<{ tenant_id: string }[]>`
      select tenant_id from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_sent'
    `;
    expect(row?.tenant_id).toBe(tenantA.id);
  });

  it("9. a real active-member actor is accepted", async () => {
    const inv = await createInvitation(freshEmail("audit-9"));
    const { error } = await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: managerA.id, // active member of tenantA, not the inviter
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_9",
    });
    expect(error).toBeNull();
  });

  it("10. an unrelated actor (member of a different tenant) is rejected", async () => {
    const inv = await createInvitation(freshEmail("audit-10"));
    const { error } = await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: unrelatedUser.id, // only a member of tenantB
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_10",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/actor_not_authorized/);

    const rows = await testDb<{ id: string }[]>`select id from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_sent'`;
    expect(rows).toHaveLength(0);
  });

  it("11. a missing/non-existent invitation is rejected", async () => {
    const { error } = await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: "00000000-0000-0000-0000-000000000000",
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_11",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invitation_not_found/);
  });

  it("12. PUBLIC has no execute grant on either signature", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.routine_privileges where routine_name = 'log_team_invitation_email_delivery'
    `;
    expect(rows.map((r) => r.grantee)).not.toContain("PUBLIC");
  });

  it("13. anon cannot execute the audit RPC", async () => {
    const inv = await createInvitation(freshEmail("audit-13"));
    const { error } = await anonClient().rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
    });
    expect(error).not.toBeNull();
  });

  it("14. authenticated cannot execute the audit RPC", async () => {
    const inv = await createInvitation(freshEmail("audit-14"));
    const { error } = await ownerAClient.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
    });
    expect(error).not.toBeNull();
  });

  it("15. service_role can execute the audit RPC", async () => {
    const inv = await createInvitation(freshEmail("audit-15"));
    const { error } = await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_15",
    });
    expect(error).toBeNull();
  });

  it("16-18. no token, email, or URL ever appears in the written payload", async () => {
    const email = freshEmail("audit-16");
    const inv = await createInvitation(email);
    await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: inv.id,
      p_actor_user_id: ownerA.id,
      p_attempt_type: "create",
      p_outcome: "sent",
      p_provider: "google_workspace_smtp",
      p_provider_message_id: "msg_16",
    });
    const [row] = await testDb<{ before: unknown; after: unknown }[]>`
      select before, after from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_sent'
    `;
    const serialized = JSON.stringify([row?.before, row?.after]);
    expect(serialized).not.toContain(inv.token);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toMatch(/https?:\/\//);
  });
});

describe("resend fencing (Steps 2-5)", () => {
  it("a normal resend with a matching expected_expires_at succeeds", async () => {
    const inv = await createInvitation(freshEmail("fence-1"));
    const { data, error } = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: inv.id,
      p_expected_expires_at: inv.expires_at,
    });
    expect(error).toBeNull();
    expect((data as { status: string }[])[0]?.status).toBe("pending");
  });

  it("a stale expected_expires_at raises invitation_changed and rotates nothing", async () => {
    const inv = await createInvitation(freshEmail("fence-2"));
    // First, a real rotation.
    const first = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: inv.id,
      p_expected_expires_at: inv.expires_at,
    });
    expect(first.error).toBeNull();

    // Now try again with the ORIGINAL (now stale) observed value.
    const stale = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: inv.id,
      p_expected_expires_at: inv.expires_at,
    });
    expect(stale.error).not.toBeNull();
    expect(stale.error?.message).toMatch(/invitation_changed/);
    expect(stale.data).toBeNull();
  });

  it("the old unfenced 1-argument signature no longer exists in the schema — exactly one 2-arg public.resend_team_invitation remains", async () => {
    const rows = await testDb<{ nargs: number }[]>`
      select pg_proc.pronargs as nargs
      from pg_proc
      join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
      where pg_proc.proname = 'resend_team_invitation' and pg_namespace.nspname = 'public'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nargs).toBe(2);
  });
});

describe("real concurrent resend (Step 6)", () => {
  it("exactly one of two concurrent resends succeeds; the other gets invitation_changed, token_hash changes exactly once", async () => {
    const inv = await createInvitation(freshEmail("race-1"));
    const [row0] = await testDb<{ token_hash: string }[]>`select token_hash from team_invitations where id = ${inv.id}`;
    const originalHash = row0!.token_hash;

    // Two separate authenticated clients (ownerA, managerA), both
    // observing the SAME original expires_at before either mutates
    // anything, firing concurrently via Promise.all — not a sequential
    // substitute.
    const [r1, r2] = await Promise.all([
      ownerAClient.rpc("resend_team_invitation", { p_invitation_id: inv.id, p_expected_expires_at: inv.expires_at }),
      managerAClient.rpc("resend_team_invitation", { p_invitation_id: inv.id, p_expected_expires_at: inv.expires_at }),
    ]);

    const results = [r1, r2];
    const succeeded = results.filter((r) => r.error === null);
    const failed = results.filter((r) => r.error !== null);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error!.message).toMatch(/invitation_changed/);

    // Losing caller receives NO raw token.
    expect(failed[0]!.data).toBeNull();
    // Only the successful caller receives a raw token.
    const winningToken = (succeeded[0]!.data as { token: string }[])[0]!.token;
    expect(winningToken).toBeTruthy();

    const [finalRow] = await testDb<{ status: string; token_hash: string }[]>`
      select status, token_hash from team_invitations where id = ${inv.id}
    `;
    expect(finalRow?.status).toBe("pending");
    expect(finalRow?.token_hash).not.toBe(originalHash);
  }, 30000);

  it("orchestration: exactly one email send occurs across two concurrent resend actions; the loser sends zero", async () => {
    const inv = await createInvitation(freshEmail("race-2"));
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_race" });

    const [a1, a2] = await Promise.all([
      resendTeamInvitationCore(ownerAClient, ownerA.id, { tenantId: tenantA.id, invitationId: inv.id }, { sendEmail: send }),
      resendTeamInvitationCore(managerAClient, managerA.id, { tenantId: tenantA.id, invitationId: inv.id }, { sendEmail: send }),
    ]);

    expect(calls).toHaveLength(1);

    const results = [a1, a2];
    const successCount = results.filter((r) => r.success && r.data.outcome === "sent").length;
    const conflictCount = results.filter((r) => !r.success && r.error.code === "CONFLICT").length;
    expect(successCount).toBe(1);
    expect(conflictCount).toBe(1);
  }, 30000);
});

describe("createTeamInvitationCore audit integration (19-23)", () => {
  it("19. send success records a 'sent' delivery audit event", async () => {
    const email = freshEmail("create-audit-19");
    const { send } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_19" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email, roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    const invitationId = (result as { success: true; data: { invitationId: string } }).data.invitationId;

    const rows = await testDb<{ action: string }[]>`
      select action from audit_logs where entity_id = ${invitationId} and action = 'team_invitation.email_sent'
    `;
    expect(rows).toHaveLength(1);
  });

  it("20. send failure records a 'failed' delivery audit event", async () => {
    const email = freshEmail("create-audit-20");
    const { send } = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "network_error" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email, roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    const invitationId = (result as { success: true; data: { invitationId: string } }).data.invitationId;

    const rows = await testDb<{ action: string }[]>`
      select action from audit_logs where entity_id = ${invitationId} and action = 'team_invitation.email_send_failed'
    `;
    expect(rows).toHaveLength(1);
  });

  it("21. an RPC failure never writes a delivery audit event", async () => {
    const { send } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_21" });
    // Duplicate-pending is a reliable, cheap RPC failure to trigger.
    const email = freshEmail("create-audit-21");
    const first = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email, roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(first.success).toBe(true);

    const countBefore = (await testDb<{ n: string }[]>`select count(*)::text as n from audit_logs where tenant_id = ${tenantA.id} and action like 'team_invitation.email_%'`)[0]!.n;

    const second = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email, roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(second.success).toBe(false);

    const countAfter = (await testDb<{ n: string }[]>`select count(*)::text as n from audit_logs where tenant_id = ${tenantA.id} and action like 'team_invitation.email_%'`)[0]!.n;
    expect(countAfter).toBe(countBefore);
  });

  it("22-23. audit RPC failure does not alter the browser-facing send outcome (sent or delivery_failed)", async () => {
    // Simulate an audit-write failure by using an actor NOT recognized
    // as a member of the invitation's own tenant — log_team_invitation_
    // email_delivery will reject with actor_not_authorized internally,
    // but createTeamInvitationCore must still report the REAL send
    // outcome to the browser regardless.
    const outsider = await createTestUser("tea-audit-outsider");
    createdUserIds.push(outsider.id);

    const sentFake = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_22" });
    const sentResult = await createTeamInvitationCore(
      ownerAClient,
      outsider.id, // not a member of tenantA — audit write will fail internally
      { tenantId: tenantA.id, email: freshEmail("create-audit-22"), roleId: limitedRoleId },
      { sendEmail: sentFake.send },
    );
    // create_team_invitation itself only checks the CALLER's session
    // permission (ownerAClient), never userId directly, so invitation
    // creation and the email send both still succeed; only the audit
    // write (keyed off outsider.id) fails.
    expect(sentResult).toMatchObject({ success: true, data: { outcome: "sent" } });

    const failFake = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "unknown" });
    const failResult = await createTeamInvitationCore(
      ownerAClient,
      outsider.id,
      { tenantId: tenantA.id, email: freshEmail("create-audit-23"), roleId: limitedRoleId },
      { sendEmail: failFake.send },
    );
    expect(failResult).toMatchObject({ success: true, data: { outcome: "delivery_failed" } });
  });
});

describe("resendTeamInvitationCore prelookup + audit integration (24-34)", () => {
  it("24-25-26-27. an invitation from a DIFFERENT tenant than the one the caller supplied fails the prelookup as not-found — no mutation, no email, no audit", async () => {
    // ownerA genuinely holds staff.manage in tenantA (passes that
    // authorization check inside list_team_invitations), but the
    // invitation itself belongs to tenantB — proving the prelookup
    // itself, not just the permission check, is what closes this path.
    const rawToken = randomTokenHex();
    const [crossTenantInv] = await testDb<{ id: string; token_hash: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantB.id}, ${freshEmail("resend-wrong-tenant")}, ${tenantB.ownerRoleId}, ${unrelatedUser.id}, 'pending', ${sha256Hex(rawToken)}, now() + interval '7 days', now())
      returning id, token_hash
    `;

    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_wrong" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId: crossTenantInv!.id }, // caller's own tenant, wrong invitation
      { sendEmail: send },
    );

    expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(calls).toHaveLength(0); // 26: no email

    const [after] = await testDb<{ token_hash: string }[]>`select token_hash from team_invitations where id = ${crossTenantInv!.id}`;
    expect(after?.token_hash).toBe(crossTenantInv!.token_hash); // 25: no mutation

    const auditRows = await testDb<{ id: string }[]>`select id from audit_logs where entity_id = ${crossTenantInv!.id} and action like 'team_invitation.email_%'`;
    expect(auditRows).toHaveLength(0); // 27: no audit
  });

  it("28. the expected_expires_at passed to the RPC matches what was observed in the prelookup", async () => {
    const inv = await createInvitation(freshEmail("resend-expected"));
    const [before] = await testDb<{ expires_at: string }[]>`select expires_at from team_invitations where id = ${inv.id}`;

    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_28" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId: inv.id },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    // The NEW expires_at (post-rotation) must differ from the pre-mutation one.
    expect(calls[0]!.expiresAt.toISOString()).not.toBe(new Date(before!.expires_at).toISOString());
  });

  it("29. a fenced success sends exactly once", async () => {
    const inv = await createInvitation(freshEmail("resend-29"));
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_29" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId: inv.id },
      { sendEmail: send },
    );
    expect(result).toMatchObject({ success: true, data: { outcome: "sent" } });
    expect(calls).toHaveLength(1);
  });

  it("30-31. a raw invitation_changed result at the RPC layer writes zero delivery audit events (orchestration-level zero-email proof lives in the Step 6 concurrency test above)", async () => {
    const inv = await createInvitation(freshEmail("resend-30"));
    // Rotate once so the invitation's real current expires_at diverges
    // from what was originally observed in `inv`.
    const rotated = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: inv.id,
      p_expected_expires_at: inv.expires_at,
    });
    expect(rotated.error).toBeNull();

    // Reuse the now-stale original expires_at — exactly the shape of
    // fencing rejection a losing concurrent caller hits.
    const stale = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: inv.id,
      p_expected_expires_at: inv.expires_at,
    });
    expect(stale.error).not.toBeNull();
    expect(stale.error?.message).toMatch(/invitation_changed/);

    const auditRows = await testDb<{ id: string }[]>`select id from audit_logs where entity_id = ${inv.id} and action like 'team_invitation.email_%'`;
    expect(auditRows).toHaveLength(0);
  });

  it("32. a successful resend audits 'sent'", async () => {
    const inv = await createInvitation(freshEmail("resend-32"));
    const { send } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_32" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId: inv.id },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    const rows = await testDb<{ after: { attempt_type: string } }[]>`
      select after from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_sent'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after.attempt_type).toBe("resend");
  });

  it("33. a provider failure on resend audits 'failed'", async () => {
    const inv = await createInvitation(freshEmail("resend-33"));
    const { send } = fakeSender({ outcome: "failed", provider: "google_workspace_smtp", errorClass: "invalid_recipient" });
    const result = await resendTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, invitationId: inv.id },
      { sendEmail: send },
    );
    expect(result).toMatchObject({ success: true, data: { outcome: "delivery_failed" } });
    const rows = await testDb<{ after: { error_class: string } }[]>`
      select after from audit_logs where entity_id = ${inv.id} and action = 'team_invitation.email_send_failed'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after.error_class).toBe("invalid_recipient");
  });

  it("34. an audit failure remains non-destructive to the resend outcome", async () => {
    const outsider = await createTestUser("tea-resend-outsider");
    createdUserIds.push(outsider.id);
    const inv = await createInvitation(freshEmail("resend-34"));
    const { send } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_34" });

    const result = await resendTeamInvitationCore(
      ownerAClient,
      outsider.id, // audit write will fail (actor_not_authorized) internally
      { tenantId: tenantA.id, invitationId: inv.id },
      { sendEmail: send },
    );
    expect(result).toMatchObject({ success: true, data: { outcome: "sent" } });
  });
});

describe("privacy (35-38)", () => {
  it("35-36. a recognizable raw token never appears in the action result or the audit payload", async () => {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_priv" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("priv-token"), roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    const invitationId = (result as { success: true; data: { invitationId: string } }).data.invitationId;
    const rawToken = new URL(calls[0]!.acceptUrl).searchParams.get("token")!;

    expect(JSON.stringify(result)).not.toContain(rawToken);

    const [row] = await testDb<{ before: unknown; after: unknown }[]>`
      select before, after from audit_logs where entity_id = ${invitationId} and action = 'team_invitation.email_sent'
    `;
    expect(JSON.stringify([row?.before, row?.after])).not.toContain(rawToken);
  });

  it("37. the recipient email never appears in the audit payload", async () => {
    const email = freshEmail("priv-email");
    const { send } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_priv2" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email, roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    const invitationId = (result as { success: true; data: { invitationId: string } }).data.invitationId;

    const [row] = await testDb<{ before: unknown; after: unknown }[]>`
      select before, after from audit_logs where entity_id = ${invitationId} and action = 'team_invitation.email_sent'
    `;
    expect(JSON.stringify([row?.before, row?.after])).not.toContain(email);
  });

  it("38. the accept URL never appears in the audit payload", async () => {
    const { send, calls } = fakeSender({ outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "msg_priv3" });
    const result = await createTeamInvitationCore(
      ownerAClient,
      ownerA.id,
      { tenantId: tenantA.id, email: freshEmail("priv-url"), roleId: limitedRoleId },
      { sendEmail: send },
    );
    expect(result.success).toBe(true);
    const invitationId = (result as { success: true; data: { invitationId: string } }).data.invitationId;

    const [row] = await testDb<{ before: unknown; after: unknown }[]>`
      select before, after from audit_logs where entity_id = ${invitationId} and action = 'team_invitation.email_sent'
    `;
    const serialized = JSON.stringify([row?.before, row?.after]);
    expect(serialized).not.toContain(calls[0]!.acceptUrl);
    expect(serialized).not.toMatch(/https?:\/\//);
  });
});
