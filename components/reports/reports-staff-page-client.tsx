"use client";

import { ChevronDown, ChartColumn } from "lucide-react";
import { useRouter, usePathname } from "@/lib/i18n/navigation";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { BranchOption, ServiceOption } from "@/lib/modules/staff/queries";
import type { StaffReportData } from "@/lib/modules/reports/queries";
import type { ReportsStaffFilters, DateRangePreset } from "@/lib/modules/reports/schemas";
import { fillTemplate } from "@/lib/modules/reports/format";
import { ReportsSummaryCards } from "@/components/reports/reports-summary-cards";
import { ReportsStaffComparison } from "@/components/reports/reports-staff-comparison";

type StaffOption = { id: string; fullName: string; status: string };

type Labels = {
  title: string;
  description: string;
  filters: {
    dateLabel: string;
    branchLabel: string;
    staffLabel: string;
    serviceLabel: string;
    rangeToday: string;
    rangeWeek: string;
    rangeMonth: string;
    rangeLast30: string;
    rangeCustom: string;
    customStartLabel: string;
    customEndLabel: string;
    allBranches: string;
    allStaffPlaceholder: string;
    allServicesPlaceholder: string;
    staffSelectedCountTemplate: string;
    serviceSelectedCountTemplate: string;
    serviceFilterHelper: string;
  };
  summary: {
    completedServiceItems: string;
    uniqueCustomers: string;
    newCustomers: string;
    returningCustomersSuffix: string;
    utilization: string;
  };
  table: {
    staffColumn: string;
    completedServiceItemsColumn: string;
    customersColumn: string;
    customersBreakdownTemplate: string;
    completedMinutesColumn: string;
    utilizationColumn: string;
    cancelledColumn: string;
    noShowColumn: string;
    serviceMixColumn: string;
    serviceMixMoreTemplate: string;
  };
  utilization: {
    unavailable: string;
    noScheduleHelper: string;
    tooltip: string;
  };
  emptyFiltered: {
    title: string;
    description: string;
  };
  error: {
    title: string;
    description: string;
  };
  minutesFormatTemplate: string;
};

/** Reads/writes filters through the URL — the entire "state" of this
 * page, so the report stays refreshable/shareable (Faz 5A.3C's URL
 * filter contract). No client-side data-fetching library: every change
 * here triggers a normal Next.js navigation, which re-runs the Server
 * Component with the new searchParams and hands back fresh RPC data. */
function useFilterNavigation() {
  const router = useRouter();
  const pathname = usePathname();

  return (updates: Record<string, string | string[] | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(updates)) {
      const isEmpty = value === null || value === "" || (Array.isArray(value) && value.length === 0);
      if (isEmpty) {
        params.delete(key);
      } else {
        params.set(key, Array.isArray(value) ? value.join(",") : value);
      }
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };
}

function MultiSelectFilter({
  label,
  placeholder,
  selectedCountTemplate,
  options,
  selectedIds,
  onChange,
}: {
  label: string;
  placeholder: string;
  selectedCountTemplate: string;
  options: { id: string; label: string }[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    const next = selectedIds.includes(id) ? selectedIds.filter((s) => s !== id) : [...selectedIds, id];
    onChange(next);
  };

  const triggerText =
    selectedIds.length === 0 ? placeholder : fillTemplate(selectedCountTemplate, { count: selectedIds.length });

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-muted-foreground text-xs font-medium">{label}</Label>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" className="min-w-40 justify-between font-normal">
              <span className="truncate">{triggerText}</span>
              <ChevronDown className="text-muted-foreground size-4 shrink-0" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {options.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">—</p>
          ) : (
            options.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt.id}
                checked={selectedIds.includes(opt.id)}
                onCheckedChange={() => toggle(opt.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {opt.label}
              </DropdownMenuCheckboxItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ReportsStaffPageClient({
  filters,
  branches,
  services,
  staffOptions,
  reportData,
  hasError,
  labels,
}: {
  filters: ReportsStaffFilters;
  branches: BranchOption[];
  services: ServiceOption[];
  staffOptions: StaffOption[];
  reportData: StaffReportData | null;
  hasError: boolean;
  labels: Labels;
}) {
  const navigate = useFilterNavigation();

  const rangeOptions: { value: DateRangePreset; label: string }[] = [
    { value: "today", label: labels.filters.rangeToday },
    { value: "week", label: labels.filters.rangeWeek },
    { value: "month", label: labels.filters.rangeMonth },
    { value: "last30", label: labels.filters.rangeLast30 },
    { value: "custom", label: labels.filters.rangeCustom },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex items-start gap-3">
        <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
          <ChartColumn className="text-muted-foreground size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{labels.description}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-end gap-3 sm:gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-xs font-medium">{labels.filters.dateLabel}</Label>
          <Select value={filters.range} onValueChange={(v) => navigate({ range: v, start: null, end: null })}>
            <SelectTrigger className="min-w-36">
              {/* Base UI's Select.Value shows the raw stored value unless
                  given an explicit label-lookup render function — same
                  pattern as create-staff-dialog.tsx/self-service-policy-form.tsx. */}
              <SelectValue>
                {(value: DateRangePreset) => rangeOptions.find((opt) => opt.value === value)?.label ?? value}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {rangeOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {filters.range === "custom" && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-xs font-medium">{labels.filters.customStartLabel}</Label>
              <Input
                type="date"
                value={filters.customStart ?? ""}
                max={filters.customEnd ?? undefined}
                onChange={(e) => navigate({ range: "custom", start: e.target.value })}
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-xs font-medium">{labels.filters.customEndLabel}</Label>
              <Input
                type="date"
                value={filters.customEnd ?? ""}
                min={filters.customStart ?? undefined}
                onChange={(e) => navigate({ range: "custom", end: e.target.value })}
                className="w-40"
              />
            </div>
          </>
        )}

        {branches.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-xs font-medium">{labels.filters.branchLabel}</Label>
            <Select
              value={filters.branchId ?? "__all__"}
              onValueChange={(v) => navigate({ branch: v === "__all__" ? null : v })}
            >
              <SelectTrigger className="min-w-40">
                <SelectValue>
                  {(value: string) =>
                    value === "__all__" ? labels.filters.allBranches : (branches.find((b) => b.id === value)?.name ?? value)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{labels.filters.allBranches}</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <MultiSelectFilter
          label={labels.filters.staffLabel}
          placeholder={labels.filters.allStaffPlaceholder}
          selectedCountTemplate={labels.filters.staffSelectedCountTemplate}
          options={staffOptions.map((s) => ({ id: s.id, label: s.fullName }))}
          selectedIds={filters.staffIds}
          onChange={(ids) => navigate({ staff: ids })}
        />

        <MultiSelectFilter
          label={labels.filters.serviceLabel}
          placeholder={labels.filters.allServicesPlaceholder}
          selectedCountTemplate={labels.filters.serviceSelectedCountTemplate}
          options={services.map((s) => ({ id: s.id, label: s.name }))}
          selectedIds={filters.serviceIds}
          onChange={(ids) => navigate({ service: ids })}
        />
      </div>

      {filters.serviceIds.length > 0 && (
        <p className="text-muted-foreground mt-3 text-xs">{labels.filters.serviceFilterHelper}</p>
      )}

      {/* Content */}
      <div className="mt-6">
        {hasError ? (
          <div className="border-border flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
            <h2 className="text-base font-medium">{labels.error.title}</h2>
            <p className="text-muted-foreground max-w-sm text-sm">{labels.error.description}</p>
          </div>
        ) : reportData === null ? null : (
          <>
            <ReportsSummaryCards
              totals={reportData.totals}
              labels={labels.summary}
              utilizationLabels={{ unavailable: labels.utilization.unavailable }}
            />

            <div className="mt-6">
              {reportData.staff.length === 0 ? (
                <div className="border-border flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
                  <h2 className="text-base font-medium">{labels.emptyFiltered.title}</h2>
                  <p className="text-muted-foreground max-w-sm text-sm">{labels.emptyFiltered.description}</p>
                </div>
              ) : (
                <ReportsStaffComparison
                  rows={reportData.staff}
                  tableLabels={labels.table}
                  utilizationLabels={labels.utilization}
                  minutesFormatTemplate={labels.minutesFormatTemplate}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
