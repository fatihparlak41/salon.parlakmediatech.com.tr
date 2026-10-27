import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  getTeamMembers,
  getTeamInvitations,
  getEligibleStaffForLinking,
  getTenantRoleOptions,
} from "@/lib/modules/team/queries";
import { TeamPageClient } from "@/components/team/team-page-client";

export default async function TeamPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]/team">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  // Single permission gate, no separate view tier — same shape as
  // settings/page.tsx's settings.manage check. The nav already hides this
  // link without staff.manage; a direct hit still gets bounced. RLS (zero
  // rows back, not an error) remains the real boundary underneath every
  // query and RPC this page uses.
  const canManage = await hasPermission(access.tenant.id, "staff.manage");
  if (!canManage) {
    redirect(`/app/${tenantSlug}`);
  }

  const supabase = await createClient();
  const [members, invitations, eligibleStaff, roles] = await Promise.all([
    getTeamMembers(supabase, access.tenant.id),
    getTeamInvitations(supabase, access.tenant.id),
    getEligibleStaffForLinking(supabase, access.tenant.id),
    getTenantRoleOptions(supabase, access.tenant.id),
  ]);

  // A staff member already targeted by a pending invitation is excluded
  // from the link picker too, so the same person can't be double-invited
  // — computed here from data already fetched above, not a second query.
  const pendingStaffIds = new Set(
    invitations
      .filter((inv) => inv.effectiveStatus === "pending" && inv.staffMemberId)
      .map((inv) => inv.staffMemberId as string),
  );
  const staffLinkOptions = eligibleStaff.filter((s) => !pendingStaffIds.has(s.id));

  const t = await getTranslations("Team");

  return (
    <TeamPageClient
      tenantId={access.tenant.id}
      tenantSlug={tenantSlug}
      initialMembers={members}
      initialInvitations={invitations}
      staffLinkOptions={staffLinkOptions}
      roleOptions={roles}
      labels={{
        title: t("title"),
        description: t("description"),
        inviteCta: t("inviteCta"),
        membersSectionTitle: t("membersSectionTitle"),
        invitationsSectionTitle: t("invitationsSectionTitle"),
        membersTable: {
          nameColumn: t("membersTable.nameColumn"),
          emailColumn: t("membersTable.emailColumn"),
          roleColumn: t("membersTable.roleColumn"),
          statusColumn: t("membersTable.statusColumn"),
          staffLinkColumn: t("membersTable.staffLinkColumn"),
          actionsColumn: t("membersTable.actionsColumn"),
          unlinkedLabel: t("membersTable.unlinkedLabel"),
          noEmail: t("membersTable.noEmail"),
          statusActive: t("membersTable.statusActive"),
          statusSuspended: t("membersTable.statusSuspended"),
          selfBadge: t("membersTable.selfBadge"),
          lastOwnerNote: t("membersTable.lastOwnerNote"),
        },
        memberActions: {
          suspend: t("memberActions.suspend"),
          reactivate: t("memberActions.reactivate"),
          remove: t("memberActions.remove"),
        },
        memberDialog: {
          cancel: t("memberDialog.cancel"),
          suspend: {
            title: t("memberDialog.suspend.title"),
            description: String(t.raw("memberDialog.suspend.description")),
            confirm: t("memberDialog.suspend.confirm"),
            pending: t("memberDialog.suspend.pending"),
          },
          reactivate: {
            title: t("memberDialog.reactivate.title"),
            description: String(t.raw("memberDialog.reactivate.description")),
            confirm: t("memberDialog.reactivate.confirm"),
            pending: t("memberDialog.reactivate.pending"),
          },
          remove: {
            title: t("memberDialog.remove.title"),
            description: String(t.raw("memberDialog.remove.description")),
            confirm: t("memberDialog.remove.confirm"),
            pending: t("memberDialog.remove.pending"),
          },
        },
        memberActionDone: {
          suspend: t("memberActionDone.suspend"),
          reactivate: t("memberActionDone.reactivate"),
          remove: t("memberActionDone.remove"),
        },
        expiredInvitationHint: t("expiredInvitationHint"),
        invitationsTable: {
          emailColumn: t("invitationsTable.emailColumn"),
          roleColumn: t("invitationsTable.roleColumn"),
          staffLinkColumn: t("invitationsTable.staffLinkColumn"),
          invitedByColumn: t("invitationsTable.invitedByColumn"),
          createdColumn: t("invitationsTable.createdColumn"),
          expiresColumn: t("invitationsTable.expiresColumn"),
          statusColumn: t("invitationsTable.statusColumn"),
          actionsColumn: t("invitationsTable.actionsColumn"),
          unlinkedLabel: t("invitationsTable.unlinkedLabel"),
          unknownInviter: t("invitationsTable.unknownInviter"),
        },
        emptyInvitationsTitle: t("emptyInvitationsTitle"),
        noMembersTitle: t("noMembersTitle"),
        resendCta: t("resendCta"),
        resendPending: t("resendPending"),
        revokeCta: t("revokeCta"),
        revokeConfirmTitle: t("revokeConfirmTitle"),
        revokeConfirmDescription: t("revokeConfirmDescription"),
        revokeConfirmCancel: t("revokeConfirmCancel"),
        revokeConfirmConfirm: t("revokeConfirmConfirm"),
        revokeConfirmPending: t("revokeConfirmPending"),
        createSentMessage: t("createSentMessage"),
        createDeliveryFailedMessage: t("createDeliveryFailedMessage"),
        resendSentMessage: t("resendSentMessage"),
        resendDeliveryFailedMessage: t("resendDeliveryFailedMessage"),
        resendExpiredMessage: t("resendExpiredMessage"),
        invitationChangedMessage: t("invitationChangedMessage"),
        createDialog: {
          title: t("createDialog.title"),
          description: t("createDialog.description"),
          emailLabel: t("createDialog.emailLabel"),
          roleLabel: t("createDialog.roleLabel"),
          rolePlaceholder: t("createDialog.rolePlaceholder"),
          staffLinkLabel: t("createDialog.staffLinkLabel"),
          staffLinkPlaceholder: t("createDialog.staffLinkPlaceholder"),
          staffLinkNone: t("createDialog.staffLinkNone"),
          staffLinkHelper: t("createDialog.staffLinkHelper"),
          submitLabel: t("createDialog.submitLabel"),
          submitPending: t("createDialog.submitPending"),
        },
      }}
    />
  );
}
