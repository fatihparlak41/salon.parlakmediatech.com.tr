#!/usr/bin/env node
// SAAS.1C.2c-A2 classification generator (dev tool, never run by the app or CI).
// Reads tests/fixtures/billing-enforcement-registry.json, applies the ACCEPTED classification rules below and rewrites the fixture with
//   class / hooked / audience (every action) + scope / scope_arg (functions) + trigger shape (table ops),
// then prints the SQL VALUES block that migration 20261120..._billing_enforcement_hooks_core_a2.sql embeds.
// The migration is the source of truth at runtime; tests/saas1c2c-a2-*.test.ts prove the database registry equals this fixture.
//   usage: node scripts/billing-a2-classify.mjs            (rewrite the fixture, print the VALUES block)
//          node scripts/billing-a2-classify.mjs --check    (exit 1 if the fixture is not already classified)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "tests", "fixtures", "billing-enforcement-registry.json");
const reg = JSON.parse(fs.readFileSync(file, "utf8"));

/** category -> enforcement class (one class per action; OTHER only for a tenant that does not exist yet) */
export const CLASS_BY_CATEGORY = {
  PUBLIC_BOOKING_CREATE: "PUBLIC_BOOKING_WRITE",
  APPT_CREATE: "TENANT_BUSINESS_WRITE",
  CUSTOMER_CREATE_IMPORT: "TENANT_BUSINESS_WRITE",
  CATALOG_CREATE: "TENANT_BUSINESS_WRITE",
  TEAM_GROWTH: "TENANT_BUSINESS_WRITE",
  ONBOARDING: "TENANT_BUSINESS_WRITE",
  APPT_CONTINUITY: "EXISTING_RECORD_OPERATION",
  CUSTOMER_EDIT: "EXISTING_RECORD_OPERATION",
  CATALOG_EDIT: "EXISTING_RECORD_OPERATION",
  FINANCE_SETTLE: "EXISTING_RECORD_OPERATION",
  FINANCE_BOOKKEEPING: "EXISTING_RECORD_OPERATION",
  TREATMENT: "EXISTING_RECORD_OPERATION",
  SETTINGS_EDIT: "EXISTING_RECORD_OPERATION",
  CUSTOMER_SELF_SERVICE_CHANGE: "EXISTING_RECORD_OPERATION",
  CUSTOMER_SELF_SERVICE_CANCEL: "EXISTING_RECORD_OPERATION",
  SYSTEM_NOTIFY: "SYSTEM_WRITE",
  SYSTEM_HYGIENE: "SYSTEM_WRITE",
  TEAM_SECURITY: "SECURITY_ACCOUNT_ACTION",
  CUSTOMER_ACCOUNT: "SECURITY_ACCOUNT_ACTION",
  PERSONAL_PREFS: "SECURITY_ACCOUNT_ACTION",
  PLATFORM_ADMIN: "CONTROL_PLANE",
  EXPORT: "EXPORT",
  TENANT_CREATE: "OTHER",
};
/** explicit per-action overrides (each one is a documented decision, not a default) */
export const CLASS_OVERRIDE = {
  // a worker-side audit write that records the outcome of an invitation e-mail: it is not a tenant action, it must never be refused
  "fn:log_team_invitation_email_delivery": "SYSTEM_WRITE",
};
/** how each hooked function finds its tenant (lazily, inside the guard, only when stage > 0) and the name of the parameter it reads */
export const SCOPE = {
  tenant: ["commit_customer_import", "confirm_treatment_photo", "create_appointment", "create_expense", "create_team_invitation", "delete_treatment_photo", "onboarding_add_services", "onboarding_add_staff", "onboarding_apply_weekly_hours", "onboarding_set_staff_services", "register_treatment_photo", "set_commission_rule", "set_customer_notification_setting", "set_online_booking_enabled", "set_treatment_note", "update_salon_profile"],
  appointment: ["complete_appointment", "reschedule_appointment", "update_appointment_status", "get_or_create_appointment_sale", "reschedule_my_appointment"],
  sale: ["record_appointment_payment", "update_appointment_sale_pricing"],
  payment: ["void_appointment_payment"],
  expense: ["cancel_expense", "update_expense", "record_expense_payment"],
  expense_payment: ["void_expense_payment"],
  customer: ["unlink_salon_assisted_customer_account"],
  invitation: ["resend_team_invitation"],
  invitation_token: ["accept_team_invitation"],
  slug: ["create_guest_booking"],
};
export const SCOPE_ARG = { tenant: "p_tenant_id", appointment: "p_appointment_id", sale: "p_sale_id", payment: "p_payment_id", expense: "p_expense_id", expense_payment: "p_payment_id", customer: "p_customer_id", invitation: "p_invitation_id", invitation_token: "p_token", slug: "p_tenant_slug" };
/** who the caller is: `member` = an active member of the tenant (the guard stays silent for anybody else so it can never disclose a tenant's billing state) */
const AUDIENCE_OVERRIDE = { "fn:create_guest_booking": "public", "fn:reschedule_my_appointment": "self", "fn:cancel_my_appointment": "self", "fn:accept_team_invitation": "self" };
/** direct-table triggers: how the tenant is found from the row */
export const TABLE_SHAPE = {
  branches: "tenant_col", customers: "tenant_col", services: "tenant_col", staff_members: "tenant_col", staff_schedule_exceptions: "tenant_col", staff_schedules: "tenant_col",
  tenants: "tenants_id",
  service_branches: "relation:services:service_id", staff_branches: "relation:staff_members:staff_member_id", staff_services: "relation:staff_members:staff_member_id",
};

const cat = Object.fromEntries(reg.categories.map((c) => [c.category, c]));
const scopeOf = {};
for (const [s, names] of Object.entries(SCOPE)) for (const n of names) scopeOf["fn:" + n] = s;

const out = [];
for (const a of reg.actions) {
  const c = cat[a.category];
  if (!c) throw new Error("unknown category " + a.category);
  const cls = CLASS_OVERRIDE[a.action_key] ?? CLASS_BY_CATEGORY[a.category];
  if (!cls) throw new Error("no class for category " + a.category);
  const canRefuse = c.read_only === "block" || c.blocked === "block";
  const hooked = canRefuse && ["TENANT_BUSINESS_WRITE", "PUBLIC_BOOKING_WRITE", "EXISTING_RECORD_OPERATION"].includes(cls);
  const audience = AUDIENCE_OVERRIDE[a.action_key] ?? (a.category === "PUBLIC_BOOKING_CREATE" ? "public" : "member");
  const row = { action_key: a.action_key, kind: a.kind, category: a.category, class: cls, hooked, audience };
  if (a.kind === "function") {
    if (hooked) {
      const s = scopeOf[a.action_key];
      if (!s) throw new Error("hooked function without a scope: " + a.action_key);
      row.scope = s;
      row.scope_arg = SCOPE_ARG[s];
    } else if (scopeOf[a.action_key]) throw new Error("scope given for a function that is not hooked: " + a.action_key);
  } else {
    const t = a.action_key.split(":")[1];
    if (hooked) {
      if (!TABLE_SHAPE[t]) throw new Error("hooked table without a trigger shape: " + t);
      row.scope = TABLE_SHAPE[t];
    }
  }
  out.push(row);
}
const unused = Object.values(SCOPE).flat().filter((n) => !out.some((r) => r.action_key === "fn:" + n && r.hooked));
if (unused.length) throw new Error("scope names that are not hooked functions: " + unused.join(","));

const next = { ...reg, _comment: "SAAS.1C.2c-A2: class / hooked / audience / scope / scope_arg added by scripts/billing-a2-classify.mjs (accepted classification). Regenerate with `node scripts/billing-registry.mjs` (catalog) then `node scripts/billing-a2-classify.mjs`.", actions: out };
if (process.argv.includes("--check")) {
  const same = JSON.stringify(reg.actions) === JSON.stringify(out);
  console.log(same ? "fixture is classified" : "fixture is NOT classified / out of date");
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
const q = (s) => (s === undefined || s === null ? "null" : "'" + s + "'");
console.log(out.map((r) => `    (${q(r.action_key)}, ${q(r.class)}, ${r.hooked}, ${q(r.audience)}, ${q(r.scope)}, ${q(r.scope_arg)})`).join(",\n"));
console.error(`classified ${out.length} actions: hooked functions ${out.filter((r) => r.kind === "function" && r.hooked).length}, hooked table ops ${out.filter((r) => r.kind === "table_op" && r.hooked).length}`);
