"use client";

import { startTransition, useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/errors";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { changeMemberRoleAction } from "@/lib/modules/team/member-actions";
import type { ChangeMemberRoleInput, MemberActionResultData } from "@/lib/modules/team/member-management";
import { MEMBER_STATE_CHANGED_MESSAGE } from "@/lib/modules/team/helpers";
import type { AssignableRoleOption, TeamMemberRow } from "@/lib/modules/team/queries";

type Labels = {
  title: string;
  /** Contains "{name}" already substituted by the caller. */
  description: string;
  roleLabel: string;
  rolePlaceholder: string;
  noRoles: string;
  submit: string;
  pending: string;
  cancel: string;
};

/**
 * Faz LAUNCH.1A — change ONE member's role. The roles offered are the ones the
 * database says THIS caller may assign (list_assignable_roles) minus the role
 * the member already has; update_membership_role re-checks everything (grant
 * ceiling, strictly-below rule, last Owner, release gate) and its refusal is
 * shown as-is. Mount with `key={member.membershipId}` so the picked role
 * resets between members.
 */
export function ChangeMemberRoleDialog({
  open,
  onOpenChange,
  tenantId,
  tenantSlug,
  member,
  roles,
  onDone,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  member: TeamMemberRow;
  roles: AssignableRoleOption[];
  onDone: () => void;
  labels: Labels;
}) {
  const router = useRouter();
  const [newRoleId, setNewRoleId] = useState("");
  const options = roles.filter((role) => role.id !== member.roleId);

  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<MemberActionResultData> | null,
      input: ChangeMemberRoleInput & { tenantSlug: string },
    ): Promise<ActionResult<MemberActionResultData>> => {
      const result = await changeMemberRoleAction(prevState, input);
      if (result.success) {
        onDone();
      } else if (result.error.message === MEMBER_STATE_CHANGED_MESSAGE) {
        router.refresh();
      }
      return result;
    },
    null,
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!newRoleId) return;
    startTransition(() =>
      formAction({
        tenantId,
        tenantSlug,
        membershipId: member.membershipId,
        newRoleId,
        expectedRoleId: member.roleId,
      }),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
            <DialogDescription>{labels.description}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {options.length === 0 ? (
              <p className="text-muted-foreground text-sm">{labels.noRoles}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="member-new-role">{labels.roleLabel}</Label>
                <Select value={newRoleId || undefined} onValueChange={(value) => setNewRoleId(value as string)}>
                  <SelectTrigger className="w-full" id="member-new-role">
                    {/* Base UI's Select.Value shows the raw stored value unless
                        given a label lookup — same pattern as the invitation dialog. */}
                    <SelectValue placeholder={labels.rolePlaceholder}>
                      {(value: string) => options.find((role) => role.id === value)?.name ?? labels.rolePlaceholder}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {state && !state.success ? (
              <p className="text-destructive text-sm" role="alert">
                {state.error.message}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
              {labels.cancel}
            </Button>
            <Button type="submit" disabled={isPending || !newRoleId || options.length === 0}>
              {isPending ? labels.pending : labels.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
