"use client";

import { startTransition, useActionState } from "react";
import type { ActionResult } from "@/lib/errors";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  revokeTeamInvitationAction,
  type RevokeTeamInvitationInput,
  type RevokeTeamInvitationResultData,
} from "@/lib/modules/team/actions";

type Labels = {
  revokeConfirmTitle: string;
  revokeConfirmDescription: string;
  revokeConfirmCancel: string;
  revokeConfirmConfirm: string;
  revokeConfirmPending: string;
};

export function RevokeInvitationDialog({
  open,
  onOpenChange,
  tenantId,
  tenantSlug,
  invitationId,
  onRevoked,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  invitationId: string | null;
  onRevoked: () => void;
  labels: Labels;
}) {
  // Success handling lives in the action itself, not a useEffect watching
  // `state` — same discipline as every other mutation dialog in this app.
  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<RevokeTeamInvitationResultData> | null,
      input: RevokeTeamInvitationInput & { tenantSlug: string },
    ): Promise<ActionResult<RevokeTeamInvitationResultData>> => {
      const result = await revokeTeamInvitationAction(prevState, input);
      if (result.success) {
        onRevoked();
      }
      return result;
    },
    null,
  );

  function handleConfirm() {
    if (!invitationId) return;
    startTransition(() => formAction({ tenantId, tenantSlug, invitationId }));
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{labels.revokeConfirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>{labels.revokeConfirmDescription}</AlertDialogDescription>
        </AlertDialogHeader>

        {state && !state.success && (
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={isPending} />}>
            {labels.revokeConfirmCancel}
          </AlertDialogClose>
          <Button variant="destructive" disabled={isPending} onClick={handleConfirm}>
            {isPending ? labels.revokeConfirmPending : labels.revokeConfirmConfirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
