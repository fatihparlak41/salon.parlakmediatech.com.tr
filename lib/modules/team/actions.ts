"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/errors";
import {
  createTeamInvitationCore,
  resendTeamInvitationCore,
  revokeTeamInvitationCore,
  type CreateTeamInvitationInput,
  type CreateTeamInvitationResultData,
  type ResendTeamInvitationInput,
  type ResendTeamInvitationResultData,
  type RevokeTeamInvitationInput,
  type RevokeTeamInvitationResultData,
} from "./invitation-core";

/**
 * SEC.1A - the ONLY callable surface of the team invitation flow. Each wrapper takes nothing but form-shaped input: the signed-in user comes from the
 * request session (requireUser) and the Supabase client is the cookie-bound client of THAT session, so every RPC runs under the caller's own JWT and
 * the database (auth.uid(), permission keys, tenant membership, permission ceiling) stays the sole authority. The orchestration (RPCs, e-mail, audit)
 * is in ./invitation-core.ts, which has no "use server" directive and therefore no HTTP entry point of its own.
 * Types are re-exported type-only (erased at build time, so they add no runtime export to this module).
 */
export type {
  CreateTeamInvitationInput,
  CreateTeamInvitationResultData,
  ResendTeamInvitationInput,
  ResendTeamInvitationResultData,
  RevokeTeamInvitationInput,
  RevokeTeamInvitationResultData,
};

export async function createTeamInvitationAction(
  _prevState: ActionResult<CreateTeamInvitationResultData> | null,
  input: CreateTeamInvitationInput & { tenantSlug: string },
): Promise<ActionResult<CreateTeamInvitationResultData>> {
  const user = await requireUser();
  const supabase = await createClient();
  const result = await createTeamInvitationCore(supabase, user.id, input);
  if (result.success) {
    revalidatePath(`/app/${input.tenantSlug}/team`);
  }
  return result;
}

export async function resendTeamInvitationAction(
  _prevState: ActionResult<ResendTeamInvitationResultData> | null,
  input: ResendTeamInvitationInput & { tenantSlug: string },
): Promise<ActionResult<ResendTeamInvitationResultData>> {
  const user = await requireUser();
  const supabase = await createClient();
  const result = await resendTeamInvitationCore(supabase, user.id, input);
  if (result.success) {
    revalidatePath(`/app/${input.tenantSlug}/team`);
  }
  return result;
}

export async function revokeTeamInvitationAction(
  _prevState: ActionResult<RevokeTeamInvitationResultData> | null,
  input: RevokeTeamInvitationInput & { tenantSlug: string },
): Promise<ActionResult<RevokeTeamInvitationResultData>> {
  await requireUser();
  const supabase = await createClient();
  const result = await revokeTeamInvitationCore(supabase, input);
  if (result.success) {
    revalidatePath(`/app/${input.tenantSlug}/team`);
  }
  return result;
}
