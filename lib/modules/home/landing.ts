/**
 * Faz PERF.3 — where "/" sends a signed-in user.
 *
 * The installed app launches at "/" (app/manifest.ts start_url), and "/"
 * used to always render the salon chooser. For the common case — a person
 * who belongs to exactly ONE salon — that meant a whole extra server render
 * plus a tap on "Aç" before the dashboard even started loading, on every
 * single launch. A person with one salon has nothing to choose, so they go
 * straight in.
 *
 * The chooser stays for everyone else:
 *   - 0 memberships: the chooser is where "Salon oluştur" lives.
 *   - 2+ memberships: a real choice to make.
 *   - platform admins: the chooser also carries their super-admin entry,
 *     which a silent redirect would hide.
 *   - `?choose` (any value): an explicit way back to the chooser.
 *
 * Pure on purpose — no I/O, no Next imports — so the rule is unit-testable
 * without a session or a database. It only decides WHERE; the destination
 * (app/[locale]/app/[tenantSlug]/layout.tsx) still performs its own
 * authentication and membership checks, so this is a convenience routing
 * rule, never an authorization decision.
 */
export type HomeLanding = { kind: "chooser" } | { kind: "redirect"; href: string };

export function resolveHomeLanding(input: {
  memberships: ReadonlyArray<{ tenantSlug: string }>;
  platformAdmin: boolean;
  forceChooser: boolean;
}): HomeLanding {
  if (input.forceChooser || input.platformAdmin) return { kind: "chooser" };
  if (input.memberships.length !== 1) return { kind: "chooser" };
  return { kind: "redirect", href: `/app/${encodeURIComponent(input.memberships[0]!.tenantSlug)}` };
}
