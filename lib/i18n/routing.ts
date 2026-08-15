import { defineRouting } from "next-intl/routing";

/**
 * Only `tr` ships today. `localePrefix: "never"` keeps URLs prefix-free
 * (e.g. `/app/bella-hair`, not `/tr/app/bella-hair`) while the routing,
 * middleware and message-catalog plumbing are already locale-aware. Adding
 * `en` / `ru` later means appending to `locales` and adding a message file —
 * no route restructuring.
 */
export const locales = ["tr"] as const;

export const defaultLocale: (typeof locales)[number] = "tr";

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: "never",
});

export type AppLocale = (typeof locales)[number];
