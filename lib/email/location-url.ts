/**
 * Faz NOTIF.1A — render-time validation of the branch location link that
 * goes into a customer email ("Yol Tarifi Al").
 *
 * The link itself is tenant-scoped configuration (branches.location_url,
 * edited by the salon in Settings; never hardcoded in a template). That
 * column is validated only as "any well-formed http(s) URL" at write time
 * (lib/modules/branches/normalize.ts), which is right for a link shown in
 * the salon's own booking page — but this link is emailed FROM our domain
 * to customers, so it is re-validated here, at the last possible moment,
 * with a stricter rule. A value that fails is simply omitted (the email
 * still goes out, without the button); it is never "fixed up".
 *
 * Accepted: an absolute https URL with a public, plain-ASCII hostname.
 * Rejected: every other scheme (javascript:, data:, file:, http:, ftp:,
 * blob:, mailto: ...), credentials in the URL (https://good.example@evil.
 * example/ — the classic look-alike trick), a non-default port, an IP
 * literal or an internal/loopback name, an internationalised hostname
 * (homograph look-alikes of a maps provider), whitespace or control
 * characters anywhere, and anything over 2048 characters.
 *
 * Pure: no I/O, no environment. A redirect chain is not followed — a
 * short link such as https://share.google/... is a redirect by nature; that
 * the link lands where the salon intends is verified by a human when the
 * URL is configured (see the NOTIF.1A activation runbook), not guessed at
 * here.
 */

const MAX_LOCATION_URL_LENGTH = 2048;

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const INTERNAL_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"];

function isPublicAsciiHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.length === 0 || host.length > 253) return false;
  if (host === "localhost" || INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;

  const labels = host.split(".");
  if (labels.length < 2) return false;
  // An all-numeric final label is an IPv4 address (or a malformed one).
  if (/^\d+$/.test(labels[labels.length - 1]!)) return false;

  return labels.every((label) => HOST_LABEL.test(label) && !label.startsWith("xn--"));
}

export function sanitizeEmailLocationUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LOCATION_URL_LENGTH) return null;
  // No whitespace (the regex whitespace class already includes U+2028 and
  // U+2029) and no C0/C1 control characters, anywhere in the value.
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (!isPublicAsciiHostname(url.hostname)) return null;

  return url.href;
}
