"use client";

import { useMemo, useState } from "react";
import { Plus, Search, Users } from "lucide-react";
import type {
  StaffListRow,
  BranchOption,
  ServiceOption,
  MembershipOption,
} from "@/lib/modules/staff/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StaffList } from "@/components/staff/staff-list";
import { CreateStaffDialog } from "@/components/staff/create-staff-dialog";
import { StaffDetailSheet } from "@/components/staff/staff-detail-sheet";

type Labels = {
  title: string;
  description: string;
  addStaff: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyCta: string;
  noResults: string;
  countLabel: string;
  activeCountLabel: string;
  noBranchWarning: string;
};

export function StaffPageClient({
  tenantId,
  tenantSlug,
  canManage,
  initialStaff,
  branches,
  services,
  memberships,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  canManage: boolean;
  initialStaff: StaffListRow[];
  branches: BranchOption[];
  services: ServiceOption[];
  memberships: MembershipOption[];
  labels: Labels;
}) {
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("tr");
    if (!q) return initialStaff;
    return initialStaff.filter(
      (s) =>
        s.fullName.toLocaleLowerCase("tr").includes(q) ||
        (s.email ?? "").toLocaleLowerCase("tr").includes(q) ||
        (s.phone ?? "").includes(q),
    );
  }, [initialStaff, search]);

  const activeCount = initialStaff.filter((s) => s.status === "active").length;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{labels.description}</p>
        </div>
        {canManage && initialStaff.length > 0 && (
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus />
            {labels.addStaff}
          </Button>
        )}
      </div>

      {initialStaff.length > 0 && (
        <div className="mt-6 flex items-center gap-4 text-sm">
          <span className="text-foreground font-medium">
            {labels.countLabel}: {initialStaff.length}
          </span>
          <span className="text-muted-foreground">
            {labels.activeCountLabel}: {activeCount}
          </span>
        </div>
      )}

      {initialStaff.length > 0 && (
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
        {initialStaff.length === 0 ? (
          <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full">
              <Users className="text-muted-foreground size-6" />
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
          <StaffList
            items={filtered}
            noBranchWarning={labels.noBranchWarning}
            onSelect={(id) => setSelectedStaffId(id)}
          />
        )}
      </div>

      {canManage && (
        <CreateStaffDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          branches={branches}
          memberships={memberships}
          onCreated={(id) => {
            setCreateOpen(false);
            setSelectedStaffId(id);
          }}
        />
      )}

      <StaffDetailSheet
        staffMemberId={selectedStaffId}
        onOpenChange={(open) => {
          if (!open) setSelectedStaffId(null);
        }}
        tenantId={tenantId}
        tenantSlug={tenantSlug}
        canManage={canManage}
        branches={branches}
        services={services}
        memberships={memberships}
      />
    </div>
  );
}
