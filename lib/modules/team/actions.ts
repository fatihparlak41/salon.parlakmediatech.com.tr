"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { getSiteUrl } from "@/lib/site-url";
import {
  sendTeamInvitationEmail,
  type EmailErrorClass,
  type EmailSendOutcome,
  type SendEmailTransport,
} from "@/lib/email/email-server";
import { createTeamInvitationSchema, resendTeamInvitationSchema } from "./schemas";

/**
 * Faz SAAS.1C.2B/2C — the ONLY module allowed to combine the
 * authenticated invitation RPCs, the raw token they return, the site
 * URL, and the email adapter. The raw token and the accept URL that
 * embeds it are local to these functions' own execution — never stored
 * in a variable that outlives the function, never part of any
 * ActionResult returned to the browser. See create_team_invitation/
 * resend_team_invitation's own migrations (20260917080000,
 * 20260918070000) for the RPC-side security model this orchestrates;
 * nothing here duplicates or second-guesses it — every RPC error is
 * mapped as-is, permission ceiling and optimistic fencing included.
 *
 * *Core split*: requireUser()/createClient() depend on Next.js's
 * request-scoped cookie context (next/headers) and cannot run outside a
 * real request — confirmed no existing test in this codebase imports a
 * Server Action directly, only ever the RPC/DB layer through a real
 * signed-in client (permission-ceiling.test.ts's own stated discipline).
 * The exported ...Core functions below take an already-authenticated
 * client and userId as plain parameters instead of reading them
 * themselves, so tests can call them with a REAL signed-in test client
 * (same network-RPC discipline as every other test in this suite) while
 * still injecting a fake email transport — mirroring the same
 * dependency-injection shape already used for sendPush/
 * sendTeamInvitationEmail, one layer up. The "use server" functions are
 * thin real-dependency wrappers around these Core functions.
 */

export type CreateTeamInvitationInput = {
  tenantId: string;
  email: string;
  roleId: string;
  staffMemberId?: string;
};

export type CreateTeamInvitationResultData =
  | { outcome: "sent"; invitationId: string }
  | { outcome: "delivery_failed"; invitationId: string; errorClass: EmailErrorClass };

export type ResendTeamInvitationInput = {
  tenantId: string;
  invitationId: string;
};

export type ResendTeamInvitationResultData =
  | { outcome: "sent"; invitationId: string }
  | { outcome: "delivery_failed"; invitationId: string; errorClass: EmailErrorClass }
  | { outcome: "expired"; invitationId: string };

type CreateTeamInvitationRpcRow = {
  id: string;
  tenant_id: string;
  email: string;
  role_id: string;
  staff_member_id: string | null;
  status: string;
  expires_at: string;
  created_at: string;
  token: string;
};

type ResendTeamInvitationRpcRow = {
  id: string;
  status: string;
  expires_at: string;
  token: string | null;
};

type ListTeamInvitationsRpcRow = {
  id: string;
  email: string;
  role_id: string;
  role_name: string;
  staff_member_id: string | null;
  staff_member_name: string | null;
  status: string;
  effective_status: string;
  expires_at: string;
  created_at: string;
  invited_by_name: string | null;
};

type AnySupabaseClient = SupabaseClient<Database>;

/** Exact live RPC error messages (private.create_team_invitation,
 * 20260917080000) — re-read from the deployed DEV function body for
 * this phase, not recalled from memory. */
export function mapCreateInvitationError(error: { message: string }): ActionResult<never> {
  const msg = error.message;
  if (msg.includes("authentication required")) {
    return fail("UNAUTHENTICATED", "Oturum açmanız gerekiyor");
  }
  if (msg.includes("staff.manage required")) {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  if (msg.includes("cannot invite into a role with permissions you do not hold")) {
    return fail("UNAUTHORIZED", "Sahip olmadığınız izinleri içeren bir role davet gönderemezsiniz");
  }
  if (msg.includes("role not found in this tenant")) {
    return fail("VALIDATION", "Geçersiz rol");
  }
  if (msg.includes("staff member not found in this tenant")) {
    return fail("VALIDATION", "Geçersiz personel");
  }
  if (msg.includes("invalid_email")) {
    return fail("VALIDATION", "Geçersiz e-posta adresi");
  }
  if (msg.includes("pending_invitation_exists")) {
    return fail("CONFLICT", "Bu e-posta için zaten bekleyen bir davet var");
  }
  if (msg.includes("already_member")) {
    return fail("CONFLICT", "Bu kişi zaten ekibin bir üyesi");
  }
  if (msg.includes("membership_suspended")) {
    return fail("CONFLICT", "Bu kişinin üyeliği askıya alınmış");
  }
  return fail("UNEXPECTED", "Davet oluşturulamadı, lütfen tekrar deneyin");
}

/** Exact live RPC error messages — private.resend_team_invitation AND
 * private.list_team_invitations (Faz SAAS.1C.2C, 20260918070000; the
 * prelookup call below can only ever raise the shared
 * "staff.manage required" case). Note: an already-expired-but-still-
 * pending invitation is NOT an error from resend_team_invitation — it
 * returns a normal {status:"expired", token:null} row instead, handled
 * separately, not here. invitation_changed is new this phase: the
 * caller's observed expires_at no longer matches the row's current
 * value — someone else (most likely a concurrent resend) already
 * mutated it first. */
export function mapResendInvitationError(error: { message: string }): ActionResult<never> {
  const msg = error.message;
  if (msg.includes("invitation_not_found")) {
    return fail("NOT_FOUND", "Davet bulunamadı");
  }
  if (msg.includes("staff.manage required")) {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }
  if (msg.includes("cannot resend an invitation into a role with permissions you do not hold")) {
    return fail("UNAUTHORIZED", "Sahip olmadığınız izinleri içeren bir role daveti yeniden gönderemezsiniz");
  }
  if (msg.includes("invitation_not_pending")) {
    return fail("CONFLICT", "Bu davet artık beklemede değil");
  }
  if (msg.includes("invitation_changed")) {
    return fail("CONFLICT", "Davet başka bir işlem tarafından güncellendi. Lütfen tekrar deneyin.");
  }
  return fail("UNEXPECTED", "Davet yeniden gönderilemedi, lütfen tekrar deneyin");
}

export function buildAcceptUrl(rawToken: string): string {
  return `${getSiteUrl()}/accept-invite?token=${encodeURIComponent(rawToken)}`;
}

/** Tenant display name + timezone via the same tenant-safe, RLS-scoped
 * SELECT every other authenticated tenant page in this codebase already
 * relies on (see lib/auth/session.ts's getTenantAccess) — never an
 * admin/service-role client for this. */
async function fetchTenantPresentation(
  supabase: AnySupabaseClient,
  tenantId: string,
): Promise<{ tenantName: string; tenantTimezone: string } | null> {
  const { data } = await supabase.from("tenants").select("name, timezone").eq("id", tenantId).maybeSingle();
  if (!data) return null;
  return { tenantName: data.name, tenantTimezone: data.timezone };
}

async function fetchRoleName(supabase: AnySupabaseClient, roleId: string): Promise<string | null> {
  const { data } = await supabase.from("roles").select("name").eq("id", roleId).maybeSingle();
  return data?.name ?? null;
}

async function fetchInviterName(supabase: AnySupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle();
  return data?.full_name ?? null;
}

/**
 * Faz SAAS.1C.2C — records the transport result via the narrow,
 * service_role-only log_team_invitation_email_delivery RPC
 * (20260918070000). Deliberately the ONLY place createAdminClient() is
 * used in this module — create_team_invitation/resend_team_invitation
 * themselves always run under the caller's own authenticated session,
 * never service_role.
 *
 * Unconditionally non-destructive: audit storage and email delivery are
 * separate concerns, and a failure here must never change what the
 * browser is told about the email outcome, never retry the send, never
 * touch the invitation. Every failure path — a returned RPC error OR
 * any thrown exception (network, a misconfigured admin client, etc.) —
 * is caught here and reduced to one sanitized, non-throwing log line;
 * callers can `await` this with no try/catch of their own.
 */
async function recordDeliveryAudit(params: {
  invitationId: string;
  actorUserId: string;
  attemptType: "create" | "resend";
  sendResult: EmailSendOutcome;
  durationMs: number;
}): Promise<void> {
  const errorClass = params.sendResult.outcome === "failed" ? params.sendResult.errorClass : undefined;
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("log_team_invitation_email_delivery", {
      p_invitation_id: params.invitationId,
      p_actor_user_id: params.actorUserId,
      p_attempt_type: params.attemptType,
      p_outcome: params.sendResult.outcome,
      p_provider: params.sendResult.provider,
      p_provider_message_id: params.sendResult.outcome === "sent" ? params.sendResult.providerMessageId : undefined,
      p_error_class: errorClass,
      p_duration_ms: params.durationMs,
    });
    if (error) {
      // Sanitized only — never email/token/acceptUrl/raw provider text.
      console.error("team-invitation-email-audit failed", {
        invitationId: params.invitationId,
        attemptType: params.attemptType,
        outcome: params.sendResult.outcome,
        errorClass,
      });
    }
  } catch {
    console.error("team-invitation-email-audit failed", {
      invitationId: params.invitationId,
      attemptType: params.attemptType,
      outcome: params.sendResult.outcome,
      errorClass,
    });
  }
}

export async function createTeamInvitationCore(
  supabase: AnySupabaseClient,
  userId: string,
  input: CreateTeamInvitationInput,
  deps?: { sendEmail?: SendEmailTransport },
): Promise<ActionResult<CreateTeamInvitationResultData>> {
  const parsed = createTeamInvitationSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  // RPC authorization remains the sole source of truth — permission
  // ceiling, cross-tenant role/staff checks, duplicate-pending,
  // existing-member checks all live in create_team_invitation itself
  // and are never re-implemented or second-guessed here. No email is
  // ever attempted, and no delivery audit event is ever written, if
  // this fails.
  const { data, error } = await supabase.rpc("create_team_invitation", {
    p_tenant_id: parsed.data.tenantId,
    p_email: parsed.data.email,
    p_role_id: parsed.data.roleId,
    p_staff_member_id: parsed.data.staffMemberId ?? undefined,
  });

  if (error) {
    return mapCreateInvitationError(error);
  }

  const row = (data as CreateTeamInvitationRpcRow[] | null)?.[0];
  if (!row) {
    return fail("UNEXPECTED", "Davet oluşturulamadı, lütfen tekrar deneyin");
  }

  // The invitation now exists in the DB regardless of anything below —
  // an email delivery problem from this point on must never be reported
  // as invitation-creation failure.
  const invitationId = row.id;

  const [tenantPresentation, roleName, inviterName] = await Promise.all([
    fetchTenantPresentation(supabase, parsed.data.tenantId),
    fetchRoleName(supabase, parsed.data.roleId),
    fetchInviterName(supabase, userId),
  ]);

  if (!tenantPresentation || !roleName) {
    // Created successfully; we just couldn't gather what the email
    // needs to say. Same outcome shape as a provider send failure —
    // the invitation stays pending, resend is the recovery path. No
    // provider was ever contacted, so no delivery audit event either.
    return ok({ outcome: "delivery_failed", invitationId, errorClass: "unknown" });
  }

  const acceptUrl = buildAcceptUrl(row.token);

  const send = deps?.sendEmail ?? sendTeamInvitationEmail;
  const sendStartedAt = Date.now();
  const sendResult = await send({
    to: parsed.data.email,
    tenantName: tenantPresentation.tenantName,
    roleName,
    inviterName,
    acceptUrl,
    expiresAt: new Date(row.expires_at),
    tenantTimezone: tenantPresentation.tenantTimezone,
    locale: "tr",
  });
  const durationMs = Date.now() - sendStartedAt;
  // acceptUrl / row.token are not referenced again after this call —
  // their lifetime ends here, never reaching the return value below.

  await recordDeliveryAudit({
    invitationId,
    actorUserId: userId,
    attemptType: "create",
    sendResult,
    durationMs,
  });

  if (sendResult.outcome === "sent") {
    return ok({ outcome: "sent", invitationId });
  }
  return ok({ outcome: "delivery_failed", invitationId, errorClass: sendResult.errorClass });
}

export async function resendTeamInvitationCore(
  supabase: AnySupabaseClient,
  actorUserId: string,
  input: ResendTeamInvitationInput,
  deps?: { sendEmail?: SendEmailTransport },
): Promise<ActionResult<ResendTeamInvitationResultData>> {
  const parsed = resendTeamInvitationSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", "Geçersiz istek");
  }

  // Faz SAAS.1C.2C — prelookup BEFORE any mutation, within the
  // CALLER-SUPPLIED tenant's own authorized list_team_invitations
  // result. Fixes the prior failure class where a wrong/stale tenantId
  // could rotate the token first and only fail presentation lookup
  // afterward: a bad tenantId simply won't find the row here, failing
  // closed before resend_team_invitation (or the email adapter) is ever
  // called.
  const { data: listData, error: listError } = await supabase.rpc("list_team_invitations", {
    p_tenant_id: parsed.data.tenantId,
  });
  if (listError) {
    return mapResendInvitationError(listError);
  }
  const invitationRow = (listData as ListTeamInvitationsRpcRow[] | null)?.find(
    (r) => r.id === parsed.data.invitationId,
  );
  if (!invitationRow) {
    return fail("NOT_FOUND", "Davet bulunamadı");
  }

  const tenantPresentation = await fetchTenantPresentation(supabase, parsed.data.tenantId);
  if (!tenantPresentation) {
    return fail("UNEXPECTED", "Davet yeniden gönderilemedi, lütfen tekrar deneyin");
  }

  // THEN the fenced mutation — expires_at exactly as observed above.
  // Faz SAAS.1C.2C's optimistic concurrency contract: if another resend
  // has already rotated this invitation between the prelookup and here,
  // this raises invitation_changed and mutates nothing.
  const { data, error } = await supabase.rpc("resend_team_invitation", {
    p_invitation_id: parsed.data.invitationId,
    p_expected_expires_at: invitationRow.expires_at,
  });

  if (error) {
    return mapResendInvitationError(error);
  }

  const row = (data as ResendTeamInvitationRpcRow[] | null)?.[0];
  if (!row) {
    return fail("UNEXPECTED", "Davet yeniden gönderilemedi, lütfen tekrar deneyin");
  }

  if (row.status === "expired" || !row.token) {
    // resend_team_invitation's own documented behavior: an
    // already-expired-but-still-pending row is transitioned to expired
    // and returned WITHOUT a fresh token rather than resurrected. There
    // is nothing to send — the caller needs a new invitation, not
    // another resend attempt on this one. No delivery audit event.
    return ok({ outcome: "expired", invitationId: parsed.data.invitationId });
  }

  // Pre-mutation data (invitationRow, tenantPresentation) is sufficient
  // for the email — no further lookup after the rotation.
  const acceptUrl = buildAcceptUrl(row.token);

  const send = deps?.sendEmail ?? sendTeamInvitationEmail;
  const sendStartedAt = Date.now();
  const sendResult = await send({
    to: invitationRow.email,
    tenantName: tenantPresentation.tenantName,
    roleName: invitationRow.role_name,
    inviterName: invitationRow.invited_by_name,
    acceptUrl,
    expiresAt: new Date(row.expires_at),
    tenantTimezone: tenantPresentation.tenantTimezone,
    locale: "tr",
  });
  const durationMs = Date.now() - sendStartedAt;
  // acceptUrl / row.token are not referenced again after this call.

  await recordDeliveryAudit({
    invitationId: parsed.data.invitationId,
    actorUserId,
    attemptType: "resend",
    sendResult,
    durationMs,
  });

  if (sendResult.outcome === "sent") {
    return ok({ outcome: "sent", invitationId: parsed.data.invitationId });
  }
  return ok({
    outcome: "delivery_failed",
    invitationId: parsed.data.invitationId,
    errorClass: sendResult.errorClass,
  });
}

export async function createTeamInvitationAction(
  _prevState: ActionResult<CreateTeamInvitationResultData> | null,
  input: CreateTeamInvitationInput,
): Promise<ActionResult<CreateTeamInvitationResultData>> {
  const user = await requireUser();
  const supabase = await createClient();
  return createTeamInvitationCore(supabase, user.id, input);
}

export async function resendTeamInvitationAction(
  _prevState: ActionResult<ResendTeamInvitationResultData> | null,
  input: ResendTeamInvitationInput,
): Promise<ActionResult<ResendTeamInvitationResultData>> {
  const user = await requireUser();
  const supabase = await createClient();
  return resendTeamInvitationCore(supabase, user.id, input);
}
