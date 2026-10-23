"use client";

import { startTransition, useActionState } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/errors";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { reactivateMemberAction, removeMemberAction, suspendMemberAction } from "@/lib/modules/team/member-actions";
import type { MemberActionResultData, MemberTargetInput } from "@/lib/modules/team/member-management";
import { MEMBER_STATE_CHANGED_MESSAGE } from "@/lib/modules/team/helpers";
import type { TeamMemberRow } from "@/lib/modules/team/queries";

export type ConfirmKind = "suspend" | "reactivate" | "remove";

type Labels = {
  title: string;
  /** "{name}" already substituted by the caller. */
  description: string;
  confirm: string;
  pending: string;
  cancel: string;
};

const ACTIONS = {
  suspend: suspendMemberAction,
  reactivate: reactivateMemberAction,
  remove: removeMemberAction,
} as const;

/**
 * Faz LAUNCH.1A — the confirmation step for the three RESTRICTIVE or
 * DESTRUCTIVE member actions (suspend, restore, remove). Nothing is sent until
 * the Owner presses the confirm button; the description says in plain words what
 * will and will not happen to the person's data. One component, three actions,
 * so the confirmation behaves identically for all of them. Mount with
 * `key={kind + membershipId}`.
 */
export function MemberConfirmDialog({
  open,
  onOpenChange,
  kind,
  tenantId,
  tenantSlug,
  member,
  onDone,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: ConfirmKind;
  tenantId: string;
  tenantSlug: string;
  member: TeamMemberRow;
  onDone: () => void;
  labels: Labels;
}) {
  const router = useRouter();
  const act = ACTIONS[kind];

  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<MemberActionResultData> | null,
      input: MemberTargetInput & { tenantSlug: string },
    ): Promise<ActionResult<MemberActionResultData>> => {
      const result = await act(prevState, input);
      if (result.success) {
        onDone();
      } else if (result.error.message === MEMBER_STATE_CHANGED_MESSAGE) {
        router.refresh();
      }
      return result;
    },
    null,
  );

  function handleConfirm() {
    startTransition(() => formAction({ tenantId, tenantSlug, membershipId: member.membershipId }));
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{labels.title}</AlertDialogTitle>
          <AlertDialogDescription>{labels.description}</AlertDialogDescription>
        </AlertDialogHeader>

        {state && !state.success ? (
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={isPending} />}>{labels.cancel}</AlertDialogClose>
          <Button variant={kind === "reactivate" ? "default" : "destructive"} disabled={isPending} onClick={handleConfirm}>
            {isPending ? labels.pending : labels.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
