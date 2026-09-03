import "server-only";
import { createClient } from "@/lib/supabase/server";

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
 * separate round trip per row. */
export async function getStaffList(tenantId: string): Promise<StaffListRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_members")
    .select(
      `id, full_name, email, phone, status, tenant_membership_id, concurrent_capacity,
       staff_branches(branches(name)),
       staff_services(service_id),
       staff_schedules(id)`,
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    branchNames: row.staff_branches.map((b) => b.branches?.name).filter((n): n is string => !!n),
    serviceCount: row.staff_services.length,
    hasSchedule: row.staff_schedules.length > 0,
    hasMembership: row.tenant_membership_id !== null,
    concurrentCapacity: row.concurrent_capacity,
  }));
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

export async function getStaffDetail(staffMemberId: string): Promise<StaffDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_members")
    .select(
      `id, full_name, email, phone, status, tenant_membership_id, concurrent_capacity,
       staff_branches(branch_id),
       staff_services(service_id)`,
    )
    .eq("id", staffMemberId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    fullName: data.full_name,
    email: data.email,
    phone: data.phone,
    status: data.status,
    tenantMembershipId: data.tenant_membership_id,
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

export async function getStaffSchedule(
  staffMemberId: string,
): Promise<{ schedule: ScheduleRow[]; exceptions: ExceptionRow[] }> {
  const supabase = await createClient();
  const [scheduleRes, exceptionsRes] = await Promise.all([
    supabase
      .from("staff_schedules")
      .select("id, weekday, branch_id, start_time, end_time")
      .eq("staff_member_id", staffMemberId)
      .is("deleted_at", null)
      .order("weekday", { ascending: true }),
    supabase
      .from("staff_schedule_exceptions")
      .select("id, exception_date, type, start_time, end_time, reason")
      .eq("staff_member_id", staffMemberId)
      .is("deleted_at", null)
      .order("exception_date", { ascending: true }),
  ]);

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
      reason: r.reason,
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
 * "no change" still shows their existing link as an option). */
export async function getAvailableMemberships(
  tenantId: string,
  excludeCurrentlyLinkedTo?: string | null,
): Promise<MembershipOption[]> {
  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("tenant_memberships")
    .select("id, user_id, roles(name)")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null);

  if (!memberships) return [];

  const { data: linkedStaff } = await supabase
    .from("staff_members")
    .select("tenant_membership_id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .not("tenant_membership_id", "is", null);

  const linkedIds = new Set((linkedStaff ?? []).map((s) => s.tenant_membership_id));

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
