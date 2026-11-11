/**
 * Faz SAAS.1C.1 - the billing READ model shapes and the small pure rules the UI derives from them. No server-only import (shared by server
 * pages and client components). Everything here DESCRIBES state: enforcement is OFF in 1C.1, so no function in this file decides that anything
 * may be refused. The access state itself is computed in the database (private.tenant_access_state_at); the UI never recomputes it.
 */

export const ACCESS_MODES = ["full", "grace", "read_only", "blocked"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const ACCESS_REASONS = [
  "no_subscription",
  "pilot",
  "internal",
  "complimentary",
  "trial_not_started",
  "trial_active",
  "trial_expired_grace",
  "trial_expired",
  "active",
  "cancel_scheduled",
  "renewal_overdue",
  "period_ended_canceled",
  "renewal_overdue_expired",
  "past_due",
  "past_due_expired",
  "canceled",
  "expired",
  "suspended_by_platform",
  "tenant_canceled",
  "tenant_deleted",
] as const;
export type AccessReason = (typeof ACCESS_REASONS)[number];

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled", "expired"] as const;
export const BILLING_MODES = ["paid", "complimentary", "internal", "pilot"] as const;

export type AccessState = {
  mode: AccessMode;
  reason: AccessReason;
  daysRemaining: number | null;
  trialEnding: boolean;
  status: string | null;
  billingMode: string | null;
  planKey: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  enforcementEnabled: boolean;
};

export type LimitState = "ok" | "at_limit" | "over";
export type LimitStatus = { key: string; used: number; limit: number; enforcement: "soft" | "hard"; state: LimitState };

export type Usage = {
  activeStaff: number;
  branches: number;
  services: number;
  customers: number;
  activeMembers: number;
  appointmentsTotal: number;
  appointmentsCreated30d: number;
  treatmentPhotos: number;
  treatmentPhotoBytes: number;
  emailsSent30d: number;
};

/** What a salon Owner / Yönetici may read about their OWN subscription (public.get_my_billing_summary). */
export type MyBillingSummary = {
  planKey: string;
  planName: string;
  accessState: AccessState;
  usage: Usage;
  limits: LimitStatus[];
};

export type AdminBillingRow = {
  tenantId: string;
  name: string;
  slug: string;
  tenantStatus: string;
  planKey: string | null;
  billingMode: string | null;
  status: string | null;
  accessMode: AccessMode;
  accessReason: AccessReason;
  daysRemaining: number | null;
  trialEnding: boolean;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  overLimit: boolean;
  atLimit: boolean;
  readyTrialNotStarted: boolean;
};

export type AdminBillingDashboard = {
  total: number;
  trialNotStarted: number;
  trialActive: number;
  trialEnding: number;
  grace: number;
  readOnly: number;
  blocked: number;
  paidActive: number;
  pilot: number;
  complimentary: number;
  internal: number;
  noSubscription: number;
  overLimit: number;
  readyTrialNotStarted: number;
  enforcementEnabled: boolean;
};

export type AdminBillingEvent = { at: string; type: string; fromStatus: string | null; toStatus: string | null; reason: string | null };

export type AdminTenantBilling = {
  tenantId: string;
  subscriptionPresent: boolean;
  planKey: string | null;
  planName: string | null;
  planPriceMonthly: string | number | null;
  accessState: AccessState;
  usage: Usage;
  limits: LimitStatus[];
  readyTrialNotStarted: boolean;
  events: AdminBillingEvent[];
};

export const BILLING_FILTERS = ["all", "trial", "trial_ending", "grace", "read_only", "paid", "pilot", "internal", "over_limit", "ready_not_started"] as const;
export type BillingFilter = (typeof BILLING_FILTERS)[number];

export function parseBillingFilter(raw: string | string[] | undefined): BillingFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (BILLING_FILTERS as readonly string[]).includes(v ?? "") ? (v as BillingFilter) : "all";
}

export type BillingNotice =
  | { kind: "trial_ending"; days: number }
  | { kind: "grace"; days: number }
  | { kind: "expired" };

/**
 * The informational notice a salon Owner / Yönetici sees. Only commercial reasons produce one: a salon suspended or removed by the platform
 * is not a billing matter and shows nothing here; pilot / internal / complimentary accounts never show a notice.
 */
export function billingNotice(state: AccessState | null | undefined): BillingNotice | null {
  if (!state) return null;
  if (state.mode === "full" && state.reason === "trial_active" && state.trialEnding) return { kind: "trial_ending", days: Math.max(1, state.daysRemaining ?? 1) };
  if (state.mode === "grace") return { kind: "grace", days: Math.max(1, state.daysRemaining ?? 1) };
  if (state.mode === "read_only") return { kind: "expired" };
  return null;
}

/** The soft active-staff limit as the salon sees it: a hint (never a refusal) once the plan's number is reached. */
export function staffLimitHint(limits: LimitStatus[] | null | undefined): { state: "at_limit" | "over"; used: number; limit: number } | null {
  const row = (limits ?? []).find((l) => l.key === "max_active_staff");
  if (!row || row.state === "ok") return null;
  return { state: row.state, used: row.used, limit: row.limit };
}

/** Tone for the access-state badge: neutral for normal, amber for time-limited, red only for states the platform set. */
export function accessTone(mode: AccessMode): "ok" | "warning" | "critical" {
  if (mode === "full") return "ok";
  if (mode === "grace") return "warning";
  return "critical";
}
