import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/supabase/database.types";
import { fail, ok, type ActionResult } from "@/lib/errors";
import {
  MEMBER_NOT_FOUND_MESSAGE,
  MEMBER_NOT_MANAGEABLE_MESSAGE,
  MEMBER_SELF_ACTION_MESSAGE,
  MEMBER_STATE_CHANGED_MESSAGE,
  mapMemberManagementError,
} from "./helpers";

/**
 * Faz LAUNCH.1A — the Owner-facing Team management actions: change a member's
 * role, suspend, restore (reactivate) and remove access.
 *
 * NOTHING HERE DECIDES WHO MAY DO WHAT. The four mutations are the SAAS.1E.0
 * RPCs (suspend_membership, reactivate_membership, remove_membership_access,
 * update_membership_role), which take the tenant row lock, judge authority on
 * EFFECTIVE permissions, forbid acting on yourself, assert the tenant still has
 * an unrestricted holder (the last Owner can never be suspended, removed or
 * demoted — by themself or by anyone else) and write exactly one audit row per
 * real change (none for a refusal or a same-role no-op). Every RPC error is
 * mapped as-is; no check is re-implemented or second-guessed.
 *
 * What these functions add on top, all of it about not acting on the wrong row:
 *  - a PRELOOKUP through list_team_members for the tenant the caller named. A
 *    membership id that is not in that tenant's list (forged, from another
 *    tenant, already removed) fails closed as NOT_FOUND before any mutation —
 *    the same discipline resend/revokeTeamInvitationCore use. update_membership_
 *    role in particular derives the tenant from the membership id and takes no
 *    tenant argument, so without this a stale page could act on another tenant.
 *  - a STALE-STATE check against what the page showed: suspend needs the member
 *    to still be active, restore needs suspended, and a role change needs the
 *    role the caller saw. The RPCs already refuse a wrong status
 *    (membership_not_active / membership_not_suspended); the role change has no
 *    expected-role parameter in the database, so its check is application-level
 *    and best-effort — a change landing between this read and the RPC is not
 *    detected. That is a lost update of one role value by an equally authorized
 *    caller, never a privilege problem, and is documented as a residual.
 *
 * Takes an already-authenticated client (like lib/modules/team/actions.ts's
 * ...Core functions) so tests can drive it with a real signed-in client.
 */

type AnySupabaseClient = SupabaseClient<Database>;

const memberTargetSchema = z.object({
  tenantId: z.string().uuid(),
  membershipId: z.string().uuid(),
});

const changeRoleSchema = memberTargetSchema.extend({
  newRoleId: z.string().uuid(),
  // The role the caller SAW. Needed for the stale check; never trusted for authority.
  expectedRoleId: z.string().uuid(),
});

export type MemberTargetInput = z.input<typeof memberTargetSchema>;
export type ChangeMemberRoleInput = z.input<typeof changeRoleSchema>;
export type MemberActionResultData = { membershipId: string };

type ListedMember = Database["public"]["Functions"]["list_team_members"]["Returns"][number];

async function lookupMember(
  supabase: AnySupabaseClient,
  tenantId: string,
  membershipId: string,
): Promise<{ member: ListedMember } | { failure: ActionResult<never> }> {
  const { data, error } = await supabase.rpc("list_team_members", { p_tenant_id: tenantId });
  if (error) return { failure: mapMemberManagementError(error) };
  const member = (data ?? []).find((row) => row.membership_id === membershipId);
  if (!member) return { failure: fail("NOT_FOUND", MEMBER_NOT_FOUND_MESSAGE) };
  return { member };
}

/** The refusals every action shares, in the order a person would hit them. */
function refuseIfNotManageable(member: ListedMember): ActionResult<never> | null {
  if (member.is_self) return fail("UNAUTHORIZED", MEMBER_SELF_ACTION_MESSAGE);
  if (!member.can_manage) return fail("UNAUTHORIZED", MEMBER_NOT_MANAGEABLE_MESSAGE);
  return null;
}

export async function suspendMemberCore(
  supabase: AnySupabaseClient,
  input: MemberTargetInput,
): Promise<ActionResult<MemberActionResultData>> {
  const parsed = memberTargetSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Geçersiz istek");

  const found = await lookupMember(supabase, parsed.data.tenantId, parsed.data.membershipId);
  if ("failure" in found) return found.failure;
  const refusal = refuseIfNotManageable(found.member);
  if (refusal) return refusal;
  if (found.member.status !== "active") return fail("CONFLICT", MEMBER_STATE_CHANGED_MESSAGE);

  const { error } = await supabase.rpc("suspend_membership", {
    p_tenant_id: parsed.data.tenantId,
    p_membership_id: parsed.data.membershipId,
  });
  if (error) return mapMemberManagementError(error);
  return ok({ membershipId: parsed.data.membershipId });
}

export async function reactivateMemberCore(
  supabase: AnySupabaseClient,
  input: MemberTargetInput,
): Promise<ActionResult<MemberActionResultData>> {
  const parsed = memberTargetSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Geçersiz istek");

  const found = await lookupMember(supabase, parsed.data.tenantId, parsed.data.membershipId);
  if ("failure" in found) return found.failure;
  const refusal = refuseIfNotManageable(found.member);
  if (refusal) return refusal;
  if (found.member.status !== "suspended") return fail("CONFLICT", MEMBER_STATE_CHANGED_MESSAGE);

  const { error } = await supabase.rpc("reactivate_membership", {
    p_tenant_id: parsed.data.tenantId,
    p_membership_id: parsed.data.membershipId,
  });
  if (error) return mapMemberManagementError(error);
  return ok({ membershipId: parsed.data.membershipId });
}

export async function removeMemberCore(
  supabase: AnySupabaseClient,
  input: MemberTargetInput,
): Promise<ActionResult<MemberActionResultData>> {
  const parsed = memberTargetSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Geçersiz istek");

  const found = await lookupMember(supabase, parsed.data.tenantId, parsed.data.membershipId);
  if ("failure" in found) return found.failure;
  const refusal = refuseIfNotManageable(found.member);
  if (refusal) return refusal;

  const { error } = await supabase.rpc("remove_membership_access", {
    p_tenant_id: parsed.data.tenantId,
    p_membership_id: parsed.data.membershipId,
  });
  if (error) return mapMemberManagementError(error);
  return ok({ membershipId: parsed.data.membershipId });
}

export async function changeMemberRoleCore(
  supabase: AnySupabaseClient,
  input: ChangeMemberRoleInput,
): Promise<ActionResult<MemberActionResultData>> {
  const parsed = changeRoleSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Geçersiz istek");

  const found = await lookupMember(supabase, parsed.data.tenantId, parsed.data.membershipId);
  if ("failure" in found) return found.failure;
  const refusal = refuseIfNotManageable(found.member);
  if (refusal) return refusal;
  if (found.member.role_id !== parsed.data.expectedRoleId) return fail("CONFLICT", MEMBER_STATE_CHANGED_MESSAGE);

  // Assigning the role the member already has is the RPC's own defined no-op
  // (success, no write, no audit row): deliberately NOT short-circuited here so
  // that behaviour stays the database's.
  const { error } = await supabase.rpc("update_membership_role", {
    p_membership_id: parsed.data.membershipId,
    p_new_role_id: parsed.data.newRoleId,
  });
  if (error) return mapMemberManagementError(error);
  return ok({ membershipId: parsed.data.membershipId });
}
