import { z } from "zod";

export const createTeamInvitationSchema = z.object({
  tenantId: z.string().uuid(),
  email: z.string().trim().email("Geçerli bir e-posta girin"),
  roleId: z.string().uuid(),
  staffMemberId: z.string().uuid().optional(),
});

export const resendTeamInvitationSchema = z.object({
  // Not part of resend_team_invitation's own RPC input (it only takes
  // p_invitation_id, deriving tenant/permission checks itself) — needed
  // here purely to scope this action's own presentation-data lookup
  // (list_team_invitations) after a successful resend, since
  // team_invitations itself carries zero authenticated/anon grants and
  // resend_team_invitation's RETURNS TABLE doesn't include tenant_id.
  // The future team-management page this action serves is already
  // tenant-scoped (/app/[tenantSlug]/...), so this is always readily
  // available to the caller, matching how every other action in this
  // codebase takes tenant context explicitly.
  tenantId: z.string().uuid(),
  invitationId: z.string().uuid(),
});

export const revokeTeamInvitationSchema = z.object({
  // Same reasoning as resendTeamInvitationSchema above: revoke_team_invitation
  // itself only takes p_invitation_id and derives its own tenant/permission
  // checks, but the Team page's own prelookup (proving the invitation
  // belongs to the tenant currently being viewed, not just one the caller
  // happens to hold staff.manage in) needs tenantId explicitly.
  tenantId: z.string().uuid(),
  invitationId: z.string().uuid(),
});
