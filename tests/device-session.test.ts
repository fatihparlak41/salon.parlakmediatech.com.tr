import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_IDS_KEY,
  DEVICE_OWNER_KEY,
  createDeviceIdentity,
  disconnectThisBrowser,
  enforceDeviceOwnership,
  isForeignDevice,
  type KeyValueStore,
} from "@/lib/pwa/device-session";
import { deviceOwnerTag } from "@/lib/pwa/device-owner-tag";

/**
 * Faz ACCOUNT.1 (security) — the shared-browser policy, as pure logic:
 * who owns this browser's push subscription, what sign-out does, and what
 * happens when somebody else signs in. The browser wiring (localStorage,
 * PushManager) is injected here, so every rule is exercised without a
 * browser; tests/personal-notification-settings.test.ts pins the wiring by
 * source contract and the Playwright scenarios prove it end to end.
 */

const TAG_A = "a".repeat(32);
const TAG_B = "b".repeat(32);
const TENANT_1 = "11111111-1111-4111-8111-111111111111";
const TENANT_2 = "22222222-2222-4222-8222-222222222222";
const ROW_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeSubscription(unsubscribe = vi.fn(async () => true)) {
  return { unsubscribe };
}

describe("device identity store", () => {
  it("remembers the owner tag and the saved row ids per tenant, and forgets them on clear()", () => {
    const store = memoryStore();
    const identity = createDeviceIdentity(store);
    expect(identity.ownerTag()).toBeNull();
    identity.setOwnerTag(TAG_A);
    identity.rememberDevice(TENANT_1, ROW_1);
    identity.rememberDevice(TENANT_2, ROW_2);
    expect(identity.ownerTag()).toBe(TAG_A);
    expect(identity.knownDeviceIds()).toEqual({ [TENANT_1]: ROW_1, [TENANT_2]: ROW_2 });

    identity.forgetDevice(TENANT_1);
    expect(identity.knownDeviceIds()).toEqual({ [TENANT_2]: ROW_2 });
    identity.forgetDevice(TENANT_2);
    expect(store.data.has(DEVICE_IDS_KEY)).toBe(false);

    identity.rememberDevice(TENANT_1, ROW_1);
    identity.clear();
    expect(identity.ownerTag()).toBeNull();
    expect(identity.knownDeviceIds()).toEqual({});
    expect(store.data.size).toBe(0);
  });

  it("ignores tampered or malformed stored values instead of trusting them", () => {
    const store = memoryStore({
      [DEVICE_OWNER_KEY]: "not-a-tag",
      [DEVICE_IDS_KEY]: JSON.stringify({ "not-a-uuid": ROW_1, [TENANT_1]: "javascript:alert(1)", [TENANT_2]: ROW_2 }),
    });
    const identity = createDeviceIdentity(store);
    expect(identity.ownerTag()).toBeNull();
    expect(identity.knownDeviceIds()).toEqual({ [TENANT_2]: ROW_2 });

    store.data.set(DEVICE_IDS_KEY, "{not json");
    expect(identity.knownDeviceIds()).toEqual({});
    store.data.set(DEVICE_IDS_KEY, JSON.stringify(["array"]));
    expect(identity.knownDeviceIds()).toEqual({});

    // and it refuses to WRITE malformed values (the tampered original is left as it was; reads keep ignoring it)
    store.data.delete(DEVICE_IDS_KEY);
    identity.setOwnerTag("short");
    identity.rememberDevice("nope", ROW_1);
    identity.rememberDevice(TENANT_1, "nope");
    expect(store.data.get(DEVICE_OWNER_KEY)).toBe("not-a-tag");
    expect(store.data.has(DEVICE_IDS_KEY)).toBe(false);
    expect(identity.ownerTag()).toBeNull();
  });

  it("missing or throwing storage behaves as 'no recorded owner' — never an exception", () => {
    const none = createDeviceIdentity(null);
    none.setOwnerTag(TAG_A);
    none.rememberDevice(TENANT_1, ROW_1);
    none.clear();
    expect(none.ownerTag()).toBeNull();
    expect(none.knownDeviceIds()).toEqual({});

    const throwing: KeyValueStore = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    const identity = createDeviceIdentity(throwing);
    expect(() => { identity.setOwnerTag(TAG_A); identity.rememberDevice(TENANT_1, ROW_1); identity.forgetDevice(TENANT_1); identity.clear(); }).not.toThrow();
    expect(identity.ownerTag()).toBeNull();
    expect(isForeignDevice(identity, TAG_A)).toBe(false);
  });

  it("isForeignDevice: only a recorded owner who is somebody else counts", () => {
    const identity = createDeviceIdentity(memoryStore());
    expect(isForeignDevice(identity, TAG_A)).toBe(false); // no owner recorded (legacy)
    identity.setOwnerTag(TAG_A);
    expect(isForeignDevice(identity, TAG_A)).toBe(false);
    expect(isForeignDevice(identity, TAG_B)).toBe(true);
  });
});

describe("policy rule 2 — enforceDeviceOwnership (nobody inherits somebody else's device)", () => {
  it("the same person keeps their device untouched", async () => {
    const identity = createDeviceIdentity(memoryStore());
    identity.setOwnerTag(TAG_A);
    identity.rememberDevice(TENANT_1, ROW_1);
    const unsubscribe = vi.fn(async () => true);
    const getSubscription = vi.fn(async () => fakeSubscription(unsubscribe));
    expect(await enforceDeviceOwnership(TAG_A, { identity, getSubscription })).toBe("kept");
    expect(getSubscription).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(identity.ownerTag()).toBe(TAG_A);
  });

  it("a DIFFERENT person signing in drops the previous person's subscription and forgets their identity", async () => {
    const identity = createDeviceIdentity(memoryStore());
    identity.setOwnerTag(TAG_A);
    identity.rememberDevice(TENANT_1, ROW_1);
    const unsubscribe = vi.fn(async () => true);
    expect(await enforceDeviceOwnership(TAG_B, { identity, getSubscription: async () => fakeSubscription(unsubscribe) })).toBe("dropped");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(identity.ownerTag()).toBeNull();
    expect(identity.knownDeviceIds()).toEqual({});
  });

  it("it works in the other direction too (vice versa): A signing back in drops B's device", async () => {
    const identity = createDeviceIdentity(memoryStore());
    const unsubscribe = vi.fn(async () => true);
    const deps = { identity, getSubscription: async () => fakeSubscription(unsubscribe) };
    identity.setOwnerTag(TAG_A);
    expect(await enforceDeviceOwnership(TAG_B, deps)).toBe("dropped"); // B signs in: A's device goes
    identity.setOwnerTag(TAG_B); // B switches notifications on
    expect(await enforceDeviceOwnership(TAG_A, deps)).toBe("dropped"); // A signs in again: B's device goes
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("a browser with NO recorded owner (created before the policy) is left alone", async () => {
    const identity = createDeviceIdentity(memoryStore());
    const unsubscribe = vi.fn(async () => true);
    expect(await enforceDeviceOwnership(TAG_B, { identity, getSubscription: async () => fakeSubscription(unsubscribe) })).toBe("kept");
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("a browser that refuses to unsubscribe (or has no service worker) still forgets the foreign identity, and never throws", async () => {
    const identity = createDeviceIdentity(memoryStore());
    identity.setOwnerTag(TAG_A);
    expect(await enforceDeviceOwnership(TAG_B, { identity, getSubscription: async () => fakeSubscription(vi.fn(async () => { throw new Error("no"); })) })).toBe("dropped");
    expect(identity.ownerTag()).toBeNull();

    identity.setOwnerTag(TAG_A);
    expect(await enforceDeviceOwnership(TAG_B, { identity, getSubscription: async () => { throw new Error("service worker did not become ready"); } })).toBe("dropped");
    expect(identity.ownerTag()).toBeNull();
  });
});

describe("policy rule 1 — disconnectThisBrowser (signing out disconnects the device)", () => {
  it("drops the browser subscription, revokes exactly the rows this browser created, and forgets the identity", async () => {
    const identity = createDeviceIdentity(memoryStore());
    identity.setOwnerTag(TAG_A);
    identity.rememberDevice(TENANT_1, ROW_1);
    identity.rememberDevice(TENANT_2, ROW_2);
    const unsubscribe = vi.fn(async () => true);
    const revoke = vi.fn<(id: string) => Promise<unknown>>(async () => ({ success: true }));

    await disconnectThisBrowser({ identity, getSubscription: async () => fakeSubscription(unsubscribe), revoke });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls.map((c) => c[0]).sort()).toEqual([ROW_1, ROW_2]);
    expect(identity.ownerTag()).toBeNull();
    expect(identity.knownDeviceIds()).toEqual({});
  });

  it("with no known rows it still drops the subscription (legacy device) and revokes nothing", async () => {
    const identity = createDeviceIdentity(memoryStore());
    const unsubscribe = vi.fn(async () => true);
    const revoke = vi.fn<(id: string) => Promise<unknown>>(async () => undefined);
    await disconnectThisBrowser({ identity, getSubscription: async () => fakeSubscription(unsubscribe), revoke });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("is best effort: a failing unsubscribe or revoke never throws and the identity is forgotten regardless", async () => {
    const identity = createDeviceIdentity(memoryStore());
    identity.setOwnerTag(TAG_A);
    identity.rememberDevice(TENANT_1, ROW_1);
    await expect(
      disconnectThisBrowser({
        identity,
        getSubscription: async () => { throw new Error("service worker did not become ready"); },
        revoke: async () => { throw new Error("network down"); },
      }),
    ).resolves.toBeUndefined();
    expect(identity.ownerTag()).toBeNull();
  });

  it("never holds a sign-out hostage: a subscription lookup that never settles is abandoned after the time budget", async () => {
    const identity = createDeviceIdentity(memoryStore());
    identity.setOwnerTag(TAG_A);
    const started = Date.now();
    await disconnectThisBrowser({
      identity,
      getSubscription: () => new Promise(() => {}), // hangs forever
      revoke: () => new Promise(() => {}), // hangs forever
      budgetMs: 80,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(identity.ownerTag()).toBeNull();
  });

  it("only ever hands the remembered ROW IDS to revoke — never an endpoint, key or user id", async () => {
    const identity = createDeviceIdentity(memoryStore());
    identity.rememberDevice(TENANT_1, ROW_1);
    const revoke = vi.fn<(id: string) => Promise<unknown>>(async () => undefined);
    await disconnectThisBrowser({ identity, getSubscription: async () => null, revoke });
    expect(revoke.mock.calls).toEqual([[ROW_1]]);
  });
});

describe("deviceOwnerTag (server side)", () => {
  it("is stable per user, differs between users, is 32 hex characters and contains nothing recognisable of the user id", () => {
    const a = "3062ea6d-9266-44ed-ab78-41225085cea3";
    const b = "4d01bec8-dc74-4b80-b9b8-3d5e500dda80";
    expect(deviceOwnerTag(a)).toBe(deviceOwnerTag(a));
    expect(deviceOwnerTag(a)).not.toBe(deviceOwnerTag(b));
    expect(deviceOwnerTag(a)).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceOwnerTag(a)).not.toContain(a.replace(/-/g, "").slice(0, 8));
  });
});
