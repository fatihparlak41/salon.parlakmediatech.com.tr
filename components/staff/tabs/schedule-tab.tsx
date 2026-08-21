"use client";

import { startTransition, useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ActionResult } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BranchOption, ScheduleRow, ExceptionRow } from "@/lib/modules/staff/queries";
import {
  updateStaffScheduleAction,
  createStaffExceptionAction,
  deleteStaffExceptionAction,
  type UpdateStaffScheduleInput,
  type CreateStaffExceptionInput,
} from "@/lib/modules/staff/actions";

const WEEKDAY_LABELS: Record<number, string> = {
  0: "Pazar",
  1: "Pazartesi",
  2: "Salı",
  3: "Çarşamba",
  4: "Perşembe",
  5: "Cuma",
  6: "Cumartesi",
};
// Postgres EXTRACT(DOW): 0=Sunday..6=Saturday — this only reorders how
// rows are DISPLAYED (Monday-first, the familiar Turkish week), each
// row's own weekday value is untouched.
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

type DayState = { enabled: boolean; startTime: string; endTime: string; branchId: string | null };

function buildInitialDayState(rows: ScheduleRow[]): Record<number, DayState> {
  const state: Record<number, DayState> = {};
  for (let w = 0; w <= 6; w++) {
    const existing = rows.find((r) => r.weekday === w);
    state[w] = existing
      ? { enabled: true, startTime: existing.startTime, endTime: existing.endTime, branchId: existing.branchId }
      : { enabled: false, startTime: "09:00", endTime: "18:00", branchId: null };
  }
  return state;
}

export function ScheduleTab({
  tenantId,
  tenantSlug,
  staffMemberId,
  branches,
  canManage,
  schedule,
  exceptions,
  onScheduleSaved,
  onExceptionsChanged,
}: {
  tenantId: string;
  tenantSlug: string;
  staffMemberId: string;
  branches: BranchOption[];
  canManage: boolean;
  schedule: ScheduleRow[];
  exceptions: ExceptionRow[];
  onScheduleSaved: () => void;
  onExceptionsChanged: () => void;
}) {
  const [days, setDays] = useState<Record<number, DayState>>(() => buildInitialDayState(schedule));
  // Adjusting state during render when a prop changes (not in an effect)
  // is React's own documented pattern for this — it re-renders once more
  // before paint instead of committing stale state and fixing it up a
  // tick later. https://react.dev/learn/you-might-not-need-an-effect
  const [prevSchedule, setPrevSchedule] = useState(schedule);
  if (schedule !== prevSchedule) {
    setPrevSchedule(schedule);
    setDays(buildInitialDayState(schedule));
  }

  const [scheduleState, scheduleAction, scheduleSaving] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateStaffScheduleInput) => {
      const result = await updateStaffScheduleAction(prevState, input);
      if (result.success) onScheduleSaved();
      return result;
    },
    null,
  );

  function saveSchedule() {
    const rows = Object.entries(days)
      .filter(([, d]) => d.enabled)
      .map(([weekday, d]) => ({
        weekday: Number(weekday),
        branchId: branches.length > 1 ? d.branchId : (branches[0]?.id ?? null),
        startTime: d.startTime,
        endTime: d.endTime,
      }));
    startTransition(() => scheduleAction({ tenantSlug, tenantId, staffMemberId, rows }));
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h3 className="text-sm font-medium">Haftalık çalışma programı</h3>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Salon saat dilimine göre girin.
        </p>
        <div className="mt-3 flex flex-col divide-y divide-border rounded-lg border">
          {DISPLAY_ORDER.map((weekday) => {
            const day = days[weekday]!;
            return (
              <div key={weekday} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <label className="flex w-32 shrink-0 items-center gap-2 text-sm font-medium">
                  <Checkbox
                    disabled={!canManage}
                    checked={day.enabled}
                    onCheckedChange={(checked) =>
                      setDays((prev) => ({ ...prev, [weekday]: { ...prev[weekday]!, enabled: !!checked } }))
                    }
                  />
                  {WEEKDAY_LABELS[weekday]}
                </label>
                {day.enabled ? (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <Input
                      type="time"
                      disabled={!canManage}
                      value={day.startTime}
                      onChange={(e) =>
                        setDays((prev) => ({
                          ...prev,
                          [weekday]: { ...prev[weekday]!, startTime: e.target.value },
                        }))
                      }
                      className="w-28"
                    />
                    <span className="text-muted-foreground text-sm">—</span>
                    <Input
                      type="time"
                      disabled={!canManage}
                      value={day.endTime}
                      onChange={(e) =>
                        setDays((prev) => ({
                          ...prev,
                          [weekday]: { ...prev[weekday]!, endTime: e.target.value },
                        }))
                      }
                      className="w-28"
                    />
                    {branches.length > 1 && (
                      <Select
                        disabled={!canManage}
                        value={day.branchId ?? "any"}
                        onValueChange={(v) =>
                          setDays((prev) => ({
                            ...prev,
                            [weekday]: { ...prev[weekday]!, branchId: v === "any" ? null : (v as string) },
                          }))
                        }
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">Her şube</SelectItem>
                          {branches.map((b) => (
                            <SelectItem key={b.id} value={b.id}>
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-sm">Çalışmıyor</span>
                )}
              </div>
            );
          })}
        </div>
        {canManage && (
          <>
            <Button onClick={saveSchedule} disabled={scheduleSaving} className="mt-3">
              {scheduleSaving ? "Kaydediliyor…" : "Programı kaydet"}
            </Button>
            {scheduleState && !scheduleState.success && (
              <p className="text-destructive mt-2 text-sm" role="alert">
                {scheduleState.error.message}
              </p>
            )}
          </>
        )}
      </div>

      <ExceptionsSection
        tenantId={tenantId}
        tenantSlug={tenantSlug}
        staffMemberId={staffMemberId}
        canManage={canManage}
        exceptions={exceptions}
        onChanged={onExceptionsChanged}
      />
    </div>
  );
}

function ExceptionsSection({
  tenantId,
  tenantSlug,
  staffMemberId,
  canManage,
  exceptions,
  onChanged,
}: {
  tenantId: string;
  tenantSlug: string;
  staffMemberId: string;
  canManage: boolean;
  exceptions: ExceptionRow[];
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState("");
  const [type, setType] = useState<"unavailable" | "custom_hours">("unavailable");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [reason, setReason] = useState("");

  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: CreateStaffExceptionInput) => {
      const result = await createStaffExceptionAction(prevState, input);
      if (result.success) {
        onChanged();
        setShowForm(false);
        setDate("");
        setReason("");
      }
      return result;
    },
    null,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(() =>
      action({
        tenantSlug,
        tenantId,
        staffMemberId,
        exceptionDate: date,
        type,
        startTime: type === "custom_hours" ? startTime : undefined,
        endTime: type === "custom_hours" ? endTime : undefined,
        reason,
      }),
    );
  }

  async function handleDelete(exceptionId: string) {
    await deleteStaffExceptionAction(tenantSlug, exceptionId);
    onChanged();
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">İzin / özel gün</h3>
        {canManage && !showForm && (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            <Plus />
            Ekle
          </Button>
        )}
      </div>

      {exceptions.length === 0 && !showForm && (
        <p className="text-muted-foreground mt-2 text-sm">Tanımlı istisna yok.</p>
      )}

      {exceptions.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {exceptions.map((ex) => (
            <li
              key={ex.id}
              className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium">
                  {new Date(ex.exceptionDate + "T00:00:00").toLocaleDateString("tr-TR")}
                </span>
                <Badge variant={ex.type === "unavailable" ? "destructive" : "secondary"}>
                  {ex.type === "unavailable" ? "İzinli" : `${ex.startTime}–${ex.endTime}`}
                </Badge>
                {ex.reason && <span className="text-muted-foreground truncate">{ex.reason}</span>}
              </div>
              {canManage && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleDelete(ex.id)}
                  aria-label="Sil"
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="exception-date">Tarih</Label>
              <Input
                id="exception-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Tür</Label>
              <Select value={type} onValueChange={(v) => setType(v as "unavailable" | "custom_hours")}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unavailable">Tam gün izinli</SelectItem>
                  <SelectItem value="custom_hours">Özel saatler</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {type === "custom_hours" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exception-start">Başlangıç</Label>
                  <Input
                    id="exception-start"
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-28"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exception-end">Bitiş</Label>
                  <Input
                    id="exception-end"
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-28"
                  />
                </div>
              </>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exception-reason">Not (opsiyonel)</Label>
            <Textarea
              id="exception-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
          {state && !state.success && (
            <p className="text-destructive text-sm" role="alert">
              {state.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
              Vazgeç
            </Button>
            <Button type="submit" disabled={isPending || !date}>
              {isPending ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
