/**
 * Faz NOTIF.2D — real Web Push subscription logic, framework-free.
 *
 * Deliberately a separate module from notification-permission.ts (Faz
 * NOTIF.2C, already shipped to PROD): that module is permission-only and
 * its own tests/behaviour must not be able to regress just because this
 * file changes. The encode/decode helpers below are pure and fully
 * unit-testable; subscribeToPush/getExistingPushSubscription/
 * unsubscribeFromPush are thin PushManager wrappers that only run in a
 * real browser.
 *
 * Hard rules encoded here:
 *   - subscribeToPush() creates a NEW browser-level PushSubscription and
 *     must only be called from an explicit user-gesture click handler —
 *     same discipline as requestNotificationPermissionOnGesture (Faz
 *     NOTIF.2C). It is never called on mount or from an effect.
 *   - getExistingPushSubscription() never creates anything — it only
 *     reads whatever subscription (if any) the browser already holds.
 *   - This module never talks to Supabase directly. Saving/removing a
 *     subscription's SalonOS association goes through the Server
 *     Actions in lib/modules/settings/actions.ts, which call the
 *     existing Faz NOTIF.2A RPCs — this file only produces the raw
 *     values those actions need.
 */

export type ExtractedSubscription = {
  endpoint: string;
  p256dh: string;
  authKey: string;
};

/**
 * RFC 4648 §5 base64url -> Uint8Array, as required by
 * PushManager.subscribe's applicationServerKey option. atob() only
 * understands standard base64, so "-"/"_" must be translated back to
 * "+"/"/" and padding restored before decoding.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Inverse direction — ArrayBuffer -> base64url, unpadded. Used to encode
 * subscription.getKey("p256dh")/getKey("auth") the same way save_push_
 * subscription's callers elsewhere on the web conventionally transmit
 * Web Push key material.
 */
export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Pulls the raw fields save_push_subscription needs out of a real
 * PushSubscription. Throws rather than silently sending partial data if
 * the browser didn't negotiate p256dh/auth (shouldn't happen for a
 * subscription created with userVisibleOnly, but this is exactly the
 * kind of thing worth failing loudly on rather than saving garbage).
 */
export function extractSubscriptionKeys(subscription: PushSubscription): ExtractedSubscription {
  const p256dhKey = subscription.getKey("p256dh");
  const authKeyBuf = subscription.getKey("auth");
  if (!p256dhKey || !authKeyBuf) {
    throw new Error("push subscription is missing p256dh/auth keys");
  }
  return {
    endpoint: subscription.endpoint,
    p256dh: arrayBufferToBase64Url(p256dhKey),
    authKey: arrayBufferToBase64Url(authKeyBuf),
  };
}

/** The browser's existing subscription for this origin, if any. Never creates one. */
export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/**
 * Creates a NEW browser-level PushSubscription. Call ONLY from the "Bu
 * cihazı bildirimlere bağla" button's own click handler. userVisibleOnly
 * must be true — this app only ever sends notifications the user can
 * see, never silent/background pushes, and the browser requires this
 * flag to say so up front.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    // Uint8Array's own type is generic over ArrayBufferLike (which also
    // covers SharedArrayBuffer); BufferSource's ArrayBufferView variant
    // is narrower (ArrayBuffer only). new Uint8Array(n) always allocates
    // a plain ArrayBuffer at runtime, so this cast just satisfies a
    // lib.dom.d.ts strictness gap, not an actual type mismatch.
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });
}

/**
 * Unsubscribes the given browser-level PushSubscription. Returns
 * whatever the browser reports (true = it was subscribed and now isn't).
 * Does not touch the SalonOS-side association — the caller is
 * responsible for also calling removePushSubscriptionAction, and for
 * deciding what to do if one side succeeds and the other fails (see
 * that action's own doc comment).
 */
export async function unsubscribeFromPush(subscription: PushSubscription): Promise<boolean> {
  return subscription.unsubscribe();
}

/**
 * A short, human-friendly, privacy-light device label — "iPhone",
 * "Android", "Mac", "Windows", or "Bu cihaz" as a last resort. Coarse
 * platform family only: no model/serial/hardware id, no full user-agent
 * string, nothing that individually fingerprints the device.
 */
export function deriveDeviceLabel(): string {
  if (typeof navigator === "undefined") return "Bu cihaz";
  const ua = navigator.userAgent || "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Bu cihaz";
}
