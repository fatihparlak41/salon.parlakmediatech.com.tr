// Test-only stand-in for the real "server-only" package (see
// vitest.config.ts's resolve.alias). The real package works by relying
// on Next.js's own bundler to swap it for a no-op in server builds and a
// throwing stub in client builds — a guarantee that only exists inside
// Next's build pipeline, not under Vitest. This alias applies ONLY to
// `vitest run`; `pnpm build`/`pnpm dev` never read vitest.config.ts, so
// the real client-bundle protection is completely unaffected — a module
// that imports "server-only" still becomes a build error if an actual
// client component ever imports it.
export {};
