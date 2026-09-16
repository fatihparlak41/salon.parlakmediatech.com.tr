import "server-only";
import { timingSafeEqual, createHash } from "node:crypto";

/**
 * Faz NOTIF.2E.3 — authenticates the internal worker endpoint's caller.
 *
 * CRON_SECRET is Vercel's own documented mechanism (freshly verified
 * against Vercel's current Cron Jobs docs this phase, not assumed):
 * when a CRON_SECRET environment variable is set on the project, every
 * request Vercel's own scheduler sends to a configured cron path
 * automatically carries `Authorization: Bearer <CRON_SECRET>`. This
 * function is the sole place that header is checked — the route handler
 * never inspects it directly.
 *
 * Fails closed, always: no CRON_SECRET configured on the server means
 * NO caller can ever be authorized, in any environment, by design (Step
 * 4's explicit "do not silently allow requests in development or
 * production"). There is no bypass, no default secret, no "allow if
 * missing" branch.
 *
 * Uses a fixed-length-hash-then-timingSafeEqual comparison rather than
 * `===` or a direct timingSafeEqual(a, b) on the raw strings: the latter
 * throws on a length mismatch (an attacker-controlled input), which
 * would need its own try/catch and is easy to get subtly wrong; hashing
 * both sides to a fixed 32-byte digest first sidesteps that entirely
 * while keeping the actual secret comparison constant-time.
 */

function fixedLengthDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isAuthorizedCronRequest(authorizationHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authorizationHeader) return false;

  const expected = fixedLengthDigest(`Bearer ${secret}`);
  const actual = fixedLengthDigest(authorizationHeader);
  return timingSafeEqual(expected, actual);
}
