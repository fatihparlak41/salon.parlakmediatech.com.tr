"use client";

import { useActionState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { acceptTeamInvitationAction } from "@/lib/modules/team/accept-actions";
import { signOutAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";

type Labels = {
  title: string;
  description: string;
  acceptCta: string;
  accepting: string;
  notNowCta: string;
  loginCta: string;
  switchAccountCta: string;
  homeCta: string;
};

const ACCEPT_INVITE_PATH = "/accept-invite";
const LOGIN_WITH_RETURN = `/login?next=${encodeURIComponent(ACCEPT_INVITE_PATH)}`;

/**
 * Faz SAAS.1D.2 — the authenticated, explicit-confirmation state of
 * /accept-invite. Rendering this at all requires a pending invitation
 * cookie AND a signed-in user (decided server-side by the page); the
 * button is the only thing that ever triggers acceptance — nothing
 * auto-submits, and the raw token never appears here: the action takes no
 * input and reads the token from an HttpOnly cookie server-side, so there
 * is no token prop, form field, or client state anywhere in this
 * component.
 *
 * On success the action redirects straight into the salon, so the only
 * results this component ever renders are failures.
 */
export function AcceptInvitePanel({ labels }: { labels: Labels }) {
  const [state, formAction, isPending] = useActionState(acceptTeamInvitationAction, null);
  const failure = state && !state.success ? state.error : null;
  const reason = failure?.reason;

  // Retrying only makes sense when nothing about the invitation or this
  // account is wrong: first attempt, or a transient failure.
  const showAcceptButton = !failure || reason === "unexpected";

  return (
    <div className="flex flex-col gap-6 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{labels.title}</h1>
        <p className="text-muted-foreground text-sm">{labels.description}</p>
      </div>

      {failure ? (
        <p className="text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}

      {showAcceptButton ? (
        <form action={formAction} className="flex flex-col gap-3">
          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? labels.accepting : labels.acceptCta}
          </Button>
          <Button render={<Link href="/" />} nativeButton={false} variant="ghost" className="w-full">
            {labels.notNowCta}
          </Button>
        </form>
      ) : null}

      {reason === "email_mismatch" ? (
        // Existing logout behavior, returning to /accept-invite (which
        // still holds the parked invitation) so the RIGHT account can
        // sign in and continue. Never reveals the invited address, and
        // there is no override.
        <form action={signOutAction} className="flex flex-col gap-3">
          <input type="hidden" name="next" value={ACCEPT_INVITE_PATH} />
          <Button type="submit" variant="outline" className="w-full">
            {labels.switchAccountCta}
          </Button>
        </form>
      ) : null}

      {reason === "unauthenticated" ? (
        <Button render={<Link href={LOGIN_WITH_RETURN} />} nativeButton={false} className="w-full">
          {labels.loginCta}
        </Button>
      ) : null}

      {failure && !showAcceptButton && reason !== "unauthenticated" ? (
        <Button render={<Link href="/" />} nativeButton={false} variant="ghost" className="w-full">
          {labels.homeCta}
        </Button>
      ) : null}
    </div>
  );
}
