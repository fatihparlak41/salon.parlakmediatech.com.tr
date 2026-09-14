"use client";

import { useSyncExternalStore } from "react";
import {
  readNotificationEnv,
  subscribeToPermissionChanges,
  type NotificationEnv,
} from "./notification-permission";

/**
 * Faz NOTIF.2C — client store for the notification environment.
 *
 * useSyncExternalStore instead of useState+useEffect: SSR sees `null`
 * (the "checking" placeholder), the client swaps in the real capability
 * + permission after hydration, and it re-reads whenever the user
 * returns to the tab (via subscribeToPermissionChanges' own
 * focus/visibility listeners — no polling). This keeps the settings card
 * free of any effect that calls setState.
 *
 * The snapshot is memoised on its four fields so getSnapshot returns a
 * stable reference when nothing changed (a fresh object every call would
 * loop useSyncExternalStore).
 */

const listeners = new Set<() => void>();
let snapshot: NotificationEnv | null = null;
let teardown: (() => void) | null = null;

function computeSnapshot(): NotificationEnv {
  const next = readNotificationEnv();
  if (
    snapshot &&
    snapshot.isSupported === next.isSupported &&
    snapshot.isIOS === next.isIOS &&
    snapshot.isStandalone === next.isStandalone &&
    snapshot.permission === next.permission
  ) {
    return snapshot;
  }
  snapshot = next;
  return next;
}

function emit(): void {
  computeSnapshot();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    teardown = subscribeToPermissionChanges(() => emit());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && teardown) {
      teardown();
      teardown = null;
    }
  };
}

/**
 * Force a re-read of the environment — call right after a user gesture
 * that may have changed the permission (the enable button), so the card
 * updates without waiting for a focus event.
 */
export function refreshNotificationEnv(): void {
  emit();
}

export function useNotificationEnv(): NotificationEnv | null {
  return useSyncExternalStore(
    subscribe,
    computeSnapshot,
    () => null,
  );
}
