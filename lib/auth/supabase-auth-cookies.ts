import { isChunkLike } from "@supabase/ssr";

/**
 * Which cookies are genuinely OWNED BY Supabase Auth (@supabase/ssr +
 * auth-js) — and therefore safe for proxy.ts to clear when a stale session
 * is detected — as opposed to SalonOS's own application cookies (the
 * pending invitation, the pending email confirmation, booking-claim
 * secrets, ...), several of which deliberately share the `sb-` prefix.
 *
 * proxy.ts used to sweep every cookie whose name merely started with
 * `sb-`, which cannot tell the two apart. This module replaces that with an
 * exact predicate. Nothing in it is guessed: every shape below was read
 * from the installed sources (see the SAAS.1D confirmation-continuity
 * report) and is re-verified against the real libraries by
 * tests/supabase-cookie-hygiene.test.ts, so a library upgrade that
 * introduces a new cookie name fails a test instead of silently leaking a
 * stale cookie or, worse, deleting an application one.
 *
 * All Supabase-owned cookies are anchored to ONE storage key K, which
 * supabase-js derives from the project URL as
 * `sb-${new URL(url).hostname.split(".")[0]}-auth-token`
 * (supabase-js SupabaseClient, `defaultStorageKey`). Four item keys exist
 * (@supabase/ssr cookies.js, auth-js lib/helpers.js):
 *
 *   K                                  the session
 *   K-code-verifier                    the fixed / legacy PKCE verifier
 *   K-flows-code-verifier              the index of in-flight PKCE flow ids
 *   K-flow-<flowId>-code-verifier      one PKCE verifier slot per flow
 *
 * where flowId matches auth-js's PKCE_FLOW_ID_PATTERN. Any of them may be
 * stored as `<key>.<n>` chunks (@supabase/ssr chunker), recognised here
 * with the library's own `isChunkLike`. Everything else — including a
 * cookie that merely CONTAINS `-auth-token`, or belongs to another
 * project's storage key — is NOT Supabase's and is never touched.
 *
 * Pure and dependency-light on purpose: proxy.ts runs it on every stale
 * session, and tests run it without a server.
 */

/** Mirrors auth-js's PKCE_FLOW_ID_PATTERN (auth-js lib/helpers.js). */
const PKCE_FLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
const CHUNK_SUFFIX = /\.(?:0|[1-9][0-9]*)$/;
const VERIFIER_SUFFIX = "-code-verifier";

/** The storage key supabase-js/@supabase/ssr use for this project URL, or
 * null when the URL is unusable (callers then clear nothing). */
export function supabaseAuthStorageKey(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null;
  try {
    const label = new URL(supabaseUrl).hostname.split(".")[0];
    return label ? `sb-${label}-auth-token` : null;
  } catch {
    return null;
  }
}

function isAuthItemKey(key: string, storageKey: string): boolean {
  if (key === storageKey) return true;
  if (key === `${storageKey}${VERIFIER_SUFFIX}`) return true;
  if (key === `${storageKey}-flows${VERIFIER_SUFFIX}`) return true;

  const slotPrefix = `${storageKey}-flow-`;
  if (key.startsWith(slotPrefix) && key.endsWith(VERIFIER_SUFFIX) && key.length > slotPrefix.length + VERIFIER_SUFFIX.length) {
    return PKCE_FLOW_ID_PATTERN.test(key.slice(slotPrefix.length, key.length - VERIFIER_SUFFIX.length));
  }
  return false;
}

/** True only for a cookie Supabase Auth itself writes (see the header). */
export function isSupabaseAuthCookieName(name: string, storageKey: string): boolean {
  if (isAuthItemKey(name, storageKey)) return true;

  const base = name.replace(CHUNK_SUFFIX, "");
  return base !== name && isAuthItemKey(base, storageKey) && isChunkLike(name, base);
}

export type StaleCookieClearOutcome = {
  /** Supabase-owned cookies that were cleared. */
  sweptCount: number;
  /** Cookies deliberately left alone (application-owned or unrelated). */
  preservedCount: number;
};

/**
 * The stale-session cleanup proxy.ts performs: clears exactly the
 * Supabase-owned cookies among `cookieNames` (through `remove`) and leaves
 * every other cookie alone. Returns counts only — cookie names can carry
 * identifiers (booking-claim refs), so they are never returned or logged.
 * With an unusable project URL nothing is cleared (fail safe).
 */
export function clearStaleSupabaseAuthCookies(input: {
  cookieNames: readonly string[];
  supabaseUrl: string | undefined;
  remove: (name: string) => void;
}): StaleCookieClearOutcome {
  const storageKey = supabaseAuthStorageKey(input.supabaseUrl);
  let sweptCount = 0;
  let preservedCount = 0;

  for (const name of input.cookieNames) {
    if (storageKey !== null && isSupabaseAuthCookieName(name, storageKey)) {
      input.remove(name);
      sweptCount += 1;
    } else {
      preservedCount += 1;
    }
  }
  return { sweptCount, preservedCount };
}
