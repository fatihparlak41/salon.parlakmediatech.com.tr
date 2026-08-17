// No "server-only" guard here on purpose — this module is imported from
// both proxy.ts (edge runtime) and lib/auth/session.ts (server-only, node
// runtime), and must work in either. No auth-js import either: this
// project only depends on @supabase/supabase-js and @supabase/ssr, and
// neither re-exports auth-js's isAuthError — pulling it from
// @supabase/auth-js directly would be a phantom dependency under pnpm's
// strict node_modules. Duck-typing the public `code`/`status` fields
// (part of AuthError's stable, documented shape) avoids that entirely.

const STALE_SESSION_ERROR_CODES = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
]);

function authErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * True for the known set of "this session/refresh-token cookie is stale"
 * auth errors — revoked elsewhere (account deleted, all-sessions
 * sign-out), expired, or already consumed. Safe to silently treat as
 * signed-out rather than surfacing as a failure. Anything else (auth
 * error or not) is NOT stale-session and callers should log it.
 */
export function isStaleSessionError(error: unknown): boolean {
  const code = authErrorCode(error);
  return code !== undefined && STALE_SESSION_ERROR_CODES.has(code);
}

/** Safe fields for logging an auth error caught from an `unknown` catch
 * clause — never the error's `message` (some Supabase error types embed
 * request data such as the submitted email). */
export function authErrorLogFields(error: unknown): {
  code?: string;
  status?: number;
} {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; status?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      status: typeof e.status === "number" ? e.status : undefined,
    };
  }
  return {};
}
