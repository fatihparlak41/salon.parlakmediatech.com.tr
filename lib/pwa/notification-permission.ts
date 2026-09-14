/**
 * Faz NOTIF.2C — notification permission UX logic, framework-free.
 *
 * The React card (components/settings/notification-settings-card.tsx) is
 * a thin shell over these pure functions so the decision logic is fully
 * unit-testable in the project's Node test environment (no jsdom).
 *
 * Hard rules encoded here:
 *   - Notification.requestPermission() is only ever reachable through
 *     requestNotificationPermissionOnGesture(), which the card wires to a
 *     click handler and nothing else. It also refuses to re-prompt once
 *     the user has answered (permission !== "default"), so a denied user
 *     is never re-asked.
 *   - This module NEVER touches PushManager.subscribe / VAPID / any
 *     endpoint save. Browser permission and SalonOS category preferences
 *     are separate concerns and stay separate.
 */

export type NotificationPermissionState = "default" | "granted" | "denied";

export type NotificationEnv = {
  /** Notification + serviceWorker + PushManager all present. */
  isSupported: boolean;
  /** iPhone / iPad. */
  isIOS: boolean;
  /** Launched as an installed / Home Screen app (not an in-browser tab). */
  isStandalone: boolean;
  permission: NotificationPermissionState;
};

export type NotificationView =
  | { kind: "unsupported" }
  | { kind: "ios-needs-install" }
  | { kind: "default"; canRequest: true }
  | { kind: "granted" }
  | { kind: "denied" };

/**
 * Single source of truth for what the settings card should show.
 *
 * iOS-in-Safari is checked BEFORE "unsupported": an iPhone browser has no
 * Notification API at all, but the right message there is "add SalonOS to
 * your Home Screen", not a dead "your browser can't do this".
 */
export function deriveNotificationView(env: NotificationEnv): NotificationView {
  if (env.isIOS && !env.isStandalone) {
    return { kind: "ios-needs-install" };
  }
  if (!env.isSupported) {
    return { kind: "unsupported" };
  }
  switch (env.permission) {
    case "granted":
      return { kind: "granted" };
    case "denied":
      return { kind: "denied" };
    default:
      return { kind: "default", canRequest: true };
  }
}

// --- browser capability / platform detection (client-only) ------------

export function readNotificationPermission(): NotificationPermissionState {
  if (typeof Notification === "undefined") return "default";
  const p = Notification.permission;
  return p === "granted" || p === "denied" ? p : "default";
}

export function isNotificationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

export function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ Safari reports a Mac UA; the touch-capable check
  // distinguishes an actual iPad from a desktop Mac.
  return (
    ua.includes("Macintosh") &&
    typeof document !== "undefined" &&
    "ontouchend" in document
  );
}

export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  const byDisplayMode =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  // navigator.standalone is the iOS-only legacy signal, still needed on
  // older iOS where display-mode may not report standalone reliably.
  const iosLegacy =
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return byDisplayMode || iosLegacy;
}

export function readNotificationEnv(): NotificationEnv {
  return {
    isSupported: isNotificationSupported(),
    isIOS: isIOSDevice(),
    isStandalone: isStandaloneDisplayMode(),
    permission: readNotificationPermission(),
  };
}

// --- gesture-gated permission request ---------------------------------

/**
 * The ONLY path to Notification.requestPermission(). Call strictly from a
 * user gesture (tap/click) — never on load, login, install, from an
 * effect, or when a modal opens. Refuses to re-prompt once answered.
 */
export async function requestNotificationPermissionOnGesture(): Promise<NotificationPermissionState> {
  if (
    typeof Notification === "undefined" ||
    typeof Notification.requestPermission !== "function"
  ) {
    return "denied";
  }
  if (Notification.permission !== "default") {
    // Already granted or denied — reporting only, no second prompt.
    return readNotificationPermission();
  }
  try {
    const result = await Notification.requestPermission();
    return result === "granted" || result === "denied" ? result : "default";
  } catch {
    return "default";
  }
}

// --- permission reactivity (no polling) ------------------------------

/**
 * Re-read Notification.permission whenever the page regains
 * focus/visibility (the user may have left SalonOS, changed the setting
 * in OS/browser settings, and come back). Calls onChange only when the
 * value actually changed. Returns an unsubscribe function. No polling,
 * no interval.
 */
export function subscribeToPermissionChanges(
  onChange: (permission: NotificationPermissionState) => void,
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  let last = readNotificationPermission();
  const check = () => {
    if (document.visibilityState === "hidden") return;
    const current = readNotificationPermission();
    if (current !== last) {
      last = current;
      onChange(current);
    }
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  return () => {
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("focus", check);
  };
}
