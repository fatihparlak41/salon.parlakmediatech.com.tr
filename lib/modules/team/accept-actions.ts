"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  clearPendingTeamInvitation,
  getPendingTeamInvitationToken,
} from "@/lib/auth/pending-team-invitation";
import {
  acceptInvitationFailure,
  acceptTeamInvitationCore,
  TERMINAL_ACCEPT_FAILURE_REASONS,
  type AcceptInvitationResult,
} from "./accept-invitation";

/**
 * Faz SAAS.1D.2 — the ONLY place an invitation is ever accepted from the
 * browser, and only via an explicit POST (the "Daveti Kabul Et" button).
 * Nothing that merely navigates — the token-capture GET in proxy.ts, the
 * auth callback, email confirmation, login — ever calls this or the RPC
 * behind it.
 *
 * Takes no token input at all: the raw token is read from the HttpOnly
 * cookie server-side, so an attacker submitting arbitrary form data can't
 * influence which invitation gets accepted, and the token never appears in
 * a form field, a client prop, an action argument, or an ActionResult.
 *
 * On success the cookie is cleared and the user is redirected straight
 * into the salon they just joined (the destination is resolved
 * server-side by acceptTeamInvitationCore, never taken from client
 * input). A double-click that races a second request past the first is
 * harmless: accept_team_invitation replays as already_accepted for the
 * same user, which is a success too.
 */
export async function acceptTeamInvitationAction(
  _prevState: AcceptInvitationResult | null,
): Promise<AcceptInvitationResult> {
  void _prevState;
  const user = await getCurrentUser();
  if (!user) {
    return acceptInvitationFailure("unauthenticated");
  }

  const token = await getPendingTeamInvitationToken();
  if (!token) {
    return acceptInvitationFailure("missing_token");
  }

  const supabase = await createClient();
  const result = await acceptTeamInvitationCore(supabase, token);

  if (result.success) {
    await clearPendingTeamInvitation();
    redirect(result.data.destination);
  }

  if (TERMINAL_ACCEPT_FAILURE_REASONS.has(result.error.reason)) {
    await clearPendingTeamInvitation();
  }
  return result;
}
