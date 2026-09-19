"use client";

import { useState } from "react";
import { Plus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TeamMemberRow, TeamInvitationRow, EligibleStaffOption, RoleOption } from "@/lib/modules/team/queries";
import type { CreateTeamInvitationResultData } from "@/lib/modules/team/actions";
import { TeamMembersSection } from "@/components/team/team-members-section";
import { TeamInvitationsSection } from "@/components/team/team-invitations-section";
import { CreateInvitationDialog } from "@/components/team/create-invitation-dialog";
import { RevokeInvitationDialog } from "@/components/team/revoke-invitation-dialog";

type Labels = {
  title: string;
  description: string;
  inviteCta: string;
  membersSectionTitle: string;
  invitationsSectionTitle: string;
  membersTable: {
    nameColumn: string;
    roleColumn: string;
    staffLinkColumn: string;
    unlinkedLabel: string;
  };
  invitationsTable: {
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
  };
  emptyInvitationsTitle: string;
  noMembersTitle: string;
  resendCta: string;
  resendPending: string;
  revokeCta: string;
  revokeConfirmTitle: string;
  revokeConfirmDescription: string;
  revokeConfirmCancel: string;
  revokeConfirmConfirm: string;
  revokeConfirmPending: string;
  createSentMessage: string;
  createDeliveryFailedMessage: string;
  resendSentMessage: string;
  resendDeliveryFailedMessage: string;
  resendExpiredMessage: string;
  invitationChangedMessage: string;
  createDialog: {
    title: string;
    description: string;
    emailLabel: string;
    roleLabel: string;
    rolePlaceholder: string;
    staffLinkLabel: string;
    staffLinkPlaceholder: string;
    staffLinkNone: string;
    staffLinkHelper: string;
    submitLabel: string;
    submitPending: string;
  };
};

export function TeamPageClient({
  tenantId,
  tenantSlug,
  initialMembers,
  initialInvitations,
  staffLinkOptions,
  roleOptions,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  initialMembers: TeamMemberRow[];
  initialInvitations: TeamInvitationRow[];
  staffLinkOptions: EligibleStaffOption[];
  roleOptions: RoleOption[];
  labels: Labels;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeInvitationId, setRevokeInvitationId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "success" | "warning"; message: string } | null>(null);

  function handleCreated(outcome: CreateTeamInvitationResultData["outcome"]) {
    setCreateOpen(false);
    setBanner(
      outcome === "sent"
        ? { tone: "success", message: labels.createSentMessage }
        : { tone: "warning", message: labels.createDeliveryFailedMessage },
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{labels.description}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="shrink-0">
          <Plus />
          {labels.inviteCta}
        </Button>
      </div>

      {banner && (
        <div
          role="status"
          className={
            banner.tone === "success"
              ? "rounded-lg border border-emerald-600/30 bg-emerald-600/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400"
              : "rounded-lg border border-amber-600/30 bg-amber-600/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400"
          }
        >
          {banner.message}
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium">{labels.membersSectionTitle}</h2>
        {initialMembers.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">{labels.noMembersTitle}</p>
        ) : (
          <TeamMembersSection members={initialMembers} labels={labels.membersTable} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium">{labels.invitationsSectionTitle}</h2>
        {initialInvitations.length === 0 ? (
          <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full">
              <UsersRound className="text-muted-foreground size-6" />
            </div>
            <p className="text-muted-foreground max-w-sm text-sm">{labels.emptyInvitationsTitle}</p>
          </div>
        ) : (
          <TeamInvitationsSection
            invitations={initialInvitations}
            tenantId={tenantId}
            tenantSlug={tenantSlug}
            labels={{
              ...labels.invitationsTable,
              resendCta: labels.resendCta,
              resendPending: labels.resendPending,
              revokeCta: labels.revokeCta,
              invitationChangedMessage: labels.invitationChangedMessage,
            }}
            onRevoke={(invitationId) => setRevokeInvitationId(invitationId)}
          />
        )}
      </section>

      <CreateInvitationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        tenantId={tenantId}
        tenantSlug={tenantSlug}
        roles={roleOptions}
        staffOptions={staffLinkOptions}
        onCreated={handleCreated}
        labels={labels.createDialog}
      />

      <RevokeInvitationDialog
        open={revokeInvitationId !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeInvitationId(null);
        }}
        tenantId={tenantId}
        tenantSlug={tenantSlug}
        invitationId={revokeInvitationId}
        onRevoked={() => setRevokeInvitationId(null)}
        labels={{
          revokeConfirmTitle: labels.revokeConfirmTitle,
          revokeConfirmDescription: labels.revokeConfirmDescription,
          revokeConfirmCancel: labels.revokeConfirmCancel,
          revokeConfirmConfirm: labels.revokeConfirmConfirm,
          revokeConfirmPending: labels.revokeConfirmPending,
        }}
      />
    </div>
  );
}
