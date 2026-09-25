/**
 * Faz SAAS.1E.1 — the LOCKED product decision for the four primary roles,
 * written out by hand.
 *
 * This is deliberately NOT read from role_templates: the tests that import it
 * exist to catch the templates (or the provisioning/backfill that copies
 * them) drifting away from what was decided. Owner is the whole permission
 * catalog (see expectedKeysFor); the other three are explicit lists.
 *
 * Not a test file (no `.test.ts` suffix) — vitest does not collect it.
 */

/** The four primary role KEYS — the identity; display names are cosmetic. */
export const DEFAULT_ROLE_KEYS = ["RECEPTIONIST", "SALON_MANAGER", "SALON_OWNER", "STYLIST"] as const;

/** What the salon sees. The internal keys (SALON_MANAGER, STYLIST) never reach a screen. */
export const DEFAULT_ROLE_NAMES: Record<string, string> = {
  SALON_OWNER: "Salon Sahibi",
  SALON_MANAGER: "Yönetici",
  RECEPTIONIST: "Resepsiyon",
  STYLIST: "Personel",
};

/** Yönetici — operations, people and catalogue; NOT settings, finance, inventory, financial reports or the unrestricted key. */
export const MANAGER_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update", "customers.link_account",
  "staff.view", "staff.manage",
  "schedules.view", "schedules.manage",
  "services.view", "services.manage",
  "reports.basic", "reports.staff",
] as const;

/** Resepsiyon — the front desk: appointments and customers, read-only schedules and services. */
export const RECEPTION_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update",
  "schedules.view", "services.view",
] as const;

/** Personel — sees the salon's appointments, changes nothing, has no customer directory. */
export const PERSONEL_KEYS = ["appointments.view"] as const;

const sorted = (keys: readonly string[]) => [...keys].sort();

/** The exact permission set a freshly provisioned role of this key holds, sorted. Owner = the whole catalog. */
export function expectedKeysFor(roleKey: string, catalog: readonly string[]): string[] {
  switch (roleKey) {
    case "SALON_OWNER":
      return sorted(catalog);
    case "SALON_MANAGER":
      return sorted(MANAGER_KEYS);
    case "RECEPTIONIST":
      return sorted(RECEPTION_KEYS);
    case "STYLIST":
      return sorted(PERSONEL_KEYS);
    default:
      throw new Error(`not a primary role key: ${roleKey}`);
  }
}
