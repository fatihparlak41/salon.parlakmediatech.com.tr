import "server-only";
import { randomBytes, createHash } from "node:crypto";
import { CODE_ALPHABET, CODE_LENGTH } from "./link-code-format";

/**
 * Faz 2G.3.2 — the customer-generated, salon-redeemed pairing code.
 * Human-safe 31-symbol alphabet (excludes 0/O and 1/I/L, the pairs most
 * often misread when hand-transcribed or read aloud). 12 characters ->
 * log2(31^12) ≈ 59.4 bits of entropy, generated with rejection sampling
 * to avoid modulo bias (256 is not a multiple of 31 — see
 * MAX_ACCEPTABLE_BYTE below). Combined with tenant-binding, a 15-minute
 * expiry, and the customers.link_account permission gate, this entropy
 * alone already makes online guessing infeasible without any separate
 * rate limiter (see the migration's own header for the full reasoning);
 * no failed-attempt counter is added in this first cut.
 */

// Largest multiple of 31 that fits in one byte (0-255): 31*8 = 248, so
// acceptable byte values are 0-247. Bytes 248-255 are redrawn — mapping
// them via a plain modulo would make characters 0-7 of the alphabet
// very slightly more likely than the rest.
const MAX_ACCEPTABLE_BYTE = 247;

export function generateLinkCode(): string {
  let result = "";
  while (result.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH - result.length);
    for (const byte of bytes) {
      if (result.length >= CODE_LENGTH) break;
      if (byte > MAX_ACCEPTABLE_BYTE) continue;
      result += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return result;
}

const CANONICAL_CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/**
 * Normalizes whatever staff actually typed (case, stray spaces, the
 * display hyphens) before it's ever hashed — generation and redemption
 * must agree on byte-for-byte the same canonical string, or a correctly
 * transcribed code would fail to match its own hash. Returns null for
 * anything that isn't exactly 12 characters from the approved alphabet
 * after normalization; callers must treat that identically to "code not
 * valid" rather than surfacing a different error, and should not bother
 * calling the redemption RPC with it at all.
 */
export function canonicalizeLinkCode(input: string): string | null {
  const canonical = input.trim().replace(/[\s-]/g, "").toUpperCase();
  return CANONICAL_CODE_RE.test(canonical) ? canonical : null;
}

export function hashLinkCode(canonicalCode: string): string {
  return createHash("sha256").update(canonicalCode).digest("hex");
}
