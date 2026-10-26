/**
 * Faz BEAUTY.1B - the optional, generic "recommended re-booking window" of a service (days after a completed treatment).
 * Pure rules shared by the create / update actions. An absent field means "leave the stored value alone".
 */

export type ServiceRebookInput = { rebookMinDays?: number | null; rebookMaxDays?: number | null };

export function validateRebook(input: ServiceRebookInput): string | null {
  const { rebookMinDays: min, rebookMaxDays: max } = input;
  if ((min === null || min === undefined) && max !== null && max !== undefined) return "Tekrar dönemi için önce en az günü girin";
  if (min !== null && min !== undefined && max !== null && max !== undefined && max < min) return "Tekrar döneminin üst sınırı alt sınırdan küçük olamaz";
  return null;
}

export function rebookColumns(input: ServiceRebookInput): Record<string, unknown> {
  if (input.rebookMinDays === undefined) return {};
  return { rebook_min_days: input.rebookMinDays, rebook_max_days: input.rebookMinDays === null ? null : (input.rebookMaxDays ?? null) };
}

/** Form text ("" = unset) to the action's nullable integer. */
export function rebookDaysFromText(s: string): number | null {
  const t = s.trim();
  return t === "" ? null : Number(t);
}
