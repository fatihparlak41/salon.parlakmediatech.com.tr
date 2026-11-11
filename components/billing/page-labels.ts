import { getTranslations } from "next-intl/server";
import type { AccessState } from "@/lib/modules/billing/model";
import { formatDate } from "@/components/super-admin/format";
import type { AdminBillingSectionLabels, AdminBillingTableLabels, TenantPlanLabels } from "@/components/billing/billing-views";

/** Page-level label builders for the billing views (server only). Templated messages are always formatted WITH their values. */

const ofLabel = (used: number, limit: number) => `${used} / ${limit}`;

export async function adminSectionLabels(): Promise<AdminBillingSectionLabels> {
  const t = await getTranslations("SuperAdmin.billing");
  const eventTypes = ["created", "backfilled", "trial_started", "status_changed", "plan_changed", "billing_mode_changed", "override_changed", "note"];
  return {
    heading: t("detail.heading"),
    noSubscription: t("detail.noSubscription"),
    plan: t("detail.plan"),
    price: t("detail.price"),
    priceUnset: t("detail.priceUnset"),
    billingMode: t("detail.billingMode"),
    status: t("detail.status"),
    access: t("detail.access"),
    reason: t("detail.reason"),
    trialStarted: t("detail.trialStarted"),
    trialEnds: t("detail.trialEnds"),
    graceEnds: t("detail.graceEnds"),
    daysRemaining: t("detail.daysRemaining"),
    cancelAtPeriodEnd: t("detail.cancelAtPeriodEnd"),
    yes: t("detail.yes"),
    no: t("detail.no"),
    readyNotStarted: t("detail.readyNotStarted"),
    usage: t("detail.usage"),
    limits: t("detail.limits"),
    events: t("detail.events"),
    noEvents: t("detail.noEvents"),
    noLimits: t("noDate"),
    noDate: t("noDate"),
    ofLabel,
    eventTypes: Object.fromEntries(eventTypes.map((k) => [k, t(`detail.eventTypes.${k}`)])),
  };
}

export async function adminTableLabels(): Promise<AdminBillingTableLabels> {
  const t = await getTranslations("SuperAdmin.billing");
  return {
    columns: {
      salon: t("columns.salon"),
      plan: t("columns.plan"),
      mode: t("columns.mode"),
      status: t("columns.status"),
      access: t("columns.access"),
      days: t("columns.days"),
      trialEnd: t("columns.trialEnd"),
      limits: t("columns.limits"),
    },
    overLimit: t("overLimit"),
    atLimit: t("atLimit"),
    noPlan: t("noPlan"),
    noDate: t("noDate"),
    empty: t("empty"),
  };
}

/** The one sentence about the trial a salon reads on its own plan page; values are formatted here, never left to the view. */
export async function tenantTrialLine(state: AccessState): Promise<string> {
  const t = await getTranslations("Billing");
  switch (state.reason) {
    case "trial_not_started":
      return t("trial.notStarted");
    case "trial_active":
      return t("trial.active", { date: formatDate(state.trialEndsAt), days: state.daysRemaining ?? 0 });
    case "trial_expired_grace":
      return t("trial.grace", { date: formatDate(state.graceEndsAt) });
    case "trial_expired":
      return t("trial.expired");
    case "pilot":
    case "internal":
    case "complimentary":
      return t("trial.noExpiry");
    default:
      return t(`reasons.${state.reason}`);
  }
}

export async function tenantPlanLabels(state: AccessState): Promise<TenantPlanLabels> {
  const t = await getTranslations("Billing");
  return {
    plan: t("plan"),
    status: t("status"),
    access: t("access"),
    billingMode: t("billingMode"),
    usageHeading: t("usageHeading"),
    limitsHeading: t("limitsHeading"),
    softNote: t("softNote"),
    noLimits: t("noLimits"),
    trialLine: await tenantTrialLine(state),
    ofLabel,
  };
}
