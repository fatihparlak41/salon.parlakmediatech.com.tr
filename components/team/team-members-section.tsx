import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import type { TeamMemberRow } from "@/lib/modules/team/queries";

type Labels = {
  nameColumn: string;
  roleColumn: string;
  staffLinkColumn: string;
  unlinkedLabel: string;
};

/** Mirrors ReportsStaffComparison's own pattern (components/reports/
 * reports-staff-comparison.tsx): one list, rendered twice via responsive
 * Tailwind visibility, not two data-fetching paths. Deliberately never
 * shows a membership's raw user_id/membershipId as visible text — only
 * the resolved display name, role name, and linked-staff name. */
export function TeamMembersSection({ members, labels }: { members: TeamMemberRow[]; labels: Labels }) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.nameColumn}</TableHead>
              <TableHead>{labels.roleColumn}</TableHead>
              <TableHead>{labels.staffLinkColumn}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.membershipId}>
                <TableCell className="font-medium">{member.displayName}</TableCell>
                <TableCell>{member.roleName}</TableCell>
                <TableCell className="text-muted-foreground">
                  {member.linkedStaffName ?? labels.unlinkedLabel}
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
              <h3 className="font-medium">{member.displayName}</h3>
              <span className="text-muted-foreground text-sm">{member.roleName}</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{labels.staffLinkColumn}</dt>
              <dd className="text-right">{member.linkedStaffName ?? labels.unlinkedLabel}</dd>
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}
