"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/errors";
import {
  reactivateMemberCore,
  removeMemberCore,
  suspendMemberCore,
  type MemberActionResultData,
  type MemberTargetInput,
} from "./member-management";

/**
 * Faz SAAS.1A — thin "use server" wrappers around the member-management Core functions (the same Core/wrapper
 * split as lib/modules/team/actions.ts): the signed-in user and the cookie-bound client come from the request here,
 * and all logic lives in member-management.ts where it can be tested with a real signed-in client. `tenantSlug` is
 * used ONLY to refresh the Team page and is checked for shape first — it is client-supplied and never an authority.
 */

const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function refreshTeamPage(tenantSlug: string) {
  if (typeof tenantSlug === "string" && tenantSlug.length <= 63 && SLUG_SHAPE.test(tenantSlug)) {
    revalidatePath(`/app/${tenantSlug}/team`);
  }
}

type WithSlug<T> = T & { tenantSlug: string };

export async function suspendMemberAction(
  _prevState: ActionResult<MemberActionResultData> | null,
  input: WithSlug<MemberTargetInput>,
): Promise<ActionResult<MemberActionResultData>> {
  await requireUser();
  const supabase = await createClient();
  const result = await suspendMemberCore(supabase, input);
  if (result.success) refreshTeamPage(input.tenantSlug);
  return result;
}

export async function reactivateMemberAction(
  _prevState: ActionResult<MemberActionResultData> | null,
  input: WithSlug<MemberTargetInput>,
): Promise<ActionResult<MemberActionResultData>> {
  await requireUser();
  const supabase = await createClient();
  const result = await reactivateMemberCore(supabase, input);
  if (result.success) refreshTeamPage(input.tenantSlug);
  return result;
}

export async function removeMemberAction(
  _prevState: ActionResult<MemberActionResultData> | null,
  input: WithSlug<MemberTargetInput>,
): Promise<ActionResult<MemberActionResultData>> {
  await requireUser();
  const supabase = await createClient();
  const result = await removeMemberCore(supabase, input);
  if (result.success) refreshTeamPage(input.tenantSlug);
  return result;
}
