"use client";

import { useMemo, useState } from "react";
import { Plus, Search, Scissors } from "lucide-react";
import type { ServiceListRow } from "@/lib/modules/services/queries";
import type { BranchOption } from "@/lib/modules/staff/queries";
import type { StaffOption } from "@/lib/modules/services/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ServiceList } from "@/components/services/service-list";
import { CreateServiceDialog } from "@/components/services/create-service-dialog";
import { ServiceDetailSheet } from "@/components/services/service-detail-sheet";

type Labels = {
  title: string;
  description: string;
  addService: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyCta: string;
  noResults: string;
  countLabel: string;
  activeCountLabel: string;
  noBranchWarning: string;
};

export function ServicesPageClient({
  tenantId,
  tenantSlug,
  canManage,
  canManageStaffEligibility,
  initialServices,
  branches,
  existingCategories,
  staffOptions,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  canManage: boolean;
  canManageStaffEligibility: boolean;
  initialServices: ServiceListRow[];
  branches: BranchOption[];
  existingCategories: string[];
  staffOptions: StaffOption[];
  labels: Labels;
}) {
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("tr");
    if (!q) return initialServices;
    return initialServices.filter(
      (s) =>
        s.name.toLocaleLowerCase("tr").includes(q) ||
        (s.category ?? "").toLocaleLowerCase("tr").includes(q),
    );
  }, [initialServices, search]);

  const activeCount = initialServices.filter((s) => s.status === "active").length;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{labels.description}</p>
        </div>
        {canManage && initialServices.length > 0 && (
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus />
            {labels.addService}
          </Button>
        )}
      </div>

      {initialServices.length > 0 && (
        <div className="mt-6 flex items-center gap-4 text-sm">
          <span className="text-foreground font-medium">
            {labels.countLabel}: {initialServices.length}
          </span>
          <span className="text-muted-foreground">
            {labels.activeCountLabel}: {activeCount}
          </span>
        </div>
      )}

      {initialServices.length > 0 && (
        <div className="relative mt-4">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={labels.searchPlaceholder}
            className="pl-9"
          />
        </div>
      )}

      <div className="mt-4">
        {initialServices.length === 0 ? (
          <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full">
              <Scissors className="text-muted-foreground size-6" />
            </div>
            <h2 className="text-base font-medium">{labels.emptyTitle}</h2>
            <p className="text-muted-foreground max-w-sm text-sm">{labels.emptyDescription}</p>
            {canManage && (
              <Button onClick={() => setCreateOpen(true)} className="mt-2">
                <Plus />
                {labels.emptyCta}
              </Button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground py-10 text-center text-sm">{labels.noResults}</p>
        ) : (
          <ServiceList
            items={filtered}
            noBranchWarning={labels.noBranchWarning}
            onSelect={(id) => setSelectedServiceId(id)}
          />
        )}
      </div>

      {canManage && (
        <CreateServiceDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          branches={branches}
          existingCategories={existingCategories}
          onCreated={(id) => {
            setCreateOpen(false);
            setSelectedServiceId(id);
          }}
        />
      )}

      <ServiceDetailSheet
        serviceId={selectedServiceId}
        onOpenChange={(open) => {
          if (!open) setSelectedServiceId(null);
        }}
        tenantSlug={tenantSlug}
        canManage={canManage}
        canManageStaffEligibility={canManageStaffEligibility}
        branches={branches}
        staffOptions={staffOptions}
        existingCategories={existingCategories}
      />
    </div>
  );
}
