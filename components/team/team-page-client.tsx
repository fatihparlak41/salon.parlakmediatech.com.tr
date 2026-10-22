"use client";

import { useState } from "react";
import { Plus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  TeamMemberRow,
  TeamInvitationRow,
  EligibleStaffOption,
  RoleOption,
  AssignableRoleOption,
} from "@/lib/modules/team/queries";
import type { CreateTeamInvitationResultData } from "@/lib/modules/team/actions";
import { TeamMembersSection, type MemberActionKind } from "@/components/team/team-members-section";
import { TeamInvitationsSection } from "@/components/team/team-invitations-section";
import { CreateInvitationDialog } from "@/components/team/create-invitation-dialog";
import { RevokeInvitationDialog } from "@/components/team/revoke-invitation-dialog";
import { ChangeMemberRoleDialog } from "@/components/team/change-member-role-dialog";
import { MemberConfirmDialog } from "@/components/team/member-confirm-dialog";

type ConfirmLabels = {
  title: string;
  description: string;
  confirm: string;
  pending: string;
  cancel: string;
};

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
  memberActions: {
    statusColumn: string;
    actionsColumn: string;
    selfBadge: string;
    statusActive: string;
    statusSuspended: string;
    changeRole: string;
    suspend: string;
    reactivate: string;
    remove: string;
    noActions: string;
    roleDialog: {
      title: string;
      description: string;
      roleLabel: string;
      rolePlaceholder: string;
      noRoles: string;
      submit: string;
      pending: string;
      cancel: string;
    };
    suspendDialog: ConfirmLabels;
    reactivateDialog: ConfirmLabels;
    removeDialog: ConfirmLabels;
    banners: { roleChanged: string; suspended: string; reactivated: string; removed: string };
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

/** "{name}" is substituted here rather than by next-intl so the labels stay plain strings across the server/client boundary. */
function withName(template: string, name: string): string {
  return template.replace("{name}", name);
}

export function TeamPageClient({
  tenantId,
  tenantSlug,
  initialMembers,
  initialInvitations,
  staffLinkOptions,
  roleOptions,
  assignableRoles,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  initialMembers: TeamMemberRow[];
  initialInvitations: TeamInvitationRow[];
  staffLinkOptions: EligibleStaffOption[];
  roleOptions: RoleOption[];
  assignableRoles: AssignableRoleOption[];
  labels: Labels;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeInvitationId, setRevokeInvitationId] = useState<string | null>(null);
  const [memberAction, setMemberAction] = useState<{ kind: MemberActionKind; member: TeamMemberRow } | null>(null);
  const [banner, setBanner] = useState<{ tone: "success" | "warning"; message: string } | null>(null);

  function handleCreated(outcome: CreateTeamInvitationResultData["outcome"]) {
    setCreateOpen(false);
    setBanner(
      outcome === "sent"
        ? { tone: "success", message: labels.createSentMessage }
        : { tone: "warning", message: labels.createDeliveryFailedMessage },
    );
  }

  function handleMemberDone(kind: MemberActionKind) {
    setMemberAction(null);
    const text = labels.memberActions.banners;
    const message =
      kind === "role" ? text.roleChanged : kind === "suspend" ? text.suspended : kind === "reactivate" ? text.reactivated : text.removed;
    setBanner({ tone: "success", message });
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
          <TeamMembersSection
            members={initialMembers}
            labels={{
              ...labels.membersTable,
              statusColumn: labels.memberActions.statusColumn,
              actionsColumn: labels.memberActions.actionsColumn,
              selfBadge: labels.memberActions.selfBadge,
              statusActive: labels.memberActions.statusActive,
              statusSuspended: labels.memberActions.statusSuspended,
              changeRole: labels.memberActions.changeRole,
              suspend: labels.memberActions.suspend,
              reactivate: labels.memberActions.reactivate,
              remove: labels.memberActions.remove,
              noActions: labels.memberActions.noActions,
            }}
            onAction={(kind, member) => setMemberAction({ kind, member })}
          />
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

      {/* Faz LAUNCH.1A — exactly one member dialog exists at a time, mounted
          only while its action is chosen and keyed by member + kind, so no
          picked role, pending state or error survives from one member to the
          next. */}
      {memberAction?.kind === "role" ? (
        <ChangeMemberRoleDialog
          key={`role-${memberAction.member.membershipId}`}
          open
          onOpenChange={(open) => {
            if (!open) setMemberAction(null);
          }}
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          member={memberAction.member}
          roles={assignableRoles}
          onDone={() => handleMemberDone("role")}
          labels={{
            ...labels.memberActions.roleDialog,
            description: withName(labels.memberActions.roleDialog.description, memberAction.member.displayName),
          }}
        />
      ) : null}

      {memberAction && memberAction.kind !== "role" ? (
        <MemberConfirmDialog
          key={`${memberAction.kind}-${memberAction.member.membershipId}`}
          open
          onOpenChange={(open) => {
            if (!open) setMemberAction(null);
          }}
          kind={memberAction.kind}
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          member={memberAction.member}
          onDone={() => handleMemberDone(memberAction.kind)}
          labels={(() => {
            const source =
              memberAction.kind === "suspend"
                ? labels.memberActions.suspendDialog
                : memberAction.kind === "reactivate"
                  ? labels.memberActions.reactivateDialog
                  : labels.memberActions.removeDialog;
            return { ...source, description: withName(source.description, memberAction.member.displayName) };
          })()}
        />
      ) : null}
    </div>
  );
}
