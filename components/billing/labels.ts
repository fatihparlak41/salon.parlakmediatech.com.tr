import { getTranslations } from "next-intl/server";
import { ACCESS_MODES, ACCESS_REASONS, BILLING_MODES, SUBSCRIPTION_STATUSES } from "@/lib/modules/billing/model";

/**
 * Faz SAAS.1C.1 - the shared label maps of the billing views. The same sub-keys exist under two namespaces ("Billing" for the salon,
 * "SuperAdmin.billing" for the platform), so the views are written once and handed already-resolved plain strings. Every value is
 * resolved here without placeholders (a templated message without values would render as a raw key path in a real browser).
 */
export type BillingLabels = {
  reasons: Record<string, string>;
  modes: Record<string, string>;
  statuses: Record<string, string>;
  billingModes: Record<string, string>;
  limitState: Record<string, string>;
  usage: Record<string, string>;
  limitKeys: Record<string, string>;
};

const USAGE_KEYS = ["activeStaff", "branches", "services", "customers", "activeMembers", "appointmentsTotal", "appointmentsCreated30d", "treatmentPhotos", "emailsSent30d"] as const;
const LIMIT_KEYS = ["max_active_staff", "max_branches"] as const;
const LIMIT_STATES = ["ok", "at_limit", "over"] as const;

export async function loadBillingLabels(namespace: "Billing" | "SuperAdmin.billing"): Promise<BillingLabels> {
  const t = await getTranslations(namespace);
  const map = (prefix: string, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, t(`${prefix}.${k}`)]));
  return {
    reasons: map("reasons", ACCESS_REASONS),
    modes: map("modes", ACCESS_MODES),
    statuses: map("statuses", SUBSCRIPTION_STATUSES),
    billingModes: map("billingModes", BILLING_MODES),
    limitState: map("limitState", LIMIT_STATES),
    usage: map("usage", USAGE_KEYS),
    limitKeys: map("limitKeys", LIMIT_KEYS),
  };
}
