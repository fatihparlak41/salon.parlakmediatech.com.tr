/**
 * Tenant slugs (`/app/[tenantSlug]`, `/book/[tenantSlug]`) share the path
 * namespace with the app's own top-level routes and with locale codes we
 * may route on later. A salon registering as "book", "api" or "tr" would
 * either break routing or shadow a real page, so onboarding must reject
 * these before a slug is ever written to `tenants.slug` (Faz 1).
 */
export const RESERVED_SLUGS = new Set([
  // top-level app routes
  "app",
  "book",
  "super-admin",
  "api",
  "admin",
  "auth",
  "login",
  "logout",
  "signup",
  "sign-up",
  "sign-in",
  "register",
  "onboarding",
  "dashboard",
  "settings",
  "billing",
  "docs",
  "help",
  "support",
  "status",
  "pricing",
  "about",
  "contact",
  "legal",
  "privacy",
  "terms",
  // infra / well-known paths
  "www",
  "mail",
  "ftp",
  "static",
  "public",
  "assets",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "manifest.json",
  "_next",
  "_vercel",
  // current + likely-future locale codes (see lib/i18n/routing.ts)
  "tr",
  "en",
  "ru",
  "de",
  "fr",
  "es",
  "ar",
]);

const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

export function isValidSlugFormat(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 63 && SLUG_FORMAT.test(slug);
}

export function isAvailableSlugCandidate(slug: string): boolean {
  return isValidSlugFormat(slug) && !isReservedSlug(slug);
}
