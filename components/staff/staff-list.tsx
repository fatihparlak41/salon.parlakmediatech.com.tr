"use client";

import { AlertTriangle } from "lucide-react";
import type { StaffListRow } from "@/lib/modules/staff/queries";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function StaffList({
  items,
  noBranchWarning,
  onSelect,
}: {
  items: StaffListRow[];
  noBranchWarning: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="border-border divide-border overflow-hidden rounded-xl border">
      {items.map((staff) => (
        <li key={staff.id}>
          <button
            type="button"
            onClick={() => onSelect(staff.id)}
            className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:bg-muted/50 focus-visible:outline-none"
          >
            <Avatar className="size-9 shrink-0">
              <AvatarFallback
                className={
                  staff.status === "active"
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
                }
              >
                {initialsFrom(staff.fullName)}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{staff.fullName}</span>
                {staff.status === "inactive" && (
                  <Badge variant="secondary" className="shrink-0">
                    Pasif
                  </Badge>
                )}
                {staff.branchNames.length === 0 && (
                  <span
                    title={noBranchWarning}
                    className="text-destructive flex shrink-0 items-center gap-1 text-xs"
                  >
                    <AlertTriangle className="size-3.5" />
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                {staff.email && <span className="truncate">{staff.email}</span>}
                {staff.phone && <span>{staff.phone}</span>}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              {staff.branchNames.slice(0, 2).map((name) => (
                <Badge key={name} variant="outline">
                  {name}
                </Badge>
              ))}
              {staff.branchNames.length > 2 && (
                <Badge variant="outline">+{staff.branchNames.length - 2}</Badge>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
