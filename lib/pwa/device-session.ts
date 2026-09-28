/**
 * Faz ACCOUNT.1 (security) — who owns THIS browser's push subscription,
 * and what happens to it when the person signs out or somebody else signs in
 * on the same browser.
 *
 * THE PROBLEM. A browser has exactly one push subscription per origin, and
 * it is tied to a browser profile, not to a login. Before this policy a
 * member who signed out left the subscription (and its database rows)
 * behind: the next person to sign in on that computer kept receiving the
 * previous member's appointment notifications — customer names included —
 * until they happened to open their own Hesabım page, which then silently
 * adopted the device. The mirror image held too.
 *
 * THE POLICY (one notification identity per browser profile):
 *   1. Signing out DISCONNECTS the device for the person signing out: the
 *      browser-level subscription is dropped (that alone stops every push
 *      for that endpoint — the push service answers 404/410 from then on,
 *      and the worker revokes such a row on its first attempt) and the
 *      rows this browser is known to have created are revoked immediately.
 *      Cleanup is best effort and time-boxed: it can never block or fail a
 *      sign-out.
 *   2. Nobody inherits somebody else's device. This browser remembers a
 *      non-reversible TAG of the person who last connected it. On every
 *      authenticated page load a different person's tag means the
 *      subscription is not theirs: it is dropped, and they must switch
 *      notifications on themselves, which creates a fresh subscription.
 *      (This covers sessions that ended without pressing "Çıkış yap":
 *      expiry, a cleared cookie.)
 *   3. Server side, save_push_subscription still revokes every OTHER user's
 *      rows for the same endpoint — the last line of defence.
 *   4. A browser with a subscription but NO recorded owner (created before
 *      this policy existed) is left alone and adopted by whoever opens
 *      Hesabım first, exactly as before — dropping it would silently stop a
 *      working owner's notifications on release day.
 *
 * Nothing here touches another member's data: the tag is a hash, the
 * remembered row ids are only ever handed to remove_push_subscription,
 * which refuses ids that are not the caller's own (NF004).
 *
 * Framework-free and dependency-injected so the rules are unit-testable.
 */

export const DEVICE_OWNER_KEY = "salonos.push.owner";
export const DEVICE_IDS_KEY = "salonos.push.devices";

const TAG_PATTERN = /^[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The subset of Storage this module needs (localStorage in the browser). */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** The subset of PushSubscription this module needs. */
export type UnsubscribableSubscription = { unsubscribe(): Promise<boolean> };

export type DeviceIdentity = {
  ownerTag(): string | null;
  setOwnerTag(tag: string): void;
  knownDeviceIds(): Record<string, string>;
  rememberDevice(tenantId: string, subscriptionId: string): void;
  forgetDevice(tenantId: string): void;
  clear(): void;
};

/**
 * Storage can be missing, full, or throw (private windows, blocked site
 * data): every access is guarded and "no storage" behaves as "no recorded
 * owner", i.e. the safe legacy behaviour.
 */
export function createDeviceIdentity(store: KeyValueStore | null): DeviceIdentity {
  const guard = <T>(fn: () => T, fallback: T): T => {
    if (!store) return fallback;
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  const readIds = (): Record<string, string> =>
    guard(() => {
      const parsed: unknown = JSON.parse(store!.getItem(DEVICE_IDS_KEY) ?? "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const clean: Record<string, string> = {};
      for (const [tenantId, id] of Object.entries(parsed as Record<string, unknown>)) {
        if (UUID_PATTERN.test(tenantId) && typeof id === "string" && UUID_PATTERN.test(id)) clean[tenantId] = id;
      }
      return clean;
    }, {});

  return {
    ownerTag: () =>
      guard(() => {
        const value = store!.getItem(DEVICE_OWNER_KEY);
        return value !== null && TAG_PATTERN.test(value) ? value : null;
      }, null),
    setOwnerTag: (tag) => {
      if (!TAG_PATTERN.test(tag)) return;
      guard(() => store!.setItem(DEVICE_OWNER_KEY, tag), undefined);
    },
    knownDeviceIds: readIds,
    rememberDevice: (tenantId, subscriptionId) => {
      if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(subscriptionId)) return;
      guard(() => store!.setItem(DEVICE_IDS_KEY, JSON.stringify({ ...readIds(), [tenantId]: subscriptionId })), undefined);
    },
    forgetDevice: (tenantId) => {
      guard(() => {
        const ids = readIds();
        delete ids[tenantId];
        if (Object.keys(ids).length === 0) store!.removeItem(DEVICE_IDS_KEY);
        else store!.setItem(DEVICE_IDS_KEY, JSON.stringify(ids));
      }, undefined);
    },
    clear: () => {
      guard(() => store!.removeItem(DEVICE_OWNER_KEY), undefined);
      guard(() => store!.removeItem(DEVICE_IDS_KEY), undefined);
    },
  };
}

/** True when a recorded owner exists and it is somebody other than `currentTag`. */
export function isForeignDevice(identity: DeviceIdentity, currentTag: string): boolean {
  const owner = identity.ownerTag();
  return owner !== null && owner !== currentTag;
}

export type DeviceDeps = {
  identity: DeviceIdentity;
  /** The browser's existing subscription, or null. Must never create one. */
  getSubscription(): Promise<UnsubscribableSubscription | null>;
};

export type GuardOutcome = "kept" | "dropped";

/**
 * Policy rule 2. Drops the browser's subscription when it belongs to a
 * different person than the one now signed in, then forgets the old
 * identity. A recorded-owner-less browser is left alone (rule 4).
 */
export async function enforceDeviceOwnership(currentTag: string, deps: DeviceDeps): Promise<GuardOutcome> {
  if (!isForeignDevice(deps.identity, currentTag)) return "kept";
  try {
    const subscription = await deps.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    // Even if the browser refuses, the remembered identity must go: the
    // page must not go on believing the device is connected.
  }
  deps.identity.clear();
  return "dropped";
}

export const SIGN_OUT_CLEANUP_BUDGET_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Policy rule 1. Called from the sign-out form BEFORE the session ends (the
 * row revocations need it). Never throws and never takes longer than
 * `budgetMs`: a stuck service worker or a slow network cannot hold a
 * logout hostage — the worst outcome is the pre-policy behaviour.
 */
export async function disconnectThisBrowser(
  deps: DeviceDeps & { revoke(subscriptionId: string): Promise<unknown>; budgetMs?: number },
): Promise<void> {
  const ids = Object.values(deps.identity.knownDeviceIds());
  // The two halves are independent, so they run side by side inside one
  // time budget: dropping the browser subscription (no subscription, no
  // deliveries) and revoking the database rows this browser created (the
  // server stops sending at once). Either alone already ends the leak.
  const dropSubscription = (async () => {
    try {
      const subscription = await deps.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch {
      /* best effort */
    }
  })();
  const revokeRows = Promise.allSettled(ids.map((id) => deps.revoke(id)));
  const work = Promise.allSettled([dropSubscription, revokeRows]);
  await Promise.race([work, delay(deps.budgetMs ?? SIGN_OUT_CLEANUP_BUDGET_MS)]);
  deps.identity.clear();
}
