"use client";

import { AlertTriangle, Clock } from "lucide-react";
import type { ServiceListRow } from "@/lib/modules/services/queries";
import { Badge } from "@/components/ui/badge";

const priceFormatter = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "TRY",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function ServiceList({
  items,
  noBranchWarning,
  onSelect,
}: {
  items: ServiceListRow[];
  noBranchWarning: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="border-border divide-border overflow-hidden rounded-xl border">
      {items.map((service) => (
        <li key={service.id}>
          <button
            type="button"
            onClick={() => onSelect(service.id)}
            className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:bg-muted/50 focus-visible:outline-none"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{service.name}</span>
                {service.status === "inactive" && (
                  <Badge variant="secondary" className="shrink-0">
                    Pasif
                  </Badge>
                )}
                {service.branchNames.length === 0 && (
                  <span
                    title={noBranchWarning}
                    className="text-destructive flex shrink-0 items-center gap-1 text-xs"
                  >
                    <AlertTriangle className="size-3.5" />
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                {service.category && <span>{service.category}</span>}
                <span className="flex items-center gap-1">
                  <Clock className="size-3" />
                  {service.durationMinutes} dk
                </span>
                <span>{priceFormatter.format(Number(service.price))}</span>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              {service.branchNames.slice(0, 2).map((name) => (
                <Badge key={name} variant="outline">
                  {name}
                </Badge>
              ))}
              {service.branchNames.length > 2 && (
                <Badge variant="outline">+{service.branchNames.length - 2}</Badge>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
