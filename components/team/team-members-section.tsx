import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TeamMemberRow } from "@/lib/modules/team/queries";
import type { MemberAccessAction } from "@/components/team/member-confirm-dialog";

export type TeamMembersLabels = {
  nameColumn: string;
  emailColumn: string;
  roleColumn: string;
  statusColumn: string;
  staffLinkColumn: string;
  actionsColumn: string;
  unlinkedLabel: string;
  noEmail: string;
  statusActive: string;
  statusSuspended: string;
  selfBadge: string;
  lastOwnerNote: string;
  actions: { suspend: string; reactivate: string; remove: string };
};

function StatusBadge({ member, labels }: { member: TeamMemberRow; labels: TeamMembersLabels }) {
  return member.status === "suspended" ? (
    <Badge variant="secondary">{labels.statusSuspended}</Badge>
  ) : (
    <Badge variant="default">{labels.statusActive}</Badge>
  );
}

/** The controls this caller can really use on this member, taken from the database's own advisory answer (can*). A
 * member with no usable control shows none — and the last Owner says why. No fake buttons. */
function MemberActions({
  member,
  labels,
  onAction,
}: {
  member: TeamMemberRow;
  labels: TeamMembersLabels;
  onAction?: (member: TeamMemberRow, action: MemberAccessAction) => void;
}) {
  if (!onAction) return null;
  const hasAny = member.canSuspend || member.canReactivate || member.canRemove;
  return (
    <div className="flex flex-col items-end gap-1">
      {hasAny ? (
        <div className="flex flex-wrap justify-end gap-2">
          {member.canSuspend ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onAction(member, "suspend")}>
              {labels.actions.suspend}
            </Button>
          ) : null}
          {member.canReactivate ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onAction(member, "reactivate")}>
              {labels.actions.reactivate}
            </Button>
          ) : null}
          {member.canRemove ? (
            <Button type="button" variant="destructive" size="sm" onClick={() => onAction(member, "remove")}>
              {labels.actions.remove}
            </Button>
          ) : null}
        </div>
      ) : null}
      {member.isLastUnrestrictedHolder ? (
        <p className="text-muted-foreground max-w-56 text-right text-xs">{labels.lastOwnerNote}</p>
      ) : null}
    </div>
  );
}

function NameCell({ member, labels }: { member: TeamMemberRow; labels: TeamMembersLabels }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-medium">{member.displayName}</span>
      {member.isSelf ? <Badge variant="outline">{labels.selfBadge}</Badge> : null}
    </span>
  );
}

/** Mirrors ReportsStaffComparison's own pattern (components/reports/reports-staff-comparison.tsx): one list, rendered
 * twice via responsive Tailwind visibility, not two data-fetching paths. Deliberately never shows a membership's raw
 * id or an auth user id as visible text — only the person's name, e-mail, role, state and linked-staff name. */
export function TeamMembersSection({
  members,
  labels,
  onAction,
}: {
  members: TeamMemberRow[];
  labels: TeamMembersLabels;
  onAction?: (member: TeamMemberRow, action: MemberAccessAction) => void;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.nameColumn}</TableHead>
              <TableHead>{labels.emailColumn}</TableHead>
              <TableHead>{labels.roleColumn}</TableHead>
              <TableHead>{labels.statusColumn}</TableHead>
              <TableHead>{labels.staffLinkColumn}</TableHead>
              {onAction ? <TableHead className="text-right">{labels.actionsColumn}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.membershipId} className={member.status === "suspended" ? "opacity-70" : undefined}>
                <TableCell>
                  <NameCell member={member} labels={labels} />
                </TableCell>
                <TableCell className="text-muted-foreground max-w-56 truncate" title={member.email ?? undefined}>
                  {member.email ?? labels.noEmail}
                </TableCell>
                <TableCell>{member.roleName}</TableCell>
                <TableCell>
                  <StatusBadge member={member} labels={labels} />
                </TableCell>
                <TableCell className="text-muted-foreground">{member.linkedStaffName ?? labels.unlinkedLabel}</TableCell>
                {onAction ? (
                  <TableCell className="text-right">
                    <MemberActions member={member} labels={labels} onAction={onAction} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        {members.map((member) => (
          <div
            key={member.membershipId}
            className={`bg-card rounded-lg border p-4 ${member.status === "suspended" ? "opacity-70" : ""}`}
          >
            <div className="flex items-start justify-between gap-3">
              <h3>
                <NameCell member={member} labels={labels} />
              </h3>
              <StatusBadge member={member} labels={labels} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{labels.emailColumn}</dt>
              <dd className="text-right break-all">{member.email ?? labels.noEmail}</dd>

              <dt className="text-muted-foreground">{labels.roleColumn}</dt>
              <dd className="text-right">{member.roleName}</dd>

              <dt className="text-muted-foreground">{labels.staffLinkColumn}</dt>
              <dd className="text-right">{member.linkedStaffName ?? labels.unlinkedLabel}</dd>
            </dl>
            {onAction ? (
              <div className="mt-3 flex justify-end">
                <MemberActions member={member} labels={labels} onAction={onAction} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
