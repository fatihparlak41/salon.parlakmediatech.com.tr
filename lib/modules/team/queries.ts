import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getStaffManagementDetails } from "@/lib/modules/staff/management-details";

/**
 * Faz SAAS.1D.1 — tenant-scoped, authenticated-client-only reads for the
 * Team Management page. Never service_role. Mirrors the established
 * two-query-then-correlate-in-app-code shape already used by
 * lib/modules/staff/queries.ts's getAvailableMemberships (a reverse
 * staff_members -> tenant_memberships embed was considered and rejected —
 * PostgREST's to-one/to-many inference for the underlying PARTIAL unique
 * index on staff_members.tenant_membership_id, see 20260819052317, is
 * less proven in this codebase than this already-tested two-query
 * pattern).
 *
 * tenant_membership !== staff_member: a membership row is a login+role, a
 * staff_member row is a schedulable business entity. Every type below
 * keeps them visibly distinct (a membership's own display name comes only
 * from profiles.full_name; a linked staff_member's name is a separate,
 * optional field) rather than merging them into one blended "person" row.
 *
 * Deliberately takes an already-authenticated client as its first
 * parameter, unlike lib/modules/staff/queries.ts's own createClient()-
 * per-call shape: createClient() reads next/headers cookies, which only
 * exist inside a real Next.js request and throws ("cookies was called
 * outside a request scope") under Vitest's node environment — confirmed
 * that's exactly why lib/modules/staff/queries.ts has zero direct tests
 * anywhere in this suite. The Team page's own tenant-isolation and
 * privacy requirements (Faz SAAS.1D.1's own test matrix) need these
 * functions directly testable with a REAL signed-in client, so they
 * follow the same client-as-parameter shape already established for
 * lib/modules/team/actions.ts's ...Core functions instead. The page
 * itself creates one client and passes it to all four.
 */

type AnySupabaseClient = SupabaseClient<Database>;

/** Faz SAAS.1A — one row of the Team member list. Deliberately has NO auth user id: the opaque membership id is the
 * handle the mutation RPCs take, and everything else is what a person reads (name, e-mail, role, state). The can*
 * flags are the database's own ADVISORY answer to "may this caller do that to this member?" so the page shows only
 * controls that can work; the RPCs behind them remain the enforcement point. */
export type TeamMemberRow = {
  membershipId: string;
  displayName: string;
  /** Null only when the account has no e-mail address on record. */
  email: string | null;
  roleId: string;
  roleName: string;
  status: "active" | "suspended";
  isSelf: boolean;
  linkedStaffName: string | null;
  isLastUnrestrictedHolder: boolean;
  canSuspend: boolean;
  canReactivate: boolean;
  canRemove: boolean;
};

/** Always through list_team_members (Faz SAAS.1A): a staff.manage-gated SECURITY DEFINER read model that returns the
 * suspended members too and each member's e-mail (auth.users is not reachable through PostgREST), and never an auth
 * user id. A failed read returns an empty list rather than throwing, like every other read on this page. */
export async function getTeamMembers(supabase: AnySupabaseClient, tenantId: string): Promise<TeamMemberRow[]> {
  const { data, error } = await supabase.rpc("list_team_members", { p_tenant_id: tenantId });
  if (error || !data) return [];

  return data.map((row) => ({
    membershipId: row.membership_id,
    displayName: row.display_name || "İsimsiz kullanıcı",
    email: row.email || null,
    roleId: row.role_id,
    roleName: row.role_name,
    status: row.status === "suspended" ? "suspended" : "active",
    isSelf: row.is_self,
    linkedStaffName: row.linked_staff_name,
    isLastUnrestrictedHolder: row.is_last_unrestricted_holder,
    canSuspend: row.can_suspend,
    canReactivate: row.can_reactivate,
    canRemove: row.can_remove,
  }));
}

export type TeamInvitationRow = {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  staffMemberId: string | null;
  staffMemberName: string | null;
  status: string;
  effectiveStatus: string;
  expiresAt: string;
  createdAt: string;
  invitedByName: string | null;
};

/** Always through list_team_invitations — team_invitations itself carries
 * zero authenticated/anon grants (SAAS.1C.1), and the RPC's own
 * effective_status column is what a stale-but-not-yet-swept pending row
 * should display as, not the raw persisted status. Never returns a
 * token, token_hash, or acceptUrl — confirmed against the RPC's own
 * RETURNS TABLE shape, which has no such column to begin with. */
export async function getTeamInvitations(
  supabase: AnySupabaseClient,
  tenantId: string,
): Promise<TeamInvitationRow[]> {
  const { data, error } = await supabase.rpc("list_team_invitations", { p_tenant_id: tenantId });
  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    email: row.email,
    roleId: row.role_id,
    roleName: row.role_name,
    staffMemberId: row.staff_member_id,
    staffMemberName: row.staff_member_name,
    status: row.status,
    effectiveStatus: row.effective_status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    invitedByName: row.invited_by_name,
  }));
}

export type EligibleStaffOption = { id: string; fullName: string };

/** Tenant staff not yet linked to any membership — the pool a new
 * invitation's optional staff link may choose from. The page itself
 * additionally excludes any staff member already targeted by a pending
 * invitation (computed from the already-fetched invitations list, not a
 * second query) so the same person can't be double-invited. */
export async function getEligibleStaffForLinking(
  supabase: AnySupabaseClient,
  tenantId: string,
): Promise<EligibleStaffOption[]> {
  // Faz SAAS.1E.1: tenant_membership_id is no longer a selectable/filterable
  // column directly — fetch the roster (safe columns) and the link state
  // (get_staff_management_details) separately, then filter to unlinked.
  const [staffRes, details] = await Promise.all([
    supabase.from("staff_members").select("id, full_name").eq("tenant_id", tenantId).is("deleted_at", null).order("full_name", { ascending: true }),
    getStaffManagementDetails(supabase, tenantId),
  ]);

  return (staffRes.data ?? [])
    .filter((s) => (details.get(s.id)?.tenantMembershipId ?? null) === null)
    .map((s) => ({ id: s.id, fullName: s.full_name }));
}

export type RoleOption = { id: string; name: string };

/** Every active tenant role, shown by name only — never a permission key.
 * The create/resend RPCs' own permission-ceiling check remains the real
 * authorization boundary; this list is presentation only, and a role the
 * caller can't actually grant is rejected server-side with a clean
 * authorization message (mapCreateInvitationError), not filtered out
 * here. */
export async function getTenantRoleOptions(supabase: AnySupabaseClient, tenantId: string): Promise<RoleOption[]> {
  const { data } = await supabase
    .from("roles")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("name", { ascending: true });

  return data ?? [];
}
