import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getStaffManagementDetails, getOneStaffManagementDetail } from "./management-details";

export type StaffListRow = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  branchNames: string[];
  serviceCount: number;
  hasSchedule: boolean;
  hasMembership: boolean;
  concurrentCapacity: number;
};

/** List view — one row per staff member, with just enough joined summary
 * data (branch names, service count) to render the list without a
 * separate round trip per row.
 *
 * Faz SAAS.1E.1: email/phone/tenant_membership_id are no longer selectable
 * columns on staff_members for a plain member (staff.view/staff.manage
 * required) — one get_staff_management_details call for the whole roster,
 * merged in below, instead of embedding them in this select. */
export async function getStaffList(tenantId: string): Promise<StaffListRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_members")
    .select(
      `id, full_name, status, concurrent_capacity,
       staff_branches(branches(name)),
       staff_services(service_id),
       staff_schedules(id)`,
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });

  if (error || !data) return [];

  const details = await getStaffManagementDetails(
    supabase,
    tenantId,
    data.map((r) => r.id),
  );

  return data.map((row) => {
    const detail = details.get(row.id);
    return {
      id: row.id,
      fullName: row.full_name,
      email: detail?.email ?? null,
      phone: detail?.phone ?? null,
      status: row.status,
      branchNames: row.staff_branches.map((b) => b.branches?.name).filter((n): n is string => !!n),
      serviceCount: row.staff_services.length,
      hasSchedule: row.staff_schedules.length > 0,
      hasMembership: (detail?.tenantMembershipId ?? null) !== null,
      concurrentCapacity: row.concurrent_capacity,
    };
  });
}

export type StaffDetail = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  tenantMembershipId: string | null;
  branchIds: string[];
  serviceIds: string[];
  concurrentCapacity: number;
};

/** Faz SAAS.1E.1: same split as getStaffList — the direct select carries
 * only the safe columns (tenant_id included, needed to call the RPC),
 * email/phone/tenant_membership_id come from get_staff_management_details. */
export async function getStaffDetail(staffMemberId: string): Promise<StaffDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_members")
    .select(
      `id, tenant_id, full_name, status, concurrent_capacity,
       staff_branches(branch_id),
       staff_services(service_id)`,
    )
    .eq("id", staffMemberId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !data) return null;

  const detail = await getOneStaffManagementDetail(supabase, data.tenant_id, data.id);

  return {
    id: data.id,
    fullName: data.full_name,
    email: detail?.email ?? null,
    phone: detail?.phone ?? null,
    status: data.status,
    tenantMembershipId: detail?.tenantMembershipId ?? null,
    branchIds: data.staff_branches.map((b) => b.branch_id),
    serviceIds: data.staff_services.map((s) => s.service_id),
    concurrentCapacity: data.concurrent_capacity,
  };
}

export type ScheduleRow = {
  id: string;
  weekday: number;
  branchId: string | null;
  startTime: string;
  endTime: string;
};

export type ExceptionRow = {
  id: string;
  exceptionDate: string;
  type: string;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
};

/** Faz SAAS.1E.1: staff_schedule_exceptions.reason is no longer a
 * selectable column for a plain member (same staff.view/staff.manage gate
 * as staff contact details) — fetched separately through
 * get_staff_exception_reasons and merged in by exception id. tenantId is
 * not a parameter of this function (nothing in the app calls it directly
 * today — the schedule tab has its own client-side query, see
 * staff-detail-sheet.tsx), so it is resolved from the staff row itself
 * (staff_members.tenant_id is an unrestricted column). */
export async function getStaffSchedule(
  staffMemberId: string,
): Promise<{ schedule: ScheduleRow[]; exceptions: ExceptionRow[] }> {
  const supabase = await createClient();
  const [scheduleRes, exceptionsRes, staffRes] = await Promise.all([
    supabase
      .from("staff_schedules")
      .select("id, weekday, branch_id, start_time, end_time")
      .eq("staff_member_id", staffMemberId)
      .is("deleted_at", null)
      .order("weekday", { ascending: true }),
    supabase
      .from("staff_schedule_exceptions")
      .select("id, exception_date, type, start_time, end_time")
      .eq("staff_member_id", staffMemberId)
      .is("deleted_at", null)
      .order("exception_date", { ascending: true }),
    supabase.from("staff_members").select("tenant_id").eq("id", staffMemberId).maybeSingle(),
  ]);

  const tenantId = staffRes.data?.tenant_id ?? null;
  const reasons = tenantId
    ? new Map(
        (
          (await supabase.rpc("get_staff_exception_reasons", { p_tenant_id: tenantId, p_staff_member_id: staffMemberId })).data ?? []
        ).map((r) => [r.exception_id, r.reason] as const),
      )
    : new Map<string, string | null>();

  return {
    schedule: (scheduleRes.data ?? []).map((r) => ({
      id: r.id,
      weekday: r.weekday,
      branchId: r.branch_id,
      startTime: r.start_time.slice(0, 5),
      endTime: r.end_time.slice(0, 5),
    })),
    exceptions: (exceptionsRes.data ?? []).map((r) => ({
      id: r.id,
      exceptionDate: r.exception_date,
      type: r.type,
      startTime: r.start_time?.slice(0, 5) ?? null,
      endTime: r.end_time?.slice(0, 5) ?? null,
      reason: reasons.get(r.id) ?? null,
    })),
  };
}

export type BranchOption = { id: string; name: string; isPrimary: boolean };

export async function getBranchOptions(tenantId: string): Promise<BranchOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("branches")
    .select("id, name, is_primary")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .order("name", { ascending: true });

  return (data ?? []).map((b) => ({ id: b.id, name: b.name, isPrimary: b.is_primary }));
}

export type ServiceOption = { id: string; name: string; category: string | null; status: string };

export async function getServiceOptions(tenantId: string): Promise<ServiceOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("services")
    .select("id, name, category, status")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("category", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });

  return data ?? [];
}

export type MembershipOption = { id: string; displayName: string; roleName: string };

/** Tenant memberships not yet linked to any staff record — the pool a new
 * staff member's optional login link can be chosen from. Excludes the
 * current staff member's own already-linked membership when editing (the
 * caller passes it back in as `excludeCurrentlyLinkedTo` so re-selecting
 * "no change" still shows their existing link as an option).
 *
 * Faz SAAS.1E.1: which staff rows are already linked now comes from
 * get_staff_management_details (staff_members.tenant_membership_id is a
 * restricted column) rather than a direct select; the tenant_memberships
 * read itself is unaffected (tenant_memberships_select_scoped grants a
 * staff.manage holder — which every caller of this screen already is —
 * every membership row of the tenant, same as before). */
export async function getAvailableMemberships(
  tenantId: string,
  excludeCurrentlyLinkedTo?: string | null,
): Promise<MembershipOption[]> {
  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("tenant_memberships")
    .select("id, user_id, roles!tenant_memberships_role_id_fkey(name)")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null);

  if (!memberships) return [];

  const details = await getStaffManagementDetails(supabase, tenantId);
  const linkedIds = new Set(
    Array.from(details.values())
      .map((d) => d.tenantMembershipId)
      .filter((id): id is string => id !== null),
  );

  const candidates = memberships.filter(
    (m) => !linkedIds.has(m.id) || m.id === excludeCurrentlyLinkedTo,
  );

  // auth.users (and its email) isn't reachable via PostgREST — profiles
  // (populated at signup, id = auth.users.id) is the only client-safe
  // source for a human-readable name here.
  const userIds = candidates.map((c) => c.user_id);
  const { data: profiles } = userIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", userIds)
    : { data: [] as { id: string; full_name: string | null }[] };

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  return candidates.map((m) => ({
    id: m.id,
    displayName: nameById.get(m.user_id) || "İsimsiz kullanıcı",
    roleName: m.roles?.name ?? "—",
  }));
}
