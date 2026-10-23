import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  getTeamMembers,
  getTeamInvitations,
  getEligibleStaffForLinking,
  getTenantRoleOptions,
  getAssignableRoles,
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
  const [members, invitations, eligibleStaff, roles, assignableRoles] = await Promise.all([
    getTeamMembers(supabase, access.tenant.id),
    getTeamInvitations(supabase, access.tenant.id),
    getEligibleStaffForLinking(supabase, access.tenant.id),
    getTenantRoleOptions(supabase, access.tenant.id),
    getAssignableRoles(supabase, access.tenant.id),
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
      assignableRoles={assignableRoles}
      labels={{
        title: t("title"),
        description: t("description"),
        inviteCta: t("inviteCta"),
        membersSectionTitle: t("membersSectionTitle"),
        invitationsSectionTitle: t("invitationsSectionTitle"),
        membersTable: {
          nameColumn: t("membersTable.nameColumn"),
          roleColumn: t("membersTable.roleColumn"),
          staffLinkColumn: t("membersTable.staffLinkColumn"),
          unlinkedLabel: t("membersTable.unlinkedLabel"),
        },
        // t.raw: the dialog descriptions carry a "{name}" placeholder that is
        // filled in on the client per member; formatting them here would fail
        // on the missing argument.
        memberActions: {
          statusColumn: t("memberActions.statusColumn"),
          actionsColumn: t("memberActions.actionsColumn"),
          selfBadge: t("memberActions.selfBadge"),
          statusActive: t("memberActions.statusActive"),
          statusSuspended: t("memberActions.statusSuspended"),
          changeRole: t("memberActions.changeRole"),
          suspend: t("memberActions.suspend"),
          reactivate: t("memberActions.reactivate"),
          remove: t("memberActions.remove"),
          noActions: t("memberActions.noActions"),
          roleDialog: {
            title: t("memberActions.roleDialog.title"),
            description: t.raw("memberActions.roleDialog.description") as string,
            roleLabel: t("memberActions.roleDialog.roleLabel"),
            rolePlaceholder: t("memberActions.roleDialog.rolePlaceholder"),
            noRoles: t("memberActions.roleDialog.noRoles"),
            submit: t("memberActions.roleDialog.submit"),
            pending: t("memberActions.roleDialog.pending"),
            cancel: t("memberActions.roleDialog.cancel"),
          },
          suspendDialog: {
            title: t("memberActions.suspendDialog.title"),
            description: t.raw("memberActions.suspendDialog.description") as string,
            confirm: t("memberActions.suspendDialog.confirm"),
            pending: t("memberActions.suspendDialog.pending"),
            cancel: t("memberActions.suspendDialog.cancel"),
          },
          reactivateDialog: {
            title: t("memberActions.reactivateDialog.title"),
            description: t.raw("memberActions.reactivateDialog.description") as string,
            confirm: t("memberActions.reactivateDialog.confirm"),
            pending: t("memberActions.reactivateDialog.pending"),
            cancel: t("memberActions.reactivateDialog.cancel"),
          },
          removeDialog: {
            title: t("memberActions.removeDialog.title"),
            description: t.raw("memberActions.removeDialog.description") as string,
            confirm: t("memberActions.removeDialog.confirm"),
            pending: t("memberActions.removeDialog.pending"),
            cancel: t("memberActions.removeDialog.cancel"),
          },
          banners: {
            roleChanged: t("memberActions.banners.roleChanged"),
            suspended: t("memberActions.banners.suspended"),
            reactivated: t("memberActions.banners.reactivated"),
            removed: t("memberActions.banners.removed"),
          },
        },
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
