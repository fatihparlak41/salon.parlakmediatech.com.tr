import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/supabase/database.types";
import { fail, ok, type ActionResult } from "@/lib/errors";
import {
  MEMBER_NOT_FOUND_MESSAGE,
  MEMBER_STATE_CHANGED_MESSAGE,
  mapMemberManagementError,
} from "./helpers";

/**
 * Faz SAAS.1A — the Owner-facing account ACCESS actions on a team member: suspend (deactivate), reactivate and
 * remove. Nothing here is a business entity: the member's appointments, payments, commission and treatment history
 * hang off staff and customer rows, never off the login, and none of the three RPCs touches them (suspend changes one
 * status column; remove soft-deletes the membership and unlinks — never deletes — the staff row).
 *
 * NOTHING HERE DECIDES WHO MAY DO WHAT. The three mutations are the SAAS.1E.0 RPCs (suspend_membership,
 * reactivate_membership, remove_membership_access), which take the tenant row lock, judge authority on EFFECTIVE
 * permissions, forbid acting on yourself, assert the tenant still has an unrestricted holder (the last Owner can never
 * be suspended or removed — by themself or by anyone else) and write exactly one audit row per real change (none for a
 * refusal). Every RPC error is mapped as-is; no check is re-implemented or second-guessed.
 *
 * What these functions add, all of it about not acting on the wrong row:
 *  - a PRELOOKUP through list_team_members for the tenant the caller named. A membership id that is not in that
 *    tenant's list (forged, from another tenant, already removed) fails closed as NOT_FOUND before any mutation — the
 *    same discipline resend/revokeTeamInvitationCore use;
 *  - a STALE-STATE check against what the page showed: suspend needs the member to still be active, reactivate needs
 *    suspended. The RPCs already refuse a wrong status (membership_not_active / membership_not_suspended); this just
 *    answers without a mutation attempt.
 *
 * Takes an already-authenticated client (like lib/modules/team/actions.ts's ...Core functions) so tests can drive it
 * with a real signed-in client.
 */

type AnySupabaseClient = SupabaseClient<Database>;

const memberTargetSchema = z.object({
  tenantId: z.string().uuid(),
  membershipId: z.string().uuid(),
});

export type MemberTargetInput = z.input<typeof memberTargetSchema>;
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

export async function suspendMemberCore(
  supabase: AnySupabaseClient,
  input: MemberTargetInput,
): Promise<ActionResult<MemberActionResultData>> {
  const parsed = memberTargetSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Geçersiz istek");

  const found = await lookupMember(supabase, parsed.data.tenantId, parsed.data.membershipId);
  if ("failure" in found) return found.failure;
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

  const { error } = await supabase.rpc("remove_membership_access", {
    p_tenant_id: parsed.data.tenantId,
    p_membership_id: parsed.data.membershipId,
  });
  if (error) return mapMemberManagementError(error);
  return ok({ membershipId: parsed.data.membershipId });
}
