"use client";

import { useEffect } from "react";
import { enforceDeviceOwnership } from "@/lib/pwa/device-session";
import { browserDeviceDeps } from "@/lib/pwa/device-session-browser";

/**
 * Faz ACCOUNT.1 (security) — rule 2 of the shared-browser policy
 * (lib/pwa/device-session.ts). Mounted once in each authenticated shell,
 * renders nothing. When the browser's push subscription was connected by a
 * DIFFERENT person than the one signed in now (a session that ended without
 * "Çıkış yap" — expiry, a cleared cookie — followed by somebody else's
 * login), the subscription is dropped so this person never receives that
 * person's notifications; they switch notifications on themselves.
 *
 * `ownerTag` is a server-computed hash of the signed-in user — never the
 * user id. A browser with no recorded owner is left untouched.
 * Failures are swallowed: a guard that could break a page would be worse
 * than the (already time-boxed) window it closes.
 */
export function PushDeviceGuard({ ownerTag }: { ownerTag: string }) {
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!active) return;
        await enforceDeviceOwnership(ownerTag, browserDeviceDeps());
      } catch {
        /* never let bookkeeping break a page */
      }
    })();
    return () => {
      active = false;
    };
  }, [ownerTag]);

  return null;
}
