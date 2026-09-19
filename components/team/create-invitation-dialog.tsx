"use client";

import { startTransition, useActionState, useState } from "react";
import type { ActionResult } from "@/lib/errors";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createTeamInvitationAction,
  type CreateTeamInvitationInput,
  type CreateTeamInvitationResultData,
} from "@/lib/modules/team/actions";
import type { RoleOption, EligibleStaffOption } from "@/lib/modules/team/queries";

type Labels = {
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

export function CreateInvitationDialog({
  open,
  onOpenChange,
  tenantId,
  tenantSlug,
  roles,
  staffOptions,
  onCreated,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  roles: RoleOption[];
  staffOptions: EligibleStaffOption[];
  onCreated: (outcome: CreateTeamInvitationResultData["outcome"]) => void;
  labels: Labels;
}) {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [staffMemberId, setStaffMemberId] = useState("");

  // Success handling lives in the action itself, not a useEffect watching
  // `state` — same discipline as create-staff-dialog.tsx.
  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<CreateTeamInvitationResultData> | null,
      input: CreateTeamInvitationInput & { tenantSlug: string },
    ): Promise<ActionResult<CreateTeamInvitationResultData>> => {
      const result = await createTeamInvitationAction(prevState, input);
      if (result.success) {
        onCreated(result.data.outcome);
        setEmail("");
        setRoleId("");
        setStaffMemberId("");
      }
      return result;
    },
    null,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input: CreateTeamInvitationInput & { tenantSlug: string } = {
      tenantId,
      tenantSlug,
      email,
      roleId,
      staffMemberId: staffMemberId || undefined,
    };
    startTransition(() => formAction(input));
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">{labels.emailLabel}</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-role">{labels.roleLabel}</Label>
              <Select value={roleId || undefined} onValueChange={(v) => setRoleId(v as string)}>
                <SelectTrigger className="w-full" id="invite-role">
                  <SelectValue placeholder={labels.rolePlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {staffOptions.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>{labels.staffLinkLabel}</Label>
                <Select
                  value={staffMemberId || "none"}
                  onValueChange={(v) => setStaffMemberId(v === "none" ? "" : (v as string))}
                >
                  <SelectTrigger className="w-full">
                    {/* Base UI's Select.Value shows the raw stored value
                        unless given an explicit label-lookup render
                        function — same pattern as create-staff-dialog.tsx. */}
                    <SelectValue placeholder={labels.staffLinkPlaceholder}>
                      {(value: string) => {
                        const staff = staffOptions.find((s) => s.id === value);
                        return staff ? staff.fullName : labels.staffLinkNone;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{labels.staffLinkNone}</SelectItem>
                    {staffOptions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.fullName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{labels.staffLinkHelper}</p>
              </div>
            )}

            {state && !state.success && (
              <p className="text-destructive text-sm" role="alert">
                {state.error.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isPending || !email.trim() || !roleId}>
              {isPending ? labels.submitPending : labels.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
