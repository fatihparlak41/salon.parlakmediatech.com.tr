"use client";

import { startTransition, useActionState } from "react";
import { useRouter } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/errors";
import type { TeamInvitationRow } from "@/lib/modules/team/queries";
import {
  resendTeamInvitationAction,
  type ResendTeamInvitationInput,
  type ResendTeamInvitationResultData,
} from "@/lib/modules/team/actions";
import { INVITATION_STATUS_LABELS_TR, INVITATION_STATUS_BADGE_VARIANT } from "@/lib/modules/team/status";

type Labels = {
  emailColumn: string;
  roleColumn: string;
  staffLinkColumn: string;
  invitedByColumn: string;
  createdColumn: string;
  expiresColumn: string;
  statusColumn: string;
  actionsColumn: string;
  unlinkedLabel: string;
  unknownInviter: string;
  resendCta: string;
  resendPending: string;
  revokeCta: string;
  invitationChangedMessage: string;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("tr-TR");
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={INVITATION_STATUS_BADGE_VARIANT[status] ?? "outline"}>
      {INVITATION_STATUS_LABELS_TR[status] ?? status}
    </Badge>
  );
}

/** Exact live RPC error message — private.resend_team_invitation, checked
 * here (rather than a new error code) so a losing concurrent resend gets
 * the more specific "list refreshed" copy instead of the action's own
 * generic "try again" message. See mapResendInvitationError's own header
 * for why this string is exact-matched, not guessed. */
const INVITATION_CHANGED_MESSAGE = "Davet başka bir işlem tarafından güncellendi. Lütfen tekrar deneyin.";

function ResendButton({
  tenantId,
  tenantSlug,
  invitationId,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  invitationId: string;
  labels: Labels;
}) {
  const router = useRouter();

  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<ResendTeamInvitationResultData> | null,
      input: ResendTeamInvitationInput & { tenantSlug: string },
    ): Promise<ActionResult<ResendTeamInvitationResultData>> => {
      const result = await resendTeamInvitationAction(prevState, input);
      if (result.success || result.error.message === INVITATION_CHANGED_MESSAGE) {
        router.refresh();
      }
      return result;
    },
    null,
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => startTransition(() => formAction({ tenantId, tenantSlug, invitationId }))}
      >
        {isPending ? labels.resendPending : labels.resendCta}
      </Button>
      {state && !state.success && (
        <p className="text-destructive max-w-48 text-right text-xs" role="alert">
          {state.error.message === INVITATION_CHANGED_MESSAGE
            ? labels.invitationChangedMessage
            : state.error.message}
        </p>
      )}
    </div>
  );
}

export function TeamInvitationsSection({
  invitations,
  tenantId,
  tenantSlug,
  labels,
  onRevoke,
}: {
  invitations: TeamInvitationRow[];
  tenantId: string;
  tenantSlug: string;
  labels: Labels;
  onRevoke: (invitationId: string) => void;
}) {
  function Actions({ invitation }: { invitation: TeamInvitationRow }) {
    if (invitation.effectiveStatus !== "pending") return null;
    return (
      <div className="flex flex-wrap items-start justify-end gap-2">
        <ResendButton
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          invitationId={invitation.id}
          labels={labels}
        />
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => onRevoke(invitation.id)}
        >
          {labels.revokeCta}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.emailColumn}</TableHead>
              <TableHead>{labels.roleColumn}</TableHead>
              <TableHead>{labels.staffLinkColumn}</TableHead>
              <TableHead>{labels.invitedByColumn}</TableHead>
              <TableHead>{labels.createdColumn}</TableHead>
              <TableHead>{labels.expiresColumn}</TableHead>
              <TableHead>{labels.statusColumn}</TableHead>
              <TableHead className="text-right">{labels.actionsColumn}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((invitation) => (
              <TableRow key={invitation.id}>
                <TableCell className="max-w-56 truncate font-medium" title={invitation.email}>
                  {invitation.email}
                </TableCell>
                <TableCell>{invitation.roleName}</TableCell>
                <TableCell className="text-muted-foreground">
                  {invitation.staffMemberName ?? labels.unlinkedLabel}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {invitation.invitedByName ?? labels.unknownInviter}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(invitation.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(invitation.expiresAt)}</TableCell>
                <TableCell>
                  <StatusBadge status={invitation.effectiveStatus} />
                </TableCell>
                <TableCell className="text-right">
                  <Actions invitation={invitation} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        {invitations.map((invitation) => (
          <div key={invitation.id} className="bg-card rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="max-w-56 truncate font-medium" title={invitation.email}>
                {invitation.email}
              </h3>
              <StatusBadge status={invitation.effectiveStatus} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{labels.roleColumn}</dt>
              <dd className="text-right">{invitation.roleName}</dd>

              <dt className="text-muted-foreground">{labels.staffLinkColumn}</dt>
              <dd className="text-right">{invitation.staffMemberName ?? labels.unlinkedLabel}</dd>

              <dt className="text-muted-foreground">{labels.invitedByColumn}</dt>
              <dd className="text-right">{invitation.invitedByName ?? labels.unknownInviter}</dd>

              <dt className="text-muted-foreground">{labels.expiresColumn}</dt>
              <dd className="text-right">{formatDate(invitation.expiresAt)}</dd>
            </dl>
            <div className="mt-3 flex justify-end">
              <Actions invitation={invitation} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
