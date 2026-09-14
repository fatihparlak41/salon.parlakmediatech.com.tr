"use client";

import { useEffect } from "react";

/**
 * Faz NOTIF.2C — registers /sw.js once, client-side only. Renders
 * nothing. Mounted from app/[locale]/layout.tsx so it runs on every
 * route with no SSR access to window/navigator.
 *
 * The Service Worker itself has no fetch handler and does no caching —
 * this is a Web Push capability foundation, not offline mode.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    let cancelled = false;
    // register() is idempotent — the browser dedupes by scriptURL+scope,
    // so a StrictMode double-invoke in dev registers nothing twice.
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      if (cancelled) return;
      // A failed registration must never crash the app; dev-only log.
      console.warn("[pwa] service worker registration failed", error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
