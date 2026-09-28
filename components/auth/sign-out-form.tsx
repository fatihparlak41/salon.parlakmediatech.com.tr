"use client";

import { useRef, type FormEvent, type ReactNode } from "react";
import { signOutAction } from "@/lib/modules/auth/actions";
import { removePushSubscriptionAction } from "@/lib/modules/settings/actions";
import { disconnectThisBrowser } from "@/lib/pwa/device-session";
import { browserDeviceDeps } from "@/lib/pwa/device-session-browser";

/**
 * Faz ACCOUNT.1 (security) — every "Çıkış yap" form goes through this
 * wrapper. Before the session ends it disconnects THIS browser's push
 * device from the person signing out (rule 1 of the shared-browser policy,
 * lib/pwa/device-session.ts): the next person to sign in here must not
 * receive the previous person's appointment notifications.
 *
 * The cleanup is time-boxed (a few seconds at most) and can never fail a
 * sign-out: whatever happens, signOutAction then runs with the form's
 * fields (hidden `next` field included), exactly as a plain form whose
 * `action` prop was signOutAction would have submitted them.
 *
 * This calls signOutAction() DIRECTLY (a Server Action is just an async
 * function — invoking it from a click handler is the documented way to run
 * one outside of a plain form submit) instead of intercepting the submit
 * and re-triggering the form element itself once cleanup finishes: this
 * form's only real-world use is a "Çıkış yap" DropdownMenuItem, and Base
 * UI's menu closes (unmounting the trigger's own subtree) the instant a
 * menu item is activated — before an awaited cleanup could ever finish.
 * Re-triggering that now-disconnected element afterward is silently
 * ignored by the browser ("Form submission canceled because the form is
 * not connected"), which left sign-out from the user menu not firing at
 * all. Reading the fields with `new FormData(form)` has no such
 * requirement — a detached element is still a live DOM node, just no
 * longer in the document.
 */
export function SignOutForm({ children, className }: { children: ReactNode; className?: string }) {
  const running = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current) return; // ignore a double click while cleaning up
    running.current = true;
    const formData = new FormData(event.currentTarget);
    try {
      await disconnectThisBrowser({
        ...browserDeviceDeps(),
        revoke: (subscriptionId) => removePushSubscriptionAction(null, { subscriptionId }),
      });
    } catch {
      /* cleanup is best effort — signing out always proceeds */
    }
    await signOutAction(formData);
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      {children}
    </form>
  );
}
