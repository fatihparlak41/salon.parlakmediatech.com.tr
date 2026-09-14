/*
 * Faz NOTIF.2C — SalonOS Service Worker.
 *
 * PURPOSE: register cleanly and be ready to receive Web Push later. That
 * is all. This phase adds NO push subscription, NO VAPID, NO delivery.
 *
 * DELIBERATELY NOT HERE:
 *   - no `fetch` handler at all — no offline mode, no app-shell cache,
 *     no stale-while-revalidate, nothing. This is a push-capability
 *     foundation, not an offline PWA.
 *   - no Cache Storage use of any kind.
 *   - no caching of Supabase / API / RPC responses (there is no fetch
 *     handler to do so).
 *
 * Bump SW_VERSION on any change to force an update; the install/activate
 * pair below (skipWaiting + clients.claim) then rolls all open tabs onto
 * the new worker without a manual reload.
 */
var SW_VERSION = "notif2c-1";

importScripts("./sw-helpers.js");

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  // SW_VERSION is surfaced here so the live worker build is visible in
  // DevTools > Application > Service Workers without opening the source.
  console.info("[sw] activated", SW_VERSION);
  event.waitUntil(self.clients.claim());
});

// Push delivery does not exist yet (Faz NOTIF.2D). This handler is here
// so the worker is push-ready and so a malformed/hostile payload can
// never reach showNotification unfiltered — SalonOSPush.parsePushPayload
// always yields a privacy-safe { title, body, path } with generic
// fallbacks and no assumed customer PII.
self.addEventListener("push", function (event) {
  var payload = self.SalonOSPush.parsePushPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: "salonos-notification",
      data: { path: payload.path },
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  // Only ever a same-origin relative path; anything else -> "/". Deep
  // linking to a specific appointment is a later phase.
  var path = self.SalonOSPush.safeNotificationTargetPath(data.path);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if ("focus" in client) {
          if ("navigate" in client) {
            try {
              client.navigate(path);
            } catch {
              /* navigation across a document boundary can reject; focusing is enough */
            }
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(path);
      return undefined;
    }),
  );
});
