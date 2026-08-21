"use client";

import { Users, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { CalendarStaffOption } from "@/lib/modules/appointments/queries";

/** Practical narrowing for a branch with many staff — horizontal scroll
 * through the day-view columns remains acceptable for moderate counts,
 * this is for when the operator wants to focus on a subset. Trigger
 * renders its own label directly (not Base UI's Select.Value), so it
 * has none of the raw-value-display issue fixed elsewhere this phase. */
export function StaffFilter({
  staff,
  selectedIds,
  onChange,
}: {
  staff: CalendarStaffOption[];
  selectedIds: Set<string>;
  onChange: (ids: Set<string>) => void;
}) {
  const allSelected = selectedIds.size === staff.length;

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="border-input hover:bg-accent focus-visible:ring-ring/50 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3">
        <Users className="size-4" />
        {allSelected ? "Tüm personel" : `${selectedIds.size} personel`}
        <ChevronDown className="text-muted-foreground size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem onClick={() => onChange(new Set(staff.map((s) => s.id)))}>Tümünü seç</DropdownMenuItem>
        <DropdownMenuSeparator />
        {staff.map((s) => (
          <DropdownMenuCheckboxItem key={s.id} checked={selectedIds.has(s.id)} onCheckedChange={() => toggle(s.id)}>
            {s.fullName}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
