/**
 * Faz BEAUTY.1A - the generic "service experience" fields (pricing/booking mode, display duration, salon-authored copy).
 * Pure functions so the rules are tested once and the Server Actions only call them. Nothing here is specific to a business or
 * a treatment. Every field is optional on update: an absent field means "leave the stored value alone".
 */

export type ServiceExperienceInput = {
  pricingMode?: "fixed" | "inquiry";
  bookingMode?: "direct" | "inquiry";
  pricePublic?: boolean;
  displayDurationMin?: number | null;
  displayDurationMax?: number | null;
  publicSummary?: string;
  publicDetails?: string;
  preparationNote?: string;
  aftercareNote?: string;
  importantNote?: string;
  badgeLabel?: string;
};

export const EXPERIENCE_TEXT_LIMITS = {
  publicSummary: 160,
  publicDetails: 1000,
  preparationNote: 300,
  aftercareNote: 300,
  importantNote: 200,
  badgeLabel: 40,
} as const;

const TEXT_FIELDS: [keyof typeof EXPERIENCE_TEXT_LIMITS, string][] = [
  ["publicSummary", "public_summary"],
  ["publicDetails", "public_details"],
  ["preparationNote", "preparation_note"],
  ["aftercareNote", "aftercare_note"],
  ["importantNote", "important_note"],
  ["badgeLabel", "badge_label"],
];

/** A plain-language message for the first problem, or null when the input is acceptable. */
export function validateExperience(input: ServiceExperienceInput): string | null {
  const { displayDurationMin: min, displayDurationMax: max } = input;
  if ((min === null || min === undefined) && max !== null && max !== undefined) {
    return "Görünen süre için önce en az süreyi girin";
  }
  if (min !== null && min !== undefined && max !== null && max !== undefined && max < min) {
    return "Görünen sürenin üst sınırı alt sınırdan küçük olamaz";
  }
  for (const [key] of TEXT_FIELDS) {
    const v = input[key];
    if (typeof v === "string" && v.trim().length > EXPERIENCE_TEXT_LIMITS[key]) {
      return `Metin en fazla ${EXPERIENCE_TEXT_LIMITS[key]} karakter olabilir`;
    }
  }
  return null;
}

/**
 * Database columns for the provided fields only. An inquiry-priced service is always inquiry-booked, carries price 0 internally
 * (never displayed) and is never shown with a public price.
 */
export function experienceColumns(input: ServiceExperienceInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.pricingMode === "inquiry") {
    out.pricing_mode = "inquiry";
    out.booking_mode = "inquiry";
    out.price_public = false;
    out.price = 0;
  } else {
    if (input.pricingMode === "fixed") out.pricing_mode = "fixed";
    if (input.bookingMode !== undefined) out.booking_mode = input.bookingMode;
    if (input.pricePublic !== undefined) out.price_public = input.pricePublic;
  }
  if (input.displayDurationMin !== undefined) {
    out.display_duration_min = input.displayDurationMin;
    out.display_duration_max = input.displayDurationMin === null ? null : (input.displayDurationMax ?? null);
  }
  for (const [key, column] of TEXT_FIELDS) {
    const v = input[key];
    if (v !== undefined) out[column] = v.trim() === "" ? null : v.trim();
  }
  return out;
}

/** Text-field state of the service form (strings, as typed) and its mapping to/from the action input. */
export type ExperienceForm = {
  pricingMode: "fixed" | "inquiry";
  bookingMode: "direct" | "inquiry";
  pricePublic: boolean;
  displayMin: string;
  displayMax: string;
  summary: string;
  details: string;
  preparation: string;
  aftercare: string;
  important: string;
  badge: string;
};

export function emptyExperienceForm(): ExperienceForm {
  return { pricingMode: "fixed", bookingMode: "direct", pricePublic: false, displayMin: "", displayMax: "", summary: "", details: "", preparation: "", aftercare: "", important: "", badge: "" };
}

const toMinutes = (s: string): number | null => (s.trim() === "" ? null : Number(s.trim()));

export function experienceFormToInput(f: ExperienceForm): ServiceExperienceInput {
  return {
    pricingMode: f.pricingMode,
    bookingMode: f.pricingMode === "inquiry" ? "inquiry" : f.bookingMode,
    pricePublic: f.pricingMode === "inquiry" ? false : f.pricePublic,
    displayDurationMin: toMinutes(f.displayMin),
    displayDurationMax: toMinutes(f.displayMax),
    publicSummary: f.summary,
    publicDetails: f.details,
    preparationNote: f.preparation,
    aftercareNote: f.aftercare,
    importantNote: f.important,
    badgeLabel: f.badge,
  };
}

export type ServiceExperienceRow = {
  pricingMode: "fixed" | "inquiry";
  bookingMode: "direct" | "inquiry";
  pricePublic: boolean;
  displayDurationMin: number | null;
  displayDurationMax: number | null;
  publicSummary: string | null;
  publicDetails: string | null;
  preparationNote: string | null;
  aftercareNote: string | null;
  importantNote: string | null;
  badgeLabel: string | null;
};

export function experienceFormFromRow(r: ServiceExperienceRow): ExperienceForm {
  return {
    pricingMode: r.pricingMode,
    bookingMode: r.bookingMode,
    pricePublic: r.pricePublic,
    displayMin: r.displayDurationMin === null ? "" : String(r.displayDurationMin),
    displayMax: r.displayDurationMax === null ? "" : String(r.displayDurationMax),
    summary: r.publicSummary ?? "",
    details: r.publicDetails ?? "",
    preparation: r.preparationNote ?? "",
    aftercare: r.aftercareNote ?? "",
    important: r.importantNote ?? "",
    badge: r.badgeLabel ?? "",
  };
}
