import "server-only";
import type { createClient } from "@/lib/supabase/server";
import {
  getTenantTodayRangeUtc,
  getTenantMonthRangeUtc,
} from "@/lib/modules/appointments/timezone";
import {
  CUSTOMER_NAME_FALLBACK,
  getAppointmentCustomerNames,
} from "@/lib/modules/appointments/customer-display";
import { getStaffLinkForMembership } from "@/lib/modules/staff/management-details";

/**
 * Faz DASHBOARD.1 — every query here is bounded to "today" or "this
 * month" in tenant-local time, never an unbounded history scan. No
 * dashboard-specific table, no cache, no denormalized metric store —
 * everything reads directly from the same tables the rest of the app
 * already reads (appointments, appointment_items, staff_members,
 * services, customers, tenant_memberships), so a number shown here can
 * never drift from what Calendar/Appointments/Staff/Customers show.
 *
 * Every function below takes an already-constructed Supabase client as
 * its first argument rather than calling lib/supabase/server's
 * createClient() internally. createClient() -> next/headers's cookies(),
 * which requires a real Next.js request scope and throws under plain
 * Vitest (confirmed the hard way — see tests/reports-staff-page.test.ts's
 * own header comment for the same constraint on lib/modules/reports/
 * queries.ts). Dependency-injecting the client instead means
 * app/[locale]/app/[tenantSlug]/page.tsx builds one real request-scoped
 * client via createClient() and passes it in, while tests pass in a
 * client from tests/helpers.ts's signInAs(user) — the exact same
 * functions run in both, so a test proves the real code path, not a
 * hand-duplicated stand-in for it.
 */

type DashboardSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type DashboardStaffRef = { id: string; fullName: string };

export type DashboardTodayAppointment = {
  id: string;
  status: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  customerName: string;
  serviceNames: string[];
  staff: DashboardStaffRef[];
};

type RawTodayRow = {
  id: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  appointment_items: {
    services: { name: string } | null;
    staff_members: { id: string; full_name: string } | null;
  }[];
};

export type DashboardTodayKpis = {
  total: number;
  pending: number;
  completed: number;
  cancelledOrNoShow: number;
};

/**
 * Pure — no fetch. "Pending" combines scheduled+confirmed+in_progress:
 * none of these three is itself the value users mean by "Bekleyen", but
 * all three real statuses share the same meaning for this card (not yet
 * at a terminal state). Cancelled and no-show are combined into one card
 * only because both real statuses exist and both mean "did not result
 * in a completed visit" — matches the KPI card set's own explicit
 * "İptal / Gelmedi" label.
 */
export function computeTodayKpis(
  rows: DashboardTodayAppointment[],
): DashboardTodayKpis {
  let pending = 0;
  let completed = 0;
  let cancelledOrNoShow = 0;
  for (const r of rows) {
    if (
      r.status === "scheduled" ||
      r.status === "confirmed" ||
      r.status === "in_progress"
    )
      pending++;
    else if (r.status === "completed") completed++;
    else if (r.status === "cancelled" || r.status === "no_show")
      cancelledOrNoShow++;
  }
  return { total: rows.length, pending, completed, cancelledOrNoShow };
}

export type NextAppointmentSelection = {
  inProgress: DashboardTodayAppointment | null;
  next: DashboardTodayAppointment | null;
};

/**
 * Faz DASHBOARD.1A — pure, no fetch. This is the ONE selector both
 * TodaySchedule (the real rendered "Sıradaki"/"Şu an" cards) and its own
 * regression tests call — never a second, hand-duplicated copy of this
 * logic in a test file.
 *
 * The bug this fixes: the original version only excluded cancelled/
 * no_show from "next", so a `completed` appointment whose
 * scheduled_start_at happened to still be >= now (a status corrected
 * early, a data entry made ahead of the actual visit, or simply this
 * function running seconds before a boundary appointment's own start
 * time) could be shown as the upcoming one. completed/cancelled/no_show
 * are now unconditionally excluded regardless of their own time —
 * "next" is restricted to scheduled/confirmed only, and only when still
 * upcoming. in_progress is surfaced as its own, separate "Şu an" result
 * — never folded into "next" itself, so the UI never mislabels an
 * appointment already underway as "Sıradaki".
 */
export function selectNextAppointment(
  rows: DashboardTodayAppointment[],
  nowIso: string,
): NextAppointmentSelection {
  const inProgress = rows.find((r) => r.status === "in_progress") ?? null;
  const next =
    rows.find(
      (r) =>
        (r.status === "scheduled" || r.status === "confirmed") &&
        r.scheduledStartAt >= nowIso,
    ) ?? null;
  return { inProgress, next };
}

/**
 * ONE bounded "today" fetch that serves the KPI counts, the "Bugünün
 * Takvimi" list, the "Sıradaki" highlight, AND the today-per-staff
 * count in "Bugünkü Personel" — all four derived in-memory from this
 * same array so they can never disagree with each other. Same shape
 * discipline as lib/modules/appointments/queries.ts's getAppointmentList
 * (which this deliberately does not reuse: that one carries branch_id/
 * branches(name), irrelevant here, and this needs staff_members.id, not
 * just its name, for accurate per-staff counting — a distinct enough
 * shape to warrant its own minimal SELECT rather than overloading the
 * shared one). No phone/email/notes are selected — nothing to redact,
 * the column is simply never read. The customer's display name comes
 * from get_appointment_customer_display (Faz SAAS.1E.1: appointments.view
 * is enough — no customers.view, no customers row read at all).
 */
export async function getTodayAppointments(
  client: DashboardSupabaseClient,
  tenantId: string,
  tenantTz: string,
): Promise<DashboardTodayAppointment[]> {
  const { startUtc, endUtc } = getTenantTodayRangeUtc(tenantTz);
  const { data, error } = await client
    .from("appointments")
    .select(
      `id, status, scheduled_start_at, scheduled_end_at,
       appointment_items(services(name), staff_members!appointment_items_staff_member_id_fkey(id, full_name))`,
    )
    .eq("tenant_id", tenantId)
    .gte("scheduled_start_at", startUtc)
    .lt("scheduled_start_at", endUtc)
    .order("scheduled_start_at", { ascending: true });

  if (error || !data) return [];

  const rows = data as unknown as RawTodayRow[];
  const customerNames = await getAppointmentCustomerNames(client, tenantId, rows.map((r) => r.id));

  return rows.map((r) => {
    const staffById = new Map<string, DashboardStaffRef>();
    for (const item of r.appointment_items) {
      if (item.staff_members)
        staffById.set(item.staff_members.id, {
          id: item.staff_members.id,
          fullName: item.staff_members.full_name,
        });
    }
    return {
      id: r.id,
      status: r.status,
      scheduledStartAt: r.scheduled_start_at,
      scheduledEndAt: r.scheduled_end_at,
      customerName: customerNames.get(r.id) ?? CUSTOMER_NAME_FALLBACK,
      serviceNames: Array.from(
        new Set(
          r.appointment_items
            .map((i) => i.services?.name)
            .filter((n): n is string => !!n),
        ),
      ),
      staff: Array.from(staffById.values()),
    };
  });
}

export type DashboardMonthSummary = {
  total: number;
  completed: number;
  cancelled: number;
  newCustomers: number;
};

/** This tenant-local calendar month, from appointments(status) + a
 * separate customers(created_at) count — two small bounded queries,
 * neither fetching more than one column of a month's worth of rows. */
export async function getMonthSummary(
  client: DashboardSupabaseClient,
  tenantId: string,
  tenantTz: string,
  todayLocal: string,
): Promise<DashboardMonthSummary> {
  const { startUtc, endUtc } = getTenantMonthRangeUtc(tenantTz, todayLocal);

  const [appointmentsRes, newCustomersRes] = await Promise.all([
    client
      .from("appointments")
      .select("status")
      .eq("tenant_id", tenantId)
      .gte("scheduled_start_at", startUtc)
      .lt("scheduled_start_at", endUtc),
    client
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", startUtc)
      .lt("created_at", endUtc),
  ]);

  const rows = appointmentsRes.data ?? [];
  return {
    total: rows.length,
    completed: rows.filter((r) => r.status === "completed").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    newCustomers: newCustomersRes.count ?? 0,
  };
}

export type DashboardActiveStaff = {
  id: string;
  fullName: string;
  hasSchedule: boolean;
};

/** Active, non-deleted staff only — reused by both "Bugünkü Personel"
 * (needs the roster to show staff with zero appointments too, not only
 * staff who happen to appear in today's appointment_items) and the
 * Attention section's "personelin çalışma programı eksik" check. */
export async function getActiveStaffRoster(
  client: DashboardSupabaseClient,
  tenantId: string,
): Promise<DashboardActiveStaff[]> {
  const { data, error } = await client
    .from("staff_members")
    .select("id, full_name, staff_schedules(id)")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("display_order", { ascending: true });

  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    hasSchedule: r.staff_schedules.length > 0,
  }));
}

export type DashboardSetupHealth = {
  onlineBookingEnabled: boolean;
  hasActiveService: boolean;
  hasActiveStaff: boolean;
  staffMissingSchedule: boolean;
};

/** Existence-only checks (head:true — no rows transferred) for the
 * Attention section, plus the active-staff roster's own hasSchedule
 * flags (already fetched for "Bugünkü Personel", passed in rather than
 * re-queried). */
export async function getSetupHealth(
  client: DashboardSupabaseClient,
  tenantId: string,
  onlineBookingEnabled: boolean,
  activeStaff: DashboardActiveStaff[],
): Promise<DashboardSetupHealth> {
  const { count: activeServiceCount } = await client
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null);

  return {
    onlineBookingEnabled,
    hasActiveService: (activeServiceCount ?? 0) > 0,
    hasActiveStaff: activeStaff.length > 0,
    staffMissingSchedule: activeStaff.some((s) => !s.hasSchedule),
  };
}

/** The current user's own ACTIVE membership id in this tenant — distinct
 * from getTenantAccess's return (which only carries roleName, not the
 * membership row id), needed here solely to find whether staff_members.
 * tenant_membership_id points back at this exact user. */
export async function getMyMembershipId(
  client: DashboardSupabaseClient,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const { data } = await client
    .from("tenant_memberships")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();
  return data?.id ?? null;
}

/** The active, non-deleted staff_members row (if any) linked to this
 * membership — "staff-linked" for Faz DASHBOARD.1 section 14 means
 * exactly this, nothing looser.
 *
 * Faz SAAS.1E.1: staff_members.tenant_membership_id is no longer a
 * selectable/filterable column directly (staff.view/staff.manage
 * required) — get_staff_link_for_membership is the DB-authoritative
 * replacement: free for the CALLER's own membership id (self-information,
 * no permission needed — every call site here passes the caller's own,
 * from getMyMembershipId), staff.view/staff.manage required for anyone
 * else's. */
export async function getStaffLinkByMembership(
  client: DashboardSupabaseClient,
  tenantId: string,
  membershipId: string,
): Promise<DashboardStaffRef | null> {
  return getStaffLinkForMembership(client, tenantId, membershipId);
}

/** profiles.full_name for the greeting — first token only (a person's
 * given name), never the raw email. Returns null (not a placeholder
 * string) when there is genuinely nothing to show, so the caller can
 * fall back to the generic "Bugünün özeti" heading exactly as specified. */
export async function getMyFirstName(
  client: DashboardSupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await client
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();
  const full = data?.full_name?.trim();
  if (!full) return null;
  return full.split(/\s+/)[0] ?? null;
}

/** Today's tenant-local working-hours window for one staff member, if
 * any (a staff member can have zero, one, or more schedule rows for a
 * given weekday across branches — this shows the widest span rather
 * than picking one arbitrarily, since the personal dashboard has no
 * branch context of its own to disambiguate by). Optional section 14
 * data only — never used for availability logic, purely display. */
export async function getMyTodayWorkingHours(
  client: DashboardSupabaseClient,
  staffMemberId: string,
  weekday: number,
): Promise<{ startTime: string; endTime: string } | null> {
  const { data } = await client
    .from("staff_schedules")
    .select("start_time, end_time")
    .eq("staff_member_id", staffMemberId)
    .eq("weekday", weekday)
    .is("deleted_at", null);

  if (!data || data.length === 0) return null;
  const startTime = data.map((r) => r.start_time).sort()[0]!;
  const endTime = data
    .map((r) => r.end_time)
    .sort()
    .at(-1)!;
  return { startTime, endTime };
}
