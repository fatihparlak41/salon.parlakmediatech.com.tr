/**
 * Faz SAAS.1A — the ONE redirect sanitizer every auth return path goes through.
 *
 * Until now this guard lived inside app/auth/confirm/route.ts (a route file nobody should import a
 * helper from) while app/auth/callback/route.ts carried its own, weaker, hand-rolled check. Both now
 * use this module (a Next route file may export only HTTP handlers, so nothing is re-exported from it).
 * Pure on purpose (no Next, no cookies, no environment): it can be unit-tested exhaustively and
 * imported from server actions, pages, route handlers and other pure auth helpers alike.
 *
 * The guarantee: the result is ALWAYS either "/" or a plain same-site path (exactly one leading "/",
 * never "//", "///" or "/\"), with no control characters, raw or percent-encoded. Applying the function
 * to its own result changes nothing (idempotent), so a value stays safe however many times it is
 * normalized on its way through a page, a hidden form field, a cookie and an action.
 *
 * Why it resolves against `origin` instead of a bare startsWith("/"): Supabase's {{ .RedirectTo }}
 * template variable is a FULL URL, and URL normalization can turn an innocent-looking path into an
 * off-site one — via dot segments ("/.//evil.com"), a same-site absolute URL with a double-slash path
 * ("https://<site>//evil.com") or slash/backslash mixes. Anything that would not be a plain path falls
 * back to "/". (History: release-review finding F4 of Faz SAAS.1D.)
 */

const MAX_ESCAPE_FOLD_ROUNDS = 5;

/** Control characters (and DEL) never belong in a redirect target. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** The same characters percent-encoded (%00-%1f, %7f) — e.g. an encoded CR/LF
 * that a downstream decoder could turn into a header break. */
const ENCODED_CONTROL_CHARACTER = /%(?:[01][0-9a-f]|7f)/i;

/**
 * True for an ordinary same-site path: "/" itself, or exactly one leading "/"
 * followed by a character that is neither "/" nor "\". Checked again after
 * folding the escapes an intermediary might decode (%2f, %5c, %25 for double
 * encoding) and the tab/CR/LF the URL parser silently drops, so a value that
 * only BECOMES "//host" or "/\host" once decoded is refused as well. A value
 * that is still changing after a few rounds is too deeply encoded to vouch for.
 */
function isPlainLocalPath(pathname: string): boolean {
  let current = pathname;
  for (let round = 0; round < MAX_ESCAPE_FOLD_ROUNDS; round++) {
    if (!(current === "/" || /^\/[^\/\\]/.test(current))) return false;
    const folded = current
      .replace(/%(?:09|0a|0d)/gi, "")
      .replace(/%2f/gi, "/")
      .replace(/%5c/gi, "\\")
      .replace(/%25/gi, "%");
    if (folded === current) return true;
    current = folded;
  }
  return false;
}

/** A path that is already known to be plain: exactly one leading "/", never "//" (protocol-relative; "///" is read the
 * same way) and never "/\" (a backslash is read as a slash). Used as a second, independent check by callers that hold a
 * value one step away from redirect(). */
export function isPlainSitePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}

/**
 * Open-redirect guard. `next` is whatever a link, form field or cookie carried; `origin` is this site's origin
 * (getSiteUrl() in actions, the request origin in route handlers). Returns "/" for anything that is not a plain,
 * same-origin, control-character-free path.
 */
export function resolveSafeNext(next: string, origin: string): string {
  if (typeof next !== "string" || hasControlCharacter(next)) return "/";
  try {
    const resolved = new URL(next, origin);
    if (resolved.origin !== origin) return "/";
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return isPlainLocalPath(resolved.pathname) && !ENCODED_CONTROL_CHARACTER.test(path) ? path : "/";
  } catch {
    return "/";
  }
}
