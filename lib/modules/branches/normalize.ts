/**
 * Faz 2I.2F (Batch A) — shared, framework-free helpers for the branch
 * contact/social fields (whatsapp_phone, instagram_handle, location_url).
 * No "use server"/"use client" directive: everything here is a pure
 * function safe to import from the owner-settings write path
 * (lib/modules/branches/actions.ts, before storage) AND from the public
 * booking header (components/public-booking/salon-contact-header.tsx,
 * to derive a wa.me/instagram.com URL at render time) — one definition,
 * reused both places, instead of duplicating the wa.me construction
 * logic client-side.
 */

/**
 * Same algorithm as private.normalize_phone (20260821120000: strip
 * everything but digits and a leading "+") so a WhatsApp number typed
 * as "+90 533 874 18 29" normalizes exactly like the rest of the
 * codebase already treats phone-shaped input. Kept as a TS-side helper
 * rather than a round trip to that DB function — this only ever runs on
 * the authenticated owner-settings write path, before the value is
 * stored, so what ends up in whatsapp_phone is already clean and
 * toWhatsappUrl below never has to re-normalize.
 */
export function normalizeWhatsappPhone(raw: string): string {
  return raw.replace(/[^0-9+]/g, "");
}

/**
 * Country-neutral, same spirit as the booking gateway's own contact
 * validation (20260822160000: "reject obviously meaningless input... not
 * attempt to verify the contact is real"). 8–15 digits after stripping
 * covers real international numbers without assuming a country or a
 * fixed length; the leading "+" is optional since some owners will type
 * a local-format number.
 */
export function isValidWhatsappPhone(normalized: string): boolean {
  return /^\+?[0-9]{8,15}$/.test(normalized);
}

/** Strips a single leading "@" — "@Handle" and "Handle" both normalize
 * to "Handle". A pasted profile URL (e.g. "https://instagram.com/x") is
 * deliberately NOT auto-extracted — isValidInstagramHandle below rejects
 * it as "obviously invalid input" per spec, rather than silently
 * guessing what the owner meant. */
export function normalizeInstagramHandle(raw: string): string {
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

/** Real Instagram handles are 1–30 chars of letters, digits, periods and
 * underscores (Instagram's own constraint) — anything else (spaces, a
 * slash, a full URL) is rejected. */
export function isValidInstagramHandle(normalized: string): boolean {
  return /^[A-Za-z0-9._]{1,30}$/.test(normalized);
}

/** No lat/lng parsing, no Maps-specific host requirement — deliberately,
 * per spec ("do not require latitude/longitude"): share.google,
 * maps.app.goo.gl, google.com/maps and any other well-formed http(s) URL
 * must all work identically. The URL constructor is what actually
 * decides "well-formed" here rather than a hand-rolled regex, so it
 * correctly accepts a URL shape like
 * https://share.google/EcHzpDuVyTcqqmKYV without special-casing it. */
export function isValidLocationUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** wa.me needs bare digits, no leading "+" — see
 * https://faq.whatsapp.com/425247423114725. Storage keeps the "+" (more
 * readable, easier to re-edit); this is the one place it's stripped, so
 * an owner never has to construct this URL themselves. */
export function toWhatsappUrl(whatsappPhone: string): string {
  return `https://wa.me/${whatsappPhone.replace(/^\+/, "")}`;
}

export function toInstagramUrl(instagramHandle: string): string {
  return `https://instagram.com/${instagramHandle}`;
}
