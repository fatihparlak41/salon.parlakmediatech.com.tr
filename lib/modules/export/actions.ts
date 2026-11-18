"use server";

import { createClient } from "@/lib/supabase/server";
import { getTenantAccess } from "@/lib/auth/session";
import { newExportToken } from "./token";
import { requestTenantExport } from "./queries";

/**
 * Faz SAAS.1C.2b - "prepare my export". The tenant is re-derived from the signed-in session (the slug is only a lookup key, authorization is the
 * database's: Owner status AND a fresh sign-in are re-checked there). The raw download token is created here, hashed here, and returned ONCE to
 * the caller; it is never stored or logged. The returned object never contains anything else.
 */

export type PrepareExportResult =
  | { ok: true; token: string; expiresAt: string; remainingAfter: number }
  | { ok: false; error: "unauthenticated" | "not_owner" | "fresh_auth_required" | "rate_limited" | "export_in_progress" | "too_many_failures" | "invalid_request" | "duplicate_request" | "unexpected"; retryAt?: string };

const KNOWN = new Set(["not_owner", "fresh_auth_required", "rate_limited", "export_in_progress", "too_many_failures", "invalid_request", "duplicate_request", "unauthenticated"]);

export async function prepareTenantExportAction(tenantSlug: string): Promise<PrepareExportResult> {
  if (typeof tenantSlug !== "string" || tenantSlug.length === 0 || tenantSlug.length > 100) return { ok: false, error: "invalid_request" };
  const access = await getTenantAccess(tenantSlug);
  if (access.reason === "unauthenticated") return { ok: false, error: "unauthenticated" };
  // an unknown slug / a tenant the caller is not a member of looks exactly like "not an owner": no tenant enumeration
  if (access.reason !== "ok") return { ok: false, error: "not_owner" };

  const supabase = await createClient();
  const fresh = newExportToken();
  const result = await requestTenantExport(supabase, access.tenant.id, fresh.tokenHash, fresh.clientRequestId);
  if (result.ok) return { ok: true, token: fresh.token, expiresAt: result.expires_at, remainingAfter: result.remaining_after };
  const code = KNOWN.has(result.error) ? (result.error as Exclude<PrepareExportResult, { ok: true }>["error"]) : "unexpected";
  return { ok: false, error: code, retryAt: result.retry_at };
}
