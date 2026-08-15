import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/**
 * Locale-aware `Link` / `redirect` / `usePathname` / `useRouter`. Use these
 * instead of the plain `next/navigation` and `next/link` exports anywhere
 * under `app/[locale]` so navigation keeps working unchanged once a second
 * locale is added.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
