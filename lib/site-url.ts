// Pulled out of lib/modules/auth/actions.ts (a "use server" file) — every
// export from a "use server" file must be an async Server Action, and
// this is a plain synchronous helper, not one. Shared by both the staff
// auth flow (signUpAction's emailRedirectTo) and the customer magic-link
// flow (requestAccountMagicLinkAction's emailRedirectTo).
//
// NEXT_PUBLIC_SITE_URL wins once set (the real custom domain, once
// attached). Until then, Vercel's own VERCEL_URL — auto-populated per
// deployment, including a unique one per Preview build — resolves this
// correctly with no per-deployment config. Bare localhost fallback is
// for `pnpm dev` only.
export function getSiteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}
