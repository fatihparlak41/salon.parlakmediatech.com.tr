"use client";

import type { CustomerRow } from "@/lib/modules/customers/queries";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function CustomerList({
  items,
  onSelect,
}: {
  items: CustomerRow[];
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="border-border divide-border overflow-hidden rounded-xl border">
      {items.map((customer) => (
        <li key={customer.id}>
          <button
            type="button"
            onClick={() => onSelect(customer.id)}
            className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:bg-muted/50 focus-visible:outline-none"
          >
            <Avatar className="size-9 shrink-0">
              <AvatarFallback
                className={
                  customer.status === "active"
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
                }
              >
                {initialsFrom(customer.fullName)}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{customer.fullName}</span>
                {customer.status === "archived" && (
                  <Badge variant="secondary" className="shrink-0">
                    Arşivlenmiş
                  </Badge>
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                {customer.phone && <span>{customer.phone}</span>}
                {customer.email && <span className="truncate">{customer.email}</span>}
                {!customer.phone && !customer.email && <span>—</span>}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
