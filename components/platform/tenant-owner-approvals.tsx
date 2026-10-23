"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { approveTenantOwnerAction, revokeTenantOwnerApprovalAction } from "@/lib/modules/platform/actions";
import type { TenantOwnerApprovalRow } from "@/lib/modules/platform/approvals";

type Labels = {
  heading: string;
  description: string;
  emailLabel: string;
  noteLabel: string;
  daysLabel: string;
  /** "{count} gün" with the count already substituted for each option. */
  daysOptions: { value: number; label: string }[];
  submit: string;
  submitting: string;
  approvedMessage: string;
  revokedMessage: string;
  revoke: string;
  revoking: string;
  empty: string;
  columns: { email: string; note: string; status: string; expires: string; salon: string; actions: string };
  status: Record<string, string>;
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  approved: "default",
  expired: "secondary",
  consumed: "outline",
  revoked: "destructive",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("tr-TR");
}

function RevokeButton({ approvalId, labels }: { approvalId: string; labels: Labels }) {
  const [state, formAction, isPending] = useActionState(revokeTenantOwnerApprovalAction, null);
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="approvalId" value={approvalId} />
      <Button type="submit" variant="outline" size="sm" disabled={isPending}>
        {isPending ? labels.revoking : labels.revoke}
      </Button>
      {state && !state.success ? (
        <p className="text-destructive max-w-48 text-right text-xs" role="alert">
          {state.error.message}
        </p>
      ) : null}
      {state?.success ? (
        <p className="text-muted-foreground text-xs" role="status">
          {labels.revokedMessage}
        </p>
      ) : null}
    </form>
  );
}

/** Faz LAUNCH.1A — the owner-approval section of /super-admin: approve an
 * e-mail address to create ONE salon, see every approval, revoke an open one.
 * It carries no authority of its own: the page only renders it for a platform
 * owner, and every action runs through RPCs that re-check that. */
export function TenantOwnerApprovals({ rows, labels }: { rows: TenantOwnerApprovalRow[]; labels: Labels }) {
  const [state, formAction, isPending] = useActionState(approveTenantOwnerAction, null);

  return (
    <section className="mt-12 flex flex-col gap-4" aria-labelledby="tenant-owner-approvals-heading">
      <div>
        <h2 id="tenant-owner-approvals-heading" className="text-muted-foreground text-sm font-medium">
          {labels.heading}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{labels.description}</p>
      </div>

      <form action={formAction} className="border-border grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="approval-email">{labels.emailLabel}</Label>
          <Input id="approval-email" name="email" type="email" autoComplete="off" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="approval-note">{labels.noteLabel}</Label>
          <Input id="approval-note" name="note" type="text" maxLength={500} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="approval-days">{labels.daysLabel}</Label>
          <select
            id="approval-days"
            name="validDays"
            defaultValue="30"
            className="border-input bg-background h-8 rounded-lg border px-2 text-sm"
          >
            {labels.daysOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={isPending}>
          {isPending ? labels.submitting : labels.submit}
        </Button>
        {state && !state.success ? (
          <p className="text-destructive text-sm sm:col-span-4" role="alert">
            {state.error.message}
          </p>
        ) : null}
        {state?.success ? (
          <p className="text-sm sm:col-span-4" role="status">
            {labels.approvedMessage}
          </p>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{labels.empty}</p>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{labels.columns.email}</TableHead>
                <TableHead>{labels.columns.note}</TableHead>
                <TableHead>{labels.columns.status}</TableHead>
                <TableHead>{labels.columns.expires}</TableHead>
                <TableHead>{labels.columns.salon}</TableHead>
                <TableHead className="text-right">{labels.columns.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-56 truncate font-medium" title={row.email}>
                    {row.email}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-48 truncate" title={row.note ?? undefined}>
                    {row.note ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[row.effectiveStatus] ?? "outline"}>
                      {labels.status[row.effectiveStatus] ?? row.effectiveStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(row.expiresAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{row.consumedTenantName ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {/* An open approval (live or already past its expiry) can be closed; a consumed or revoked one is history. */}
                    {row.status === "approved" ? <RevokeButton approvalId={row.id} labels={labels} /> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
