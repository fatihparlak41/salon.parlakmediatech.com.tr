import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Faz SAAS.1B — the Super Admin READ layer. Everything here goes through the four platform-admin-gated SECURITY DEFINER functions
 * (public.admin_dashboard_summary / admin_list_tenants / admin_tenant_detail / admin_tenant_audit) with the CALLER's own authenticated
 * client. There is no service-role client, no table read and no write in this module: the widening of access lives inside the database
 * functions, each of which refuses everyone who is not an active platform admin. The page-level guard (requirePlatformAdmin) is only the
 * UX layer on top, exactly as for every other guard in lib/auth/session.ts.
 *
 * Takes an already-authenticated client as its first parameter (like lib/modules/team/queries.ts) so it can be tested without a request.
 */

type Client = SupabaseClient<Database>;

export type AdminFailure = "forbidden" | "not_found" | "error";
export type AdminResult<T> = { ok: true; data: T } | { ok: false; reason: AdminFailure };

export const LIFECYCLES = ["setup", "active", "inactive", "suspended", "canceled"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export type HealthLevel = "critical" | "warning" | "info" | "ok";
export type HealthSignal = { severity: "critical" | "warning" | "info"; code: string };

export const LIST_FILTERS = ["all", "active", "setup", "inactive", "suspended", "booking_on", "booking_off", "new", "quiet", "attention"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];
export const LIST_SORTS = ["created_desc", "created_asc", "name_asc", "activity_desc", "attention_desc"] as const;
export type ListSort = (typeof LIST_SORTS)[number];
export const PAGE_SIZE = 25;

export type ListParams = { search: string; filter: ListFilter; sort: ListSort; page: number };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Turns raw search params into a valid, bounded request. Anything unknown falls back to the default; nothing is trusted. */
export function parseListParams(raw: Record<string, string | string[] | undefined>): ListParams {
  const search = (first(raw.q) ?? "").trim().slice(0, 100);
  const filterRaw = first(raw.filter);
  const sortRaw = first(raw.sort);
  const pageRaw = Number.parseInt(first(raw.page) ?? "1", 10);
  return {
    search,
    filter: (LIST_FILTERS as readonly string[]).includes(filterRaw ?? "") ? (filterRaw as ListFilter) : "all",
    sort: (LIST_SORTS as readonly string[]).includes(sortRaw ?? "") ? (sortRaw as ListSort) : "created_desc",
    page: Number.isFinite(pageRaw) && pageRaw >= 1 && pageRaw <= 10000 ? pageRaw : 1,
  };
}

/** Maps the database functions' own refusals onto a small result: a non-admin is "forbidden", an unknown salon "not_found". */
export function mapAdminError(error: { message?: string; code?: string } | null): AdminFailure {
  const message = error?.message ?? "";
  if (/platform admin required|authentication required|permission denied/i.test(message) || error?.code === "42501") return "forbidden";
  if (/tenant not found/i.test(message)) return "not_found";
  return "error";
}

// ---------------------------------------------------------------------------------------------------------------------
// Shapes (mirroring the jsonb the functions return)
// ---------------------------------------------------------------------------------------------------------------------

export type AdminDashboard = {
  salonsTotal: number;
  lifecycle: Record<Lifecycle, number>;
  bookingActive: number;
  ownersTotal: number;
  usersTotal: number;
  staffTotal: number;
  appointmentsToday: number;
  appointments7d: number;
  health: { critical: number; warning: number };
  recentlyCreated: { tenantId: string; name: string; slug: string; createdAt: string; lifecycle: Lifecycle }[];
  needsAttention: { tenantId: string; name: string; slug: string; healthLevel: HealthLevel; health: HealthSignal[] }[];
};

export type AdminSalonRow = {
  tenantId: string;
  name: string;
  slug: string;
  accountStatus: string;
  lifecycle: Lifecycle;
  setupComplete: boolean;
  bookingEnabled: boolean;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerCount: number;
  staffCount: number;
  serviceCount: number;
  customerCount: number;
  appointmentCount: number;
  createdAt: string;
  lastActivityAt: string | null;
  healthLevel: HealthLevel;
  health: HealthSignal[];
};

export type AdminSalonList = { rows: AdminSalonRow[]; total: number; page: number; pageSize: number };

export type AdminOwner = { name: string | null; email: string | null; phone: string | null; status: string; lastSignInAt: string | null; staffLinked: boolean };
export type AdminMember = {
  membershipId: string;
  displayName: string | null;
  email: string | null;
  roleName: string;
  isOwner: boolean;
  status: string;
  linkedStaffName: string | null;
  lastSignInAt: string | null;
  since: string;
};

export type AdminSalonDetail = {
  overview: {
    tenantId: string;
    name: string;
    slug: string;
    accountStatus: string;
    lifecycle: Lifecycle;
    timezone: string;
    currency: string;
    createdAt: string;
    trialEndsAt: string | null;
    bookingPath: string;
    setupComplete: boolean;
    readyForBooking: boolean;
    steps: { key: string; done: boolean }[];
    blockers: string[];
    profileMissing: string[];
    subscriptionStatus: string | null;
  };
  owners: AdminOwner[];
  members: AdminMember[];
  usage: {
    staff: number;
    members: number;
    services: number;
    customers: number;
    appointments: number;
    appointmentsToday: number;
    appointments7d: number;
    treatmentPhotos: number;
    commissionRules: number;
    pendingInvitations: number;
  };
  booking: {
    publicBookingEnabled: boolean;
    bookingEngineReady: boolean;
    engineBlockers: string[];
    staffWithHours: number;
    activeStaff: number;
    bookablePaths: number;
    directBookableServices: number;
    inquiryServices: number;
    firstAvailableSlotAt: string | null;
  };
  system: {
    lastActivityAt: string | null;
    ownersNeverSignedIn: boolean;
    oldestPendingInvitationAt: string | null;
    healthLevel: HealthLevel;
    health: HealthSignal[];
  };
};

export type AdminAuditEvent = { occurredAt: string; action: string; entityType: string; actorType: string };

// ---------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------

export async function getAdminDashboard(supabase: Client): Promise<AdminResult<AdminDashboard>> {
  const { data, error } = await supabase.rpc("admin_dashboard_summary");
  if (error || !data) return { ok: false, reason: mapAdminError(error) };
  return { ok: true, data: data as unknown as AdminDashboard };
}

export async function getAdminSalonList(supabase: Client, params: ListParams): Promise<AdminResult<AdminSalonList>> {
  const { data, error } = await supabase.rpc("admin_list_tenants", {
    p_search: params.search || undefined,
    p_filter: params.filter,
    p_sort: params.sort,
    p_limit: PAGE_SIZE,
    p_offset: (params.page - 1) * PAGE_SIZE,
  });
  if (error || !data) return { ok: false, reason: mapAdminError(error) };
  const rows: AdminSalonRow[] = data.map((r) => ({
    tenantId: r.tenant_id,
    name: r.name,
    slug: r.slug,
    accountStatus: r.account_status,
    lifecycle: r.lifecycle as Lifecycle,
    setupComplete: r.setup_complete,
    bookingEnabled: r.booking_enabled,
    ownerName: r.primary_owner_name || null,
    ownerEmail: r.primary_owner_email || null,
    ownerCount: r.owner_count,
    staffCount: r.staff_count,
    serviceCount: r.service_count,
    customerCount: r.customer_count,
    appointmentCount: r.appointment_count,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at || null,
    healthLevel: r.health_level as HealthLevel,
    health: (r.health ?? []) as unknown as HealthSignal[],
  }));
  return { ok: true, data: { rows, total: data.length > 0 ? Number(data[0]!.total_count) : 0, page: params.page, pageSize: PAGE_SIZE } };
}

export async function getAdminSalonDetail(supabase: Client, tenantId: string): Promise<AdminResult<AdminSalonDetail>> {
  const { data, error } = await supabase.rpc("admin_tenant_detail", { p_tenant_id: tenantId });
  if (error || !data) return { ok: false, reason: mapAdminError(error) };
  return { ok: true, data: data as unknown as AdminSalonDetail };
}

export async function getAdminSalonAudit(supabase: Client, tenantId: string, limit = 50): Promise<AdminResult<AdminAuditEvent[]>> {
  const { data, error } = await supabase.rpc("admin_tenant_audit", { p_tenant_id: tenantId, p_limit: limit });
  if (error || !data) return { ok: false, reason: mapAdminError(error) };
  return { ok: true, data: data.map((r) => ({ occurredAt: r.occurred_at, action: r.action, entityType: r.entity_type, actorType: r.actor_type })) };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
