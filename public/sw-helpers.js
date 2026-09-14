/*
 * Faz NOTIF.2C — Service Worker helper functions.
 *
 * Classic worker script (no ESM): loaded by sw.js via importScripts, and
 * also loadable in a Node `vm` sandbox so tests exercise the exact same
 * implementation the Service Worker runs (no drift between a tested copy
 * and a shipped copy).
 *
 * There is NO push delivery yet (no VAPID, no subscription — Faz NOTIF.2D).
 * These helpers only make the future `push` / `notificationclick`
 * handlers safe by construction:
 *   - push payloads are parsed defensively and never trusted for PII
 *   - notificationclick only ever opens a same-origin relative path,
 *     never an arbitrary URL supplied by push data; anything unsafe or
 *     unparseable falls back to "/".
 */
(function (scope) {
  var FALLBACK_TITLE = "SalonOS";
  var FALLBACK_BODY = "Yeni bir bildiriminiz var.";
  var FALLBACK_PATH = "/";
  var MAX_PATH_LENGTH = 512;

  function hasControlChar(value) {
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  }

  /**
   * Normalise a push-supplied target into a safe SAME-ORIGIN relative
   * path, or "/" if it cannot be trusted. Never returns an absolute URL,
   * a protocol-relative URL, or anything with a scheme.
   */
  function safeNotificationTargetPath(raw) {
    if (typeof raw !== "string") return FALLBACK_PATH;
    var value = raw.trim();
    if (value.length === 0 || value.length > MAX_PATH_LENGTH) return FALLBACK_PATH;
    // Must be a single-slash-rooted path. Rejects "//host" (protocol-
    // relative), "https://…", "javascript:…", "mailto:…", bare "foo",
    // backslash tricks, and control characters.
    if (value.charAt(0) !== "/") return FALLBACK_PATH;
    if (value.charAt(1) === "/" || value.charAt(1) === "\\") return FALLBACK_PATH;
    if (value.indexOf("\\") !== -1) return FALLBACK_PATH;
    if (value.indexOf("://") !== -1) return FALLBACK_PATH;
    if (hasControlChar(value)) return FALLBACK_PATH;
    return value;
  }

  /**
   * Defensively turn a PushEvent into { title, body, path }. Any parse
   * failure, wrong type, or missing field collapses to a privacy-safe
   * generic notification — the payload is never assumed to contain
   * customer names, phone numbers, emails or notes.
   */
  function parsePushPayload(event) {
    var result = { title: FALLBACK_TITLE, body: FALLBACK_BODY, path: FALLBACK_PATH };
    var data = event && event.data;
    if (!data) return result;

    var parsed = null;
    try {
      parsed = data.json();
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== "object") {
      // Not JSON (or JSON that isn't an object) — try plain text as a
      // body, still with the safe fallback title.
      var text = "";
      try {
        text = data.text();
      } catch {
        text = "";
      }
      if (typeof text === "string" && text.trim().length > 0 && text.length <= 2000) {
        result.body = text.trim();
      }
      return result;
    }

    if (typeof parsed.title === "string" && parsed.title.trim().length > 0) {
      result.title = parsed.title.trim().slice(0, 200);
    }
    if (typeof parsed.body === "string" && parsed.body.trim().length > 0) {
      result.body = parsed.body.trim().slice(0, 500);
    }
    result.path = safeNotificationTargetPath(parsed.path);
    return result;
  }

  scope.SalonOSPush = {
    safeNotificationTargetPath: safeNotificationTargetPath,
    parsePushPayload: parsePushPayload,
    FALLBACK_TITLE: FALLBACK_TITLE,
    FALLBACK_BODY: FALLBACK_BODY,
    FALLBACK_PATH: FALLBACK_PATH,
  };
})(typeof self !== "undefined" ? self : this);
