import "server-only";
import { createHash } from "node:crypto";

/**
 * Faz ACCOUNT.1 (security) — the non-reversible tag that stands for "the
 * person signed in right now" in the browser's push-device bookkeeping
 * (lib/pwa/device-session.ts). It lets a shared browser tell "my device"
 * from "somebody else's device" without ever storing a user id, e-mail or
 * name in localStorage. 128 bits of a SHA-256 over a fixed prefix and the
 * user's UUID: stable per person, useless for looking anybody up. Computed
 * on the server so the raw id never has to be handed to client code for
 * this purpose.
 */
export function deviceOwnerTag(userId: string): string {
  return createHash("sha256").update(`salonos:push-device-owner:v1:${userId}`).digest("hex").slice(0, 32);
}
