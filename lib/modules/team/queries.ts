import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

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

export type TeamMemberRow = {
  membershipId: string;
  userId: string;
  displayName: string;
  roleName: string;
  status: string;
  linkedStaffName: string | null;
};

/** auth.users (and its email) isn't reachable via PostgREST — profiles is
 * the only client-safe source for a human-readable name, and it carries
 * no email column at all (confirmed against database.types.ts). Email is
 * therefore never shown for an existing member, only ever for a pending
 * invitation (team_invitations.email, via getTeamInvitations below) —
 * this is a real product gap, not an oversight, and is called out in the
 * phase report rather than worked around with an unsafe query. */
export async function getTeamMembers(supabase: AnySupabaseClient, tenantId: string): Promise<TeamMemberRow[]> {
  const { data: memberships } = await supabase
    .from("tenant_memberships")
    .select("id, user_id, status, roles!tenant_memberships_role_id_fkey(name)")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (!memberships) return [];

  const userIds = memberships.map((m) => m.user_id);
  const { data: profiles } = userIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", userIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  const { data: linkedStaff } = await supabase
    .from("staff_members")
    .select("tenant_membership_id, full_name")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .not("tenant_membership_id", "is", null);
  const staffNameByMembershipId = new Map(
    (linkedStaff ?? []).map((s) => [s.tenant_membership_id as string, s.full_name]),
  );

  return memberships
    .filter((m): m is typeof m & { roles: { name: string } } => m.roles !== null)
    .map((m) => ({
      membershipId: m.id,
      userId: m.user_id,
      displayName: nameById.get(m.user_id) || "İsimsiz kullanıcı",
      roleName: m.roles.name,
      status: m.status,
      linkedStaffName: staffNameByMembershipId.get(m.id) ?? null,
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
  const { data } = await supabase
    .from("staff_members")
    .select("id, full_name")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .is("tenant_membership_id", null)
    .order("full_name", { ascending: true });

  return (data ?? []).map((s) => ({ id: s.id, fullName: s.full_name }));
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
