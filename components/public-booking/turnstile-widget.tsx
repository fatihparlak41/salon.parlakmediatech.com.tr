"use client";

import { useEffect, useId, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: (errorCode?: string) => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
let scriptLoadPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

/** Renders the Cloudflare Turnstile challenge and reports the resulting
 * token upward — verification of that token happens authoritatively on
 * the server (lib/modules/public-booking/turnstile.ts); this component
 * only ever produces a token, it never decides whether a booking is
 * allowed. `resetSignal`: bump this from the parent (e.g. on a failed
 * submit) to force a fresh challenge/token — a consumed or expired token
 * must never be resubmitted silently. */
export function TurnstileWidget({
  siteKey,
  onVerify,
  onExpire,
  resetSignal,
}: {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire: () => void;
  resetSignal: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const domId = useId();

  useEffect(() => {
    let cancelled = false;
    loadTurnstileScript().then(() => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: onVerify,
        "expired-callback": onExpire,
        // Diagnostic-only: Cloudflare's own documented client-side error
        // code (e.g. "300030", "600010" — see
        // https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/),
        // never anything else — no site key, no secret, no token, no
        // request payload passes through this callback at all. Behavior
        // is otherwise identical to before: onExpire still always runs.
        "error-callback": (errorCode) => {
          if (errorCode) {
            console.warn("[turnstile-widget] client-side error", { code: errorCode });
          }
          onExpire();
        },
      });
    });
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, onVerify, onExpire]);

  useEffect(() => {
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [resetSignal]);

  return <div ref={containerRef} id={`turnstile-${domId}`} />;
}
