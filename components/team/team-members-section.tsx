"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TeamMemberRow } from "@/lib/modules/team/queries";

export type MemberActionKind = "role" | "suspend" | "reactivate" | "remove";

type Labels = {
  nameColumn: string;
  roleColumn: string;
  staffLinkColumn: string;
  statusColumn: string;
  actionsColumn: string;
  unlinkedLabel: string;
  selfBadge: string;
  statusActive: string;
  statusSuspended: string;
  changeRole: string;
  suspend: string;
  reactivate: string;
  remove: string;
  noActions: string;
};

function StatusBadge({ member, labels }: { member: TeamMemberRow; labels: Labels }) {
  return member.status === "suspended" ? (
    <Badge variant="secondary">{labels.statusSuspended}</Badge>
  ) : (
    <Badge variant="outline">{labels.statusActive}</Badge>
  );
}

/** What the Owner may do to ONE member. Shown only when the database says this
 * caller may manage this member (`canManage`, the same decision the
 * mutations make) and the row is not the caller's own; the mutations re-check
 * both regardless of what is rendered here. Every control names the member in
 * its accessible label so a screen-reader list of buttons is not ambiguous. */
function MemberActions({
  member,
  labels,
  onAction,
}: {
  member: TeamMemberRow;
  labels: Labels;
  onAction: (kind: MemberActionKind, member: TeamMemberRow) => void;
}) {
  if (!member.canManage || member.isSelf) {
    return <span className="text-muted-foreground">{labels.noActions}</span>;
  }
  const named = (text: string) => `${text}: ${member.displayName}`;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button type="button" variant="outline" size="sm" aria-label={named(labels.changeRole)} onClick={() => onAction("role", member)}>
        {labels.changeRole}
      </Button>
      {member.status === "active" ? (
        <Button type="button" variant="outline" size="sm" aria-label={named(labels.suspend)} onClick={() => onAction("suspend", member)}>
          {labels.suspend}
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" aria-label={named(labels.reactivate)} onClick={() => onAction("reactivate", member)}>
          {labels.reactivate}
        </Button>
      )}
      <Button type="button" variant="destructive" size="sm" aria-label={named(labels.remove)} onClick={() => onAction("remove", member)}>
        {labels.remove}
      </Button>
    </div>
  );
}

/** Mirrors ReportsStaffComparison's own pattern (components/reports/
 * reports-staff-comparison.tsx): one list, rendered twice via responsive
 * Tailwind visibility, not two data-fetching paths. Deliberately never
 * shows a membership's id or the auth user id as visible text — only the
 * resolved display name, role name, status and linked-staff name. (Faz
 * LAUNCH.1A: the row type no longer carries an auth user id at all.) */
export function TeamMembersSection({
  members,
  labels,
  onAction,
}: {
  members: TeamMemberRow[];
  labels: Labels;
  onAction: (kind: MemberActionKind, member: TeamMemberRow) => void;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.nameColumn}</TableHead>
              <TableHead>{labels.roleColumn}</TableHead>
              <TableHead>{labels.staffLinkColumn}</TableHead>
              <TableHead>{labels.statusColumn}</TableHead>
              <TableHead className="text-right">{labels.actionsColumn}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.membershipId}>
                <TableCell className="font-medium">
                  {member.displayName}
                  {member.isSelf ? (
                    <Badge variant="secondary" className="ml-2">
                      {labels.selfBadge}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{member.roleName}</TableCell>
                <TableCell className="text-muted-foreground">{member.linkedStaffName ?? labels.unlinkedLabel}</TableCell>
                <TableCell>
                  <StatusBadge member={member} labels={labels} />
                </TableCell>
                <TableCell className="text-right">
                  <MemberActions member={member} labels={labels} onAction={onAction} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        {members.map((member) => (
          <div key={member.membershipId} className="bg-card rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-medium">
                {member.displayName}
                {member.isSelf ? (
                  <Badge variant="secondary" className="ml-2">
                    {labels.selfBadge}
                  </Badge>
                ) : null}
              </h3>
              <StatusBadge member={member} labels={labels} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{labels.roleColumn}</dt>
              <dd className="text-right">{member.roleName}</dd>
              <dt className="text-muted-foreground">{labels.staffLinkColumn}</dt>
              <dd className="text-right">{member.linkedStaffName ?? labels.unlinkedLabel}</dd>
            </dl>
            <div className="mt-3">
              <MemberActions member={member} labels={labels} onAction={onAction} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
