import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Faz SAAS.1C.2b - the download token. 256 random bits from the OS CSPRNG, base64url (43 chars). Only the sha256 hex of it ever leaves this module
 * toward the database; the raw value is returned once to the requesting browser and is never stored or logged.
 */

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type NewExportToken = { token: string; tokenHash: string; clientRequestId: string };

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newExportToken(): NewExportToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token), clientRequestId: randomUUID() };
}

export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}
