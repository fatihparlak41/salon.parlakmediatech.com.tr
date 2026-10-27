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
  reactivateMemberAction,
  removeMemberAction,
  suspendMemberAction,
} from "@/lib/modules/team/member-actions";
import type { MemberActionResultData, MemberTargetInput } from "@/lib/modules/team/member-management";

export type MemberAccessAction = "suspend" | "reactivate" | "remove";

type ActionLabels = { title: string; description: string; confirm: string; pending: string };

export type MemberConfirmLabels = {
  cancel: string;
  suspend: ActionLabels;
  reactivate: ActionLabels;
  remove: ActionLabels;
};

/**
 * Faz SAAS.1A — the ONE confirmation dialog for the three account-access actions. It explains in plain words what
 * will and will NOT happen (history stays), names the person (never an id), and shows the server's own message when
 * the database refuses (last Owner, stale state, authority). Mounted only while a member is selected, so every
 * confirmation is a fresh form: nothing from a previous attempt lingers.
 */
export function MemberConfirmDialog({
  open,
  onOpenChange,
  tenantId,
  tenantSlug,
  membershipId,
  displayName,
  action,
  onDone,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  membershipId: string | null;
  displayName: string;
  action: MemberAccessAction;
  onDone: (action: MemberAccessAction) => void;
  labels: MemberConfirmLabels;
}) {
  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<MemberActionResultData> | null,
      input: MemberTargetInput & { tenantSlug: string },
    ): Promise<ActionResult<MemberActionResultData>> => {
      const run =
        action === "suspend" ? suspendMemberAction : action === "reactivate" ? reactivateMemberAction : removeMemberAction;
      const result = await run(prevState, input);
      if (result.success) onDone(action);
      return result;
    },
    null,
  );

  const text = labels[action];

  function handleConfirm() {
    if (!membershipId) return;
    startTransition(() => formAction({ tenantId, tenantSlug, membershipId }));
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{text.title}</AlertDialogTitle>
          <AlertDialogDescription>{text.description.replace("{name}", displayName)}</AlertDialogDescription>
        </AlertDialogHeader>

        {state && !state.success && (
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={isPending} />}>{labels.cancel}</AlertDialogClose>
          <Button variant={action === "reactivate" ? "default" : "destructive"} disabled={isPending} onClick={handleConfirm}>
            {isPending ? text.pending : text.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
