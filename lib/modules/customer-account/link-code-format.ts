/**
 * Faz 2G.3.2 — pure, browser-safe pieces of the pairing-code format,
 * split out of link-code.ts specifically because that file is marked
 * server-only (it uses node:crypto) and therefore cannot be imported by
 * any client component. formatLinkCodeForDisplay has no such
 * dependency and needs to run in the browser (the code-display
 * component formats what the server already generated), so it lives
 * here instead. The alphabet/length constants are shared so the two
 * files can never drift apart.
 */

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 symbols
export const CODE_LENGTH = 12;

/** "XXXX-XXXX-XXXX" for display only — never the canonical value used
 * for hashing/comparison. */
export function formatLinkCodeForDisplay(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}
