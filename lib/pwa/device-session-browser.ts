import { createDeviceIdentity, type DeviceDeps, type KeyValueStore } from "./device-session";
import { isNotificationSupported } from "./notification-permission";
import { getExistingPushSubscription } from "./push-subscription";

/**
 * Faz ACCOUNT.1 (security) — the real-browser wiring of lib/pwa/device-
 * session.ts (the policy itself). Client-only: touches localStorage,
 * Notification and the service worker.
 */

/** Short: these run on page load and on sign-out, never on a user's critical path. */
const SERVICE_WORKER_WAIT_MS = 2500;

export function browserKeyValueStore(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function browserDeviceIdentity() {
  return createDeviceIdentity(browserKeyValueStore());
}

export function browserDeviceDeps(): DeviceDeps {
  return {
    identity: browserDeviceIdentity(),
    getSubscription: async () => {
      if (!isNotificationSupported()) return null;
      return getExistingPushSubscription({ timeoutMs: SERVICE_WORKER_WAIT_MS });
    },
  };
}
