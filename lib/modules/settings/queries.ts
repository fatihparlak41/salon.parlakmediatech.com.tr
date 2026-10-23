import "server-only";
import { createClient } from "@/lib/supabase/server";

export type SelfServicePolicy = {
  cancellationEnabled: boolean;
  cancellationCutoffMinutes: number;
  rescheduleEnabled: boolean;
  rescheduleCutoffMinutes: number;
};

const DEFAULT_POLICY: SelfServicePolicy = {
  cancellationEnabled: false,
  cancellationCutoffMinutes: 0,
  rescheduleEnabled: false,
  rescheduleCutoffMinutes: 0,
};

/** Plain column read on tenants, gated by the existing tenants_select_member
 * RLS policy (any member can read) — the UPDATE side is what's actually
 * restricted to settings.manage (see lib/modules/settings/actions.ts). */
export async function getSelfServicePolicy(tenantId: string): Promise<SelfServicePolicy> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .select(
      "customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled, customer_reschedule_cutoff_minutes",
    )
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !data) return DEFAULT_POLICY;

  return {
    cancellationEnabled: data.customer_cancellation_enabled,
    cancellationCutoffMinutes: data.customer_cancellation_cutoff_minutes,
    rescheduleEnabled: data.customer_reschedule_enabled,
    rescheduleCutoffMinutes: data.customer_reschedule_cutoff_minutes,
  };
}

/** Reuses the existing public.has_feature RPC (20260815120010/20260903120000)
 * — the same function private.resolve_bookable_tenant and every public
 * booking entry point already check — so this reads exactly the value
 * that governs real bookability, never a separate/out-of-sync copy. A
 * failed call (network error, RPC missing) fails closed to false: never
 * claim online booking is on when we couldn't actually confirm it. */
export async function getOnlineBookingEnabled(tenantId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_feature", {
    p_tenant_id: tenantId,
    p_feature_key: "online_booking",
  });
  if (error || data === null) return false;
  return data;
}

/** Faz LAUNCH.1B — the four customer-notification switches of one salon (Owner
 * only: settings.manage is enforced INSIDE the RPC). Fails closed to "all off". */
export type CustomerNotificationSettings = {
  appointment_confirmation: boolean;
  appointment_update: boolean;
  appointment_cancellation: boolean;
  appointment_reminder_24h: boolean;
};

export const CUSTOMER_NOTIFICATION_SETTING_KEYS = [
  "appointment_confirmation",
  "appointment_update",
  "appointment_cancellation",
  "appointment_reminder_24h",
] as const;

export type CustomerNotificationSettingKey = (typeof CUSTOMER_NOTIFICATION_SETTING_KEYS)[number];

const ALL_OFF: CustomerNotificationSettings = {
  appointment_confirmation: false,
  appointment_update: false,
  appointment_cancellation: false,
  appointment_reminder_24h: false,
};

export function parseCustomerNotificationSettings(raw: unknown): CustomerNotificationSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ALL_OFF;
  const record = raw as Record<string, unknown>;
  return {
    appointment_confirmation: record.appointment_confirmation === true,
    appointment_update: record.appointment_update === true,
    appointment_cancellation: record.appointment_cancellation === true,
    appointment_reminder_24h: record.appointment_reminder_24h === true,
  };
}

export async function getCustomerNotificationSettings(tenantId: string): Promise<CustomerNotificationSettings> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_customer_notification_settings", { p_tenant_id: tenantId });
  if (error) return ALL_OFF;
  return parseCustomerNotificationSettings(data);
}

export type CustomerNotificationHealth = {
  windowDays: number;
  sent: number;
  failed: number;
  uncertain: number;
  waiting: number;
  skippedNoRecipient: number;
};

export function parseCustomerNotificationHealth(raw: unknown): CustomerNotificationHealth | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    windowDays: num(record.windowDays) || 14,
    sent: num(record.sent),
    failed: num(record.failed),
    uncertain: num(record.uncertain),
    waiting: num(record.waiting),
    skippedNoRecipient: num(record.skippedNoRecipient),
  };
}

/** PII-free delivery summary of the last 14 days (counts by outcome). null = unavailable. */
export async function getCustomerNotificationHealth(tenantId: string): Promise<CustomerNotificationHealth | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_customer_notification_health", { p_tenant_id: tenantId });
  if (error) return null;
  return parseCustomerNotificationHealth(data);
}
