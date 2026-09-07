"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import type { AppointmentDetail, ServiceForBranch } from "@/lib/modules/appointments/queries";
import {
  fetchServicesForBranch,
  fetchEligibleStaff,
  fetchActiveStaffCount,
  type StaffOption,
} from "@/lib/modules/appointments/client-queries";
import {
  updateAppointmentStatusAction,
  rescheduleAppointmentAction,
  completeAppointmentAction,
  type UpdateAppointmentStatusInput,
  type RescheduleAppointmentInput,
  type CompleteAppointmentInput,
} from "@/lib/modules/appointments/actions";
import {
  STATUS_LABELS_TR,
  isTerminalStatus,
  getAvailableStatusTransitions,
  type AppointmentStatus,
  type AppointmentTransitionTarget,
} from "@/lib/modules/appointments/status";
import {
  formatTenantLocalDateTime,
  formatTenantLocalTime,
  utcIsoToTenantLocalParts,
  tenantLocalToUtcIso,
} from "@/lib/modules/appointments/timezone";
import { AppointmentItemsEditor, type ItemDraft } from "@/components/appointments/appointment-items-editor";

const STATUS_BADGE_VARIANT: Record<AppointmentStatus, "default" | "secondary" | "destructive" | "outline"> = {
  scheduled: "outline",
  confirmed: "default",
  in_progress: "default",
  completed: "secondary",
  cancelled: "destructive",
  no_show: "destructive",
};

/** Mirrors getAppointmentDetail's query/mapping exactly (client-side —
 * queries.ts is server-only). */
async function loadAppointmentDetail(appointmentId: string): Promise<AppointmentDetail | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("appointments")
    .select(
      // Faz 5A.1: staff_members!appointment_items_staff_member_id_fkey is
      // required, not stylistic. Faz 5A.2 adds a second, aliased embed
      // for the actual performer — see
      // lib/modules/appointments/queries.ts's comment on its own
      // (server-side) mirror of this exact query for the full reasoning.
      `id, status, scheduled_start_at, scheduled_end_at, notes, created_at,
       customers(id, full_name), branches(id, name),
       appointment_items(id, sequence, scheduled_start_at, scheduled_end_at, duration_minutes, price,
         services(id, name), staff_members!appointment_items_staff_member_id_fkey(id, full_name),
         actual_staff_members:staff_members!appointment_items_actual_staff_member_id_fkey(id, full_name))`,
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (error || !data) return null;
  const d = data as unknown as {
    id: string;
    status: string;
    scheduled_start_at: string;
    scheduled_end_at: string;
    notes: string | null;
    created_at: string;
    customers: { id: string; full_name: string } | null;
    branches: { id: string; name: string } | null;
    appointment_items: {
      id: string;
      sequence: number;
      scheduled_start_at: string;
      scheduled_end_at: string;
      duration_minutes: number;
      price: string;
      services: { id: string; name: string } | null;
      staff_members: { id: string; full_name: string } | null;
      actual_staff_members: { id: string; full_name: string } | null;
    }[];
  };
  // customers is null (not an error) when the caller has appointments.view
  // but not customers.view — RLS omits the embedded resource. The sheet
  // must still render for that caller, so only branches (member-readable,
  // never permission-gated) is treated as required. See AppointmentDetail.
  if (!d.branches) return null;

  return {
    id: d.id,
    status: d.status,
    scheduledStartAt: d.scheduled_start_at,
    scheduledEndAt: d.scheduled_end_at,
    notes: d.notes,
    createdAt: d.created_at,
    customer: d.customers ? { id: d.customers.id, fullName: d.customers.full_name } : null,
    branch: { id: d.branches.id, name: d.branches.name },
    items: d.appointment_items
      .filter((i) => i.services && i.staff_members)
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({
        id: i.id,
        sequence: i.sequence,
        scheduledStartAt: i.scheduled_start_at,
        scheduledEndAt: i.scheduled_end_at,
        durationMinutes: i.duration_minutes,
        price: String(i.price),
        service: { id: i.services!.id, name: i.services!.name },
        staffMember: { id: i.staff_members!.id, fullName: i.staff_members!.full_name },
        actualStaffMember: i.actual_staff_members ? { id: i.actual_staff_members.id, fullName: i.actual_staff_members.full_name } : null,
      })),
  };
}

export function AppointmentDetailSheet({
  appointmentId,
  onOpenChange,
  tenantId,
  tenantSlug,
  tenantTimezone,
  canUpdate,
  canCancel,
  onSaved,
}: {
  appointmentId: string | null;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  canUpdate: boolean;
  canCancel: boolean;
  onSaved: () => void;
}) {
  return (
    <Sheet open={appointmentId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {/* Keyed on appointmentId — same full-remount reset pattern as
            customer-detail-sheet.tsx / staff-detail-sheet.tsx. */}
        {appointmentId && (
          <AppointmentDetailBody
            key={appointmentId}
            appointmentId={appointmentId}
            tenantId={tenantId}
            tenantSlug={tenantSlug}
            tenantTimezone={tenantTimezone}
            canUpdate={canUpdate}
            canCancel={canCancel}
            onSaved={onSaved}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function AppointmentDetailBody({
  appointmentId,
  tenantId,
  tenantSlug,
  tenantTimezone,
  canUpdate,
  canCancel,
  onSaved,
  onClose,
}: {
  appointmentId: string;
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  canUpdate: boolean;
  canCancel: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // Faz 5A.2 — fetched once per sheet-open, not per click: the "solo
  // salon, skip the performer-selection step entirely" decision must be
  // instant when the owner clicks Tamamlandı (see StatusActions), not
  // gated behind its own network round trip at that moment.
  const [soloStaffCount, setSoloStaffCount] = useState<number | null>(null);

  async function reload() {
    const result = await loadAppointmentDetail(appointmentId);
    setDetail(result);
    onSaved();
  }

  useEffect(() => {
    Promise.all([loadAppointmentDetail(appointmentId), fetchActiveStaffCount(tenantId)]).then(([result, count]) => {
      setDetail(result);
      setSoloStaffCount(count);
      setLoading(false);
    });
  }, [appointmentId, tenantId]);

  if (loading || !detail) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const terminal = isTerminalStatus(detail.status);
  const otherTransitions = getAvailableStatusTransitions(detail.status).filter((s) => s !== "cancelled");
  const canCancelNow = canCancel && !terminal && detail.status !== "cancelled";

  return (
    <>
      <SheetHeader>
        <SheetTitle>{detail.customer?.fullName ?? "—"}</SheetTitle>
        <SheetDescription>
          {detail.branch.name} ·{" "}
          {formatTenantLocalDateTime(detail.scheduledStartAt, tenantTimezone)}
          {"–"}
          {formatTenantLocalTime(detail.scheduledEndAt, tenantTimezone)}
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Tabs defaultValue="details">
          <TabsList className={`grid w-full ${canUpdate && !terminal ? "grid-cols-2" : "grid-cols-1"}`}>
            <TabsTrigger value="details">Detaylar</TabsTrigger>
            {canUpdate && !terminal && <TabsTrigger value="reschedule">Yeniden planla</TabsTrigger>}
          </TabsList>

          <TabsContent value="details" className="flex flex-col gap-5 pt-4">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-sm font-medium">Durum</span>
              <Badge variant={STATUS_BADGE_VARIANT[detail.status as AppointmentStatus] ?? "outline"}>
                {STATUS_LABELS_TR[detail.status as AppointmentStatus] ?? detail.status}
              </Badge>
            </div>

            {(otherTransitions.length > 0 && canUpdate) || canCancelNow ? (
              <StatusActions
                appointmentId={appointmentId}
                tenantSlug={tenantSlug}
                branchId={detail.branch.id}
                items={detail.items}
                otherTransitions={canUpdate ? otherTransitions : []}
                canCancelNow={canCancelNow}
                // null (still loading) is treated as NOT solo — the
                // instant it resolves this only ever narrows behavior
                // toward showing the (always-correct) confirmation panel,
                // never toward silently skipping it before we actually
                // know the tenant's real staff count.
                isSoloSalon={soloStaffCount !== null && soloStaffCount <= 1}
                onSaved={reload}
              />
            ) : null}

            <div className="flex flex-col gap-3">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Hizmetler</p>
              {detail.items.map((item) => (
                <div key={item.id} className="flex flex-col gap-1 rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{item.service.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {formatTenantLocalTime(item.scheduledStartAt, tenantTimezone)}–
                      {formatTenantLocalTime(item.scheduledEndAt, tenantTimezone)}
                    </span>
                  </div>
                  <div className="text-muted-foreground flex items-center justify-between text-xs">
                    {/* Faz 5A.2 — booked vs actual performer only ever
                        shown as two lines when they genuinely differ; a
                        not-yet-completed item (actualStaffMember null) or
                        one where they match renders exactly as before
                        Faz 5A.2 existed. Never editable here — completion
                        is the only path that ever sets this, and only
                        once (see the RPC's own terminal-state guard). */}
                    {item.actualStaffMember && item.actualStaffMember.id !== item.staffMember.id ? (
                      <span className="flex flex-col gap-0.5">
                        <span>Randevu Personeli: {item.staffMember.fullName}</span>
                        <span className="font-medium">Uygulayan: {item.actualStaffMember.fullName}</span>
                      </span>
                    ) : (
                      <span>{item.staffMember.fullName}</span>
                    )}
                    <span>
                      {item.durationMinutes} dk · ₺{item.price}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {detail.notes && (
              <div className="flex flex-col gap-1.5">
                <Label>Notlar</Label>
                <p className="text-muted-foreground text-sm whitespace-pre-wrap">{detail.notes}</p>
              </div>
            )}

            <p className="text-muted-foreground text-xs">
              Oluşturulma: {formatTenantLocalDateTime(detail.createdAt, tenantTimezone)}
            </p>
          </TabsContent>

          {canUpdate && !terminal && (
            <TabsContent value="reschedule" className="pt-4">
              <RescheduleForm
                tenantId={tenantId}
                tenantSlug={tenantSlug}
                tenantTimezone={tenantTimezone}
                detail={detail}
                onSaved={async () => {
                  await reload();
                  onClose();
                }}
              />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </>
  );
}

/**
 * Faz 5A.2 — every transition except "completed" is unchanged: one
 * generic button per target, straight through updateAppointmentStatusAction.
 * "completed" is special-cased (update_appointment_status no longer
 * accepts it at all — closed completion bypass, Option A):
 *   - solo salon (isSoloSalon): completes immediately with zero
 *     overrides, same one-click feel as every other transition here —
 *     no panel, no dropdown, just a (very slightly slower, one extra
 *     round trip) "Tamamlandı" click.
 *   - multi-staff salon: opens CompletionPanel instead of completing
 *     immediately, so the owner can correct the actual performer per
 *     item before confirming.
 */
function StatusActions({
  appointmentId,
  tenantSlug,
  branchId,
  items,
  otherTransitions,
  canCancelNow,
  isSoloSalon,
  onSaved,
}: {
  appointmentId: string;
  tenantSlug: string;
  branchId: string;
  items: AppointmentDetail["items"];
  otherTransitions: AppointmentTransitionTarget[];
  canCancelNow: boolean;
  isSoloSalon: boolean;
  onSaved: () => void;
}) {
  const [showCompletionPanel, setShowCompletionPanel] = useState(false);

  const [statusState, statusAction, statusPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateAppointmentStatusInput) => {
      const result = await updateAppointmentStatusAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );

  const [completeState, completeAction, completePending] = useActionState(
    async (prevState: ActionResult<null> | null, input: CompleteAppointmentInput) => {
      const result = await completeAppointmentAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );

  function transition(status: UpdateAppointmentStatusInput["status"]) {
    startTransition(() => statusAction({ tenantSlug, appointmentId, status }));
  }

  function handleCompleteClick() {
    if (isSoloSalon) {
      startTransition(() => completeAction({ tenantSlug, appointmentId, performerOverrides: [] }));
    } else {
      setShowCompletionPanel(true);
    }
  }

  const nonCompletionTransitions = otherTransitions.filter(
    (s): s is Exclude<AppointmentTransitionTarget, "completed"> => s !== "completed",
  );
  const canComplete = otherTransitions.includes("completed");

  if (showCompletionPanel) {
    return (
      <CompletionPanel
        appointmentId={appointmentId}
        tenantSlug={tenantSlug}
        branchId={branchId}
        items={items}
        onCancel={() => setShowCompletionPanel(false)}
        onCompleted={() => {
          setShowCompletionPanel(false);
          onSaved();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {nonCompletionTransitions.map((status) => (
          <Button key={status} type="button" variant="outline" size="sm" disabled={statusPending} onClick={() => transition(status)}>
            {STATUS_LABELS_TR[status]}
          </Button>
        ))}
        {canComplete && (
          <Button type="button" variant="outline" size="sm" disabled={completePending} onClick={handleCompleteClick}>
            {completePending ? "Kaydediliyor…" : STATUS_LABELS_TR.completed}
          </Button>
        )}
        {canCancelNow && (
          <Button type="button" variant="destructive" size="sm" disabled={statusPending} onClick={() => transition("cancelled")}>
            <X />
            İptal et
          </Button>
        )}
      </div>
      {statusState && !statusState.success && (
        <p className="text-destructive text-sm" role="alert">
          {statusState.error.message}
        </p>
      )}
      {completeState && !completeState.success && (
        <p className="text-destructive text-sm" role="alert">
          {completeState.error.message}
        </p>
      )}
    </div>
  );
}

/**
 * Faz 5A.2 — shown only for a multi-staff salon (see isSoloSalon above).
 * One row per service item: booked staff for reference, an actual-
 * performer selector defaulted to that same booked staff so the owner
 * only ever touches a dropdown when reality genuinely differed from the
 * booking. Candidates come from the same eligibility rule booking
 * already uses (fetchEligibleStaff — active, this branch, this service):
 * the smallest rule that reflects who could plausibly have performed
 * this exact service here, without inventing a second staff-query
 * concept. The booked staff is always included even if no longer
 * eligible (inactive, or since unassigned from this service/branch) —
 * the default selection must never be missing from its own list.
 */
function CompletionPanel({
  appointmentId,
  tenantSlug,
  branchId,
  items,
  onCancel,
  onCompleted,
}: {
  appointmentId: string;
  tenantSlug: string;
  branchId: string;
  items: AppointmentDetail["items"];
  onCancel: () => void;
  onCompleted: () => void;
}) {
  const [performerByItem, setPerformerByItem] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((item) => [item.id, item.staffMember.id])),
  );
  const [candidatesByItem, setCandidatesByItem] = useState<Record<string, StaffOption[]>>({});

  useEffect(() => {
    let active = true;
    Promise.all(
      items.map(async (item) => {
        const eligible = await fetchEligibleStaff(item.service.id, branchId);
        const candidates = eligible.some((s) => s.id === item.staffMember.id)
          ? eligible
          : [...eligible, { id: item.staffMember.id, fullName: item.staffMember.fullName }];
        return [item.id, candidates] as const;
      }),
    ).then((entries) => {
      if (active) setCandidatesByItem(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [items, branchId]);

  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: CompleteAppointmentInput) => {
      const result = await completeAppointmentAction(prevState, input);
      if (result.success) onCompleted();
      return result;
    },
    null,
  );

  function handleConfirm() {
    startTransition(() =>
      action({
        tenantSlug,
        appointmentId,
        performerOverrides: items.map((item) => ({
          appointmentItemId: item.id,
          actualStaffMemberId: performerByItem[item.id] ?? item.staffMember.id,
        })),
      }),
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <p className="text-sm font-medium">İşlemi Tamamla</p>
      <div className="flex flex-col gap-3">
        {items.map((item) => {
          const candidates = candidatesByItem[item.id] ?? [{ id: item.staffMember.id, fullName: item.staffMember.fullName }];
          const selected = performerByItem[item.id] ?? item.staffMember.id;
          return (
            <div key={item.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{item.service.name}</span>
                <span className="text-muted-foreground text-xs">Randevu Personeli: {item.staffMember.fullName}</span>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Gerçek Uygulayan</Label>
                <Select
                  key={selected}
                  value={selected}
                  onValueChange={(v) => setPerformerByItem((prev) => ({ ...prev, [item.id]: v as string }))}
                  disabled={isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>{(value: string | null) => candidates.find((c) => c.id === value)?.fullName ?? item.staffMember.fullName}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.fullName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </div>

      {state && !state.success && (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={isPending} onClick={handleConfirm}>
          {isPending ? "Kaydediliyor…" : "İşlemi Tamamla"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={onCancel}>
          Vazgeç
        </Button>
      </div>
    </div>
  );
}

function RescheduleForm({
  tenantId,
  tenantSlug,
  tenantTimezone,
  detail,
  onSaved,
}: {
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  detail: AppointmentDetail;
  onSaved: () => void;
}) {
  const firstItemLocal = utcIsoToTenantLocalParts(detail.items[0]!.scheduledStartAt, tenantTimezone);
  const [date, setDate] = useState(firstItemLocal.date);
  const [items, setItems] = useState<ItemDraft[]>(() =>
    detail.items.map((item) => {
      const local = utcIsoToTenantLocalParts(item.scheduledStartAt, tenantTimezone);
      return { key: item.id, serviceId: item.service.id, staffMemberId: item.staffMember.id, startTime: local.time };
    }),
  );
  const [services, setServices] = useState<ServiceForBranch[]>([]);

  useEffect(() => {
    fetchServicesForBranch(tenantId, detail.branch.id).then(setServices);
  }, [tenantId, detail.branch.id]);

  const [state, formAction, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: RescheduleAppointmentInput) => {
      const result = await rescheduleAppointmentAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );

  const itemsValid = items.every((i) => i.serviceId && i.staffMemberId && i.startTime);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemsValid) return;
    const input: RescheduleAppointmentInput = {
      tenantSlug,
      appointmentId: detail.id,
      items: items.map((item, index) => ({
        serviceId: item.serviceId,
        staffMemberId: item.staffMemberId,
        scheduledStartAt: tenantLocalToUtcIso(date, item.startTime, tenantTimezone),
        sequence: index + 1,
      })),
    };
    startTransition(() => formAction(input));
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reschedule-date">Tarih</Label>
        <Input id="reschedule-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <AppointmentItemsEditor
        tenantId={tenantId}
        branchId={detail.branch.id}
        tenantTimezone={tenantTimezone}
        date={date}
        items={items}
        services={services}
        excludeAppointmentId={detail.id}
        onItemsChange={setItems}
      />

      {state && !state.success && (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      )}

      <SheetFooter className="px-0">
        <Button type="submit" disabled={!itemsValid || isPending}>
          {isPending ? "Kaydediliyor…" : "Yeniden planla"}
        </Button>
      </SheetFooter>
    </form>
  );
}
