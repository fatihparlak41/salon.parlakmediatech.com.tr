import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "@/app/manifest";
import {
  deriveNotificationView,
  requestNotificationPermissionOnGesture,
  subscribeToPermissionChanges,
  type NotificationEnv,
} from "@/lib/pwa/notification-permission";

/**
 * Faz NOTIF.2C — PWA shell + notification permission UX.
 *
 * The project's test environment is "node" (no jsdom), so the React card
 * is kept a thin shell over lib/pwa/notification-permission.ts and the
 * Service Worker's payload/URL safety lives in public/sw-helpers.js —
 * both fully exercised here without rendering. Component-level rules
 * (requestPermission never on render, etc.) are asserted against source.
 */

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// Strip /* */ and // comments so the "forbidden pattern" scans below
// check executable code only, not doc comments that promise an absence.
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Load the SW helper the same way the Service Worker does (classic
// script, attaches to `self`) so tests hit the exact shipped code.
function loadSwHelpers() {
  const ctx: { self: Record<string, unknown> } = { self: {} };
  vm.runInNewContext(read("public/sw-helpers.js"), ctx);
  return ctx.self.SalonOSPush as {
    safeNotificationTargetPath: (raw: unknown) => string;
    parsePushPayload: (event: unknown) => { title: string; body: string; path: string };
    FALLBACK_TITLE: string;
    FALLBACK_BODY: string;
    FALLBACK_PATH: string;
  };
}

const env = (over: Partial<NotificationEnv>): NotificationEnv => ({
  isSupported: true,
  isIOS: false,
  isStandalone: false,
  permission: "default",
  ...over,
});

// ============================ MANIFEST ============================

describe("manifest", () => {
  const m = manifest();

  it("1. exists and is a well-formed manifest object", () => {
    expect(m).toBeTypeOf("object");
    expect(m.icons?.length).toBeGreaterThan(0);
  });

  it("2. name and short_name are SalonOS", () => {
    expect(m.name).toBe("SalonOS");
    expect(m.short_name).toBe("SalonOS");
  });

  it("3. display is standalone", () => {
    expect(m.display).toBe("standalone");
  });

  it("4. start_url and scope are the app root", () => {
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.id).toBe("/");
  });

  it("4b. theme/background colours are the design-system tokens, not invented", () => {
    // --primary (light) #055959, --background (light) #fdfbf9 — app/globals.css
    expect(m.theme_color).toBe("#055959");
    expect(m.background_color).toBe("#fdfbf9");
  });

  it("5. every icon entry resolves to a real static PNG of the declared size, maskable flagged only on the maskable asset", () => {
    const pngSize = (rel: string) => {
      const b = readFileSync(join(root, rel));
      expect(b.readUInt32BE(0)).toBe(0x89504e47); // PNG signature
      return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
    };
    for (const icon of m.icons ?? []) {
      expect(typeof icon.src).toBe("string");
      expect(icon.src.startsWith("/")).toBe(true);
      expect(icon.sizes).toMatch(/^\d+x\d+$/);
      expect(icon.type).toBe("image/png");
      // src is a public/ path — the file exists and its real pixel
      // dimensions match the declared `sizes`.
      expect(pngSize(join("public", icon.src))).toBe(icon.sizes);
      if (icon.purpose === "maskable") {
        expect(icon.src).toContain("maskable");
      }
    }
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
    // The temporary teal-"S" placeholder routes are gone.
    expect(() => read("app/icon.tsx")).toThrow();
    expect(() => read("app/apple-icon.tsx")).toThrow();
    // favicon is a real multi-frame .ico, not the Next.js starter.
    const ico = readFileSync(join(root, "app/favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1); // ICO type
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(3); // >=3 frames (16/32/48)
  });

  it("5b. icons are cropped from the genuine brand asset — no redraw / no text rendering", () => {
    const gen = read("scripts/generate-pwa-icons.mjs");
    expect(gen).toContain("public/brand/SalonOs_Logo.png");
    // pure crop + resize + composite pipeline, never a font/text renderer.
    expect(gen).not.toMatch(/ImageResponse|fontFamily|drawText|fillText/);
    expect(read("scripts/_png-lib.mjs")).not.toMatch(/ImageResponse|fillText|fontFamily/);
    // the genuine source is present and is the confirmed 1254x1254 RGBA PNG.
    const src = readFileSync(join(root, "public/brand/SalonOs_Logo.png"));
    expect(src.readUInt32BE(0)).toBe(0x89504e47);
    expect(`${src.readUInt32BE(16)}x${src.readUInt32BE(20)}`).toBe("1254x1254");
  });

  it("<link rel=manifest> and Apple standalone metadata are wired in the root layout", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toContain('manifest: "/manifest.webmanifest"');
    expect(layout).toContain("appleWebApp");
    expect(layout).toContain("capable: true");
    expect(layout).toContain('title: "SalonOS"');
    expect(layout).toContain("themeColor");
  });
});

// ========================= SERVICE WORKER =========================

describe("service worker", () => {
  const sw = read("public/sw.js");
  const helpers = read("public/sw-helpers.js");
  const register = read("components/pwa/service-worker-register.tsx");

  it("6. the service worker file exists and installs/activates cleanly", () => {
    expect(sw).toContain('addEventListener("install"');
    expect(sw).toContain("skipWaiting()");
    expect(sw).toContain('addEventListener("activate"');
    expect(sw).toContain("clients.claim()");
  });

  it("7. registration path and scope are correct, client-only, error-safe", () => {
    expect(register).toContain('"use client"');
    expect(register).toContain('register("/sw.js", { scope: "/" })');
    expect(register).toContain('"serviceWorker" in navigator');
    expect(register).toContain(".catch(");
  });

  it("8. no offline/fetch/cache strategy of any kind", () => {
    const code = codeOnly(sw);
    expect(code).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(code).not.toMatch(/caches\./);
    expect(code).not.toMatch(/\bcache\.(put|match|add)/);
    expect(code).not.toMatch(/CacheStorage/);
  });

  it("9. no Supabase / API / RPC response caching", () => {
    for (const src of [codeOnly(sw), codeOnly(helpers)]) {
      expect(src.toLowerCase()).not.toContain("supabase");
      expect(src).not.toContain("/rest/v1");
      expect(src).not.toMatch(/\.rpc\(/);
    }
    // sw.js does not fetch anything at all.
    expect(codeOnly(sw)).not.toMatch(/\bfetch\(/);
  });

  it("10. push payload parsing fails safe on every malformed shape", () => {
    const { parsePushPayload, FALLBACK_TITLE, FALLBACK_BODY, FALLBACK_PATH } = loadSwHelpers();
    const safe = { title: FALLBACK_TITLE, body: FALLBACK_BODY, path: FALLBACK_PATH };

    expect(parsePushPayload(undefined)).toEqual(safe);
    expect(parsePushPayload({})).toEqual(safe);
    expect(parsePushPayload({ data: null })).toEqual(safe);
    expect(parsePushPayload({ data: { json() { throw new Error("boom"); }, text() { return ""; } } })).toEqual(safe);
    expect(parsePushPayload({ data: { json() { return "a string, not an object"; }, text() { return ""; } } })).toEqual(safe);
    expect(parsePushPayload({ data: { json() { return [1, 2, 3]; }, text() { return ""; } } })).toEqual(safe);
    expect(parsePushPayload({ data: { json() { return { title: 123, body: {} }; } } })).toEqual(safe);

    // A well-formed payload is honoured, and any path is normalised.
    const ok = parsePushPayload({
      data: { json: () => ({ title: "Yeni randevu", body: "Bir randevu oluşturuldu.", path: "/app/x/calendar" }) },
    });
    expect(ok).toEqual({ title: "Yeni randevu", body: "Bir randevu oluşturuldu.", path: "/app/x/calendar" });

    const hostile = parsePushPayload({
      data: { json: () => ({ title: "x", body: "y", path: "https://evil.example/steal" }) },
    });
    expect(hostile.path).toBe("/");
  });

  it("11. notificationclick only ever resolves a safe same-origin relative path", () => {
    const { safeNotificationTargetPath } = loadSwHelpers();

    // Safe — passed through unchanged.
    expect(safeNotificationTargetPath("/")).toBe("/");
    expect(safeNotificationTargetPath("/app/bella/calendar")).toBe("/app/bella/calendar");
    expect(safeNotificationTargetPath("  /app/x  ")).toBe("/app/x");

    // Unsafe — every one collapses to "/".
    const nul = String.fromCharCode(0);
    for (const bad of [
      "https://evil.example/x",
      "http://evil.example",
      "//evil.example/x",
      "javascript:alert(1)",
      "mailto:a@b.c",
      "app/x",
      "",
      "   ",
      "/app\\..\\secret",
      "/app/" + nul + "x",
      123,
      null,
      undefined,
      {},
      "/" + "x".repeat(600),
    ]) {
      expect(safeNotificationTargetPath(bad as unknown as string)).toBe("/");
    }

    // The SW actually routes clicks through this guard, never a raw URL.
    expect(sw).toContain("safeNotificationTargetPath");
    expect(sw).not.toMatch(/openWindow\(\s*data\.path\s*\)/);
    expect(sw).not.toMatch(/openWindow\(\s*event\.notification\.data/);
  });
});

// ========================= PERMISSION UX =========================

describe("permission UX state", () => {
  it("12. unsupported environment -> unsupported state", () => {
    expect(deriveNotificationView(env({ isSupported: false }))).toEqual({ kind: "unsupported" });
  });

  it("13. iOS browser (not standalone) -> Home Screen guidance, even before support is known", () => {
    expect(deriveNotificationView(env({ isIOS: true, isStandalone: false, isSupported: false }))).toEqual({
      kind: "ios-needs-install",
    });
    // iOS-not-standalone wins even if some support bits look present.
    expect(deriveNotificationView(env({ isIOS: true, isStandalone: false, isSupported: true }))).toEqual({
      kind: "ios-needs-install",
    });
  });

  it("14. iOS standalone + permission default -> primary 'enable' affordance", () => {
    expect(deriveNotificationView(env({ isIOS: true, isStandalone: true, permission: "default" }))).toEqual({
      kind: "default",
      canRequest: true,
    });
  });

  it("15. granted -> granted state", () => {
    expect(deriveNotificationView(env({ permission: "granted" }))).toEqual({ kind: "granted" });
  });

  it("16. denied -> denied state, with no request affordance", () => {
    const view = deriveNotificationView(env({ permission: "denied" }));
    expect(view).toEqual({ kind: "denied" });
    expect("canRequest" in view).toBe(false);
  });

  it("17. the card never calls requestPermission on render / from an effect", () => {
    const card = read("components/settings/notification-settings-card.tsx");
    // The gesture-gated request is referenced exactly once, only in the
    // click handler.
    const calls = card.match(/requestNotificationPermissionOnGesture\(/g) ?? [];
    expect(calls.length).toBe(1);
    const handlerIdx = card.indexOf("handleEnableClick");
    const callIdx = card.indexOf("requestNotificationPermissionOnGesture(");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(handlerIdx);
    // No useEffect body contains a permission request.
    for (const m of card.matchAll(/useEffect\([\s\S]*?\n {2}\}, \[\]\);/g)) {
      expect(m[0]).not.toContain("requestNotificationPermission");
      expect(m[0]).not.toMatch(/requestPermission/);
    }
    expect(card).toContain("onClick={handleEnableClick}");
  });

  it("18. an explicit gesture calls Notification.requestPermission exactly once", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const result = await requestNotificationPermissionOnGesture();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result).toBe("granted");
  });

  it("19. a denied user is never re-prompted", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    vi.stubGlobal("Notification", { permission: "denied", requestPermission });
    const result = await requestNotificationPermissionOnGesture();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(result).toBe("denied");
  });

  it("19b. an already-granted user is not re-prompted either", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });
    const result = await requestNotificationPermissionOnGesture();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(result).toBe("granted");
  });

  it("20. focus/visibility refreshes the shown permission, without polling", () => {
    const listeners: Record<string, Array<() => void>> = {};
    const add = (t: string, fn: () => void) => {
      (listeners[t] ??= []).push(fn);
    };
    const remove = (t: string, fn: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    };
    const fakeDoc = { visibilityState: "visible", addEventListener: add, removeEventListener: remove };
    const fakeWin = { addEventListener: add, removeEventListener: remove };
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("window", fakeWin);
    vi.stubGlobal("Notification", { permission: "default" });

    const onChange = vi.fn();
    const unsub = subscribeToPermissionChanges(onChange);

    // No change yet.
    listeners["visibilitychange"]?.forEach((f) => f());
    expect(onChange).not.toHaveBeenCalled();

    // User granted it in OS settings, then came back.
    (globalThis.Notification as unknown as { permission: string }).permission = "granted";
    listeners["visibilitychange"]?.forEach((f) => f());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("granted");

    // Same value again -> no duplicate fire.
    listeners["focus"]?.forEach((f) => f());
    expect(onChange).toHaveBeenCalledTimes(1);

    // After unsubscribe, nothing fires.
    unsub();
    (globalThis.Notification as unknown as { permission: string }).permission = "denied";
    listeners["visibilitychange"]?.forEach((f) => f());
    listeners["focus"]?.forEach((f) => f());
    expect(onChange).toHaveBeenCalledTimes(1);

    // Reactivity is event-driven, never a timer.
    const src = codeOnly(read("lib/pwa/notification-permission.ts"));
    expect(src).not.toMatch(/setInterval|setTimeout/);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

// ==================== SECURITY / REGRESSION ====================

describe("security / regression", () => {
  const NEW_FILES = [
    "app/manifest.ts",
    "public/sw.js",
    "public/sw-helpers.js",
    "lib/pwa/notification-permission.ts",
    "lib/pwa/use-notification-env.ts",
    "components/pwa/service-worker-register.tsx",
    "components/settings/notification-settings-card.tsx",
    "scripts/generate-pwa-icons.mjs",
    "scripts/_png-lib.mjs",
  ];
  const rawSources = NEW_FILES.map((f) => read(f)).join("\n");
  const sources = codeOnly(rawSources);

  it("21. no service_role key / admin client introduced", () => {
    expect(sources).not.toMatch(/service_role|SERVICE_ROLE|supabase\/admin/i);
  });

  it("22. no VAPID / application server key introduced", () => {
    expect(sources).not.toMatch(/vapid|applicationServerKey/i);
  });

  it("23. no PushSubscription created / saved", () => {
    expect(sources).not.toMatch(/pushManager\.subscribe|\.subscribe\(|save_push_subscription|getSubscription/);
    // A capability check for the PushManager interface is allowed and is
    // NOT a subscription.
    expect(read("lib/pwa/notification-permission.ts")).toContain('"PushManager" in window');
  });

  it("24. no SQL migration / grant added this phase", () => {
    expect(sources).not.toMatch(/create (table|function|policy)|grant .*to (authenticated|anon)/i);
  });

  it("25. no notification_events reader / consumer introduced", () => {
    expect(sources).not.toMatch(/notification_events/);
  });

  it("26. public booking / guest booking is untouched", () => {
    expect(sources).not.toMatch(/create_guest_booking|booking_gateway|\/book\//);
  });

  it("27. tenant layout change is strictly additive (renders children + a null SW register)", () => {
    const localeLayout = read("app/[locale]/layout.tsx");
    expect(localeLayout).toContain("{children}");
    expect(localeLayout).toContain("<ServiceWorkerRegister />");
    expect(read("components/pwa/service-worker-register.tsx")).toContain("return null;");
  });

  it("27b. the proxy change only widens the static-asset exclusion; auth/session logic is untouched", () => {
    const proxy = read("proxy.ts");
    // Session refresh + the i18n routing call are still there, unchanged.
    expect(proxy).toContain("supabase.auth.getUser()");
    expect(proxy).toContain("handleI18nRouting(request)");
    expect(proxy).toContain("isStaleSessionError");
    // The matcher still excludes everything it did before, and now also
    // the two dotless PWA icon routes.
    const matcher = proxy.match(/matcher:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    for (const kept of ["api", "auth", "_next", "_vercel", "\\\\..*"]) {
      expect(matcher).toContain(kept);
    }
    expect(matcher).toContain("icon\\\\b");
    expect(matcher).toContain("apple-icon\\\\b");
  });
});
