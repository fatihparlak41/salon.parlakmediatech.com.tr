"use client";

import { useActionState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { claimMyRecentBookingAction } from "@/lib/modules/customer-account/actions";

/**
 * Faz 2G.3.1 — the explicit, deliberate action that actually performs the
 * ownership-link mutation. Never automatic on page load: the guarded
 * /account/claim/complete page only renders this after a successful
 * Magic Link authentication, and the mutation itself waits for this
 * button's own click — same "authenticate first, mutate only on an
 * explicit second action" philosophy as the scanner-safe email
 * confirmation flow this reuses.
 *
 * hasPendingClaimInitially is the SERVER's cookie-presence check from
 * the page's very first render — used ONLY before any submission
 * (state === null). It must never gate the SUCCESS branch: completing
 * the action clears the cookie (see claimMyRecentBookingAction), and
 * Next.js refreshes this Server Component tree once the action
 * resolves, which would otherwise recompute the prop as false and make
 * a genuine success look identical to "there was nothing to claim" —
 * exactly the bug this structure avoids. useActionState's own `state`
 * survives that refresh because this component itself stays mounted
 * throughout (the conditional lives in here, not in the parent), so
 * state?.success is checked first and wins regardless of what the
 * server recomputed.
 */
export function ClaimCompleteButton({
  claimRef,
  hasPendingClaimInitially,
  labels,
}: {
  claimRef: string;
  hasPendingClaimInitially: boolean;
  labels: {
    description: string;
    action: string;
    claiming: string;
    success: string;
    goToAppointments: string;
    noPendingClaim: string;
  };
}) {
  const [state, formAction, isPending] = useActionState(claimMyRecentBookingAction, null);

  if (state?.success) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-sm font-medium">{labels.success}</p>
        <Button render={<Link href="/account/appointments" />} nativeButton={false}>
          {labels.goToAppointments}
        </Button>
      </div>
    );
  }

  if (!hasPendingClaimInitially && !state) {
    return <p className="text-muted-foreground max-w-sm text-sm">{labels.noPendingClaim}</p>;
  }

  return (
    <>
      <p className="text-muted-foreground max-w-sm text-sm">{labels.description}</p>
      <form action={formAction} className="flex flex-col items-center gap-2">
        <input type="hidden" name="claimRef" value={claimRef} />
        <Button type="submit" disabled={isPending}>
          {isPending ? labels.claiming : labels.action}
        </Button>
        {state && !state.success ? (
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
        ) : null}
      </form>
    </>
  );
}
