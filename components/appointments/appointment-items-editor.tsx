"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ServiceForBranch } from "@/lib/modules/appointments/queries";
import { fetchEligibleStaff, type StaffOption } from "@/lib/modules/appointments/client-queries";
import { tenantLocalToUtcIso } from "@/lib/modules/appointments/timezone";
import { mapAppointmentErrorCode } from "@/lib/modules/appointments/error-codes";

export type ItemDraft = {
  key: string;
  serviceId: string;
  staffMemberId: string;
  startTime: string; // "HH:MM", tenant-local
};

type Availability = { status: "idle" | "checking" | "available" | "unavailable"; message?: string };

async function checkAvailability(
  tenantId: string,
  branchId: string,
  staffMemberId: string,
  serviceId: string,
  scheduledStartAtIso: string,
  excludeAppointmentId?: string,
): Promise<Availability> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("check_appointment_availability", {
    p_tenant_id: tenantId,
    p_branch_id: branchId,
    p_staff_member_id: staffMemberId,
    p_service_id: serviceId,
    p_scheduled_start_at: scheduledStartAtIso,
    p_exclude_appointment_id: excludeAppointmentId,
  });
  if (error) return { status: "unavailable", message: mapAppointmentErrorCode(error.code) };
  const row = data?.[0];
  if (!row) return { status: "idle" };
  if (row.is_available) return { status: "available" };
  return { status: "unavailable", message: mapAppointmentErrorCode(row.reason ?? undefined) };
}

function ItemRow({
  item,
  index,
  tenantId,
  branchId,
  tenantTimezone,
  date,
  services,
  canRemove,
  excludeAppointmentId,
  preferredStaffMemberId,
  onChange,
  onRemove,
}: {
  item: ItemDraft;
  index: number;
  tenantId: string;
  branchId: string;
  tenantTimezone: string;
  date: string;
  services: ServiceForBranch[];
  canRemove: boolean;
  excludeAppointmentId?: string;
  preferredStaffMemberId?: string;
  onChange: (next: ItemDraft) => void;
  onRemove: () => void;
}) {
  const [staffOptionsRaw, setStaffOptionsRaw] = useState<StaffOption[]>([]);
  const [loadingStaff, setLoadingStaff] = useState(false);
  const [availabilityRaw, setAvailabilityRaw] = useState<Availability>({ status: "idle" });

  const selectedService = services.find((s) => s.id === item.serviceId);

  // Guard conditions are re-derived at render time rather than reset via
  // a synchronous setState at the top of the effect (react-hooks/set-state-in-effect)
  // — staffOptions/availability just fall back to empty/idle whenever the
  // inputs are incomplete, no separate "clear" branch needed.
  const staffOptions = item.serviceId && branchId ? staffOptionsRaw : [];
  const inputsCompleteForAvailability = Boolean(
    item.serviceId && item.staffMemberId && branchId && date && item.startTime,
  );
  const availability = inputsCompleteForAvailability ? availabilityRaw : { status: "idle" as const };

  useEffect(() => {
    if (!item.serviceId || !branchId) return;
    // setLoadingStaff(true) deferred into the timeout (0ms, no intended
    // debounce) rather than called synchronously in the effect body —
    // same react-hooks/set-state-in-effect fix as the debounced fetches
    // elsewhere in this module and in customers-page-client.tsx.
    const handle = setTimeout(() => {
      setLoadingStaff(true);
      fetchEligibleStaff(item.serviceId, branchId).then((options) => {
        setStaffOptionsRaw(options);
        setLoadingStaff(false);
      });
    }, 0);
    return () => clearTimeout(handle);
  }, [item.serviceId, branchId]);

  // Quick-create-from-calendar: once the newly-selected service's
  // eligible-staff list resolves, silently apply the clicked/preferred
  // staff member IF they're actually eligible for it — never force an
  // ineligible pairing. Guarded on !item.staffMemberId so this only ever
  // fills an empty slot (e.g. right after a service change resets it to
  // ""), never overrides an operator's own later choice.
  useEffect(() => {
    if (!preferredStaffMemberId || item.staffMemberId) return;
    if (!staffOptionsRaw.some((s) => s.id === preferredStaffMemberId)) return;
    onChange({ ...item, staffMemberId: preferredStaffMemberId });
  }, [staffOptionsRaw, preferredStaffMemberId, item, onChange]);

  useEffect(() => {
    if (!inputsCompleteForAvailability) return;
    const handle = setTimeout(async () => {
      setAvailabilityRaw({ status: "checking" });
      const startIso = tenantLocalToUtcIso(date, item.startTime, tenantTimezone);
      const result = await checkAvailability(
        tenantId,
        branchId,
        item.staffMemberId,
        item.serviceId,
        startIso,
        excludeAppointmentId,
      );
      setAvailabilityRaw(result);
    }, 350);
    return () => clearTimeout(handle);
  }, [
    inputsCompleteForAvailability,
    item.serviceId,
    item.staffMemberId,
    item.startTime,
    branchId,
    date,
    tenantId,
    tenantTimezone,
    excludeAppointmentId,
  ]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium">Hizmet {index + 1}</span>
        {canRemove && (
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Kaldır">
            <Trash2 />
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Hizmet</Label>
        <Select value={item.serviceId || undefined} onValueChange={(v) => onChange({ ...item, serviceId: v as string, staffMemberId: "" })}>
          <SelectTrigger className="w-full">
            {/* Base UI's Select.Value shows the raw value string unless
                given an explicit label-lookup render function. */}
            <SelectValue placeholder="Hizmet seçin">
              {(value: string | null) => {
                const service = services.find((s) => s.id === value);
                return service ? `${service.name} — ${service.durationMinutes} dk` : "Hizmet seçin";
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {services.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name} — {s.durationMinutes} dk
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Personel</Label>
          <Select
            // Keyed on the value itself: Base UI's Select does not
            // reliably resync its internal selected-item tracking when
            // `value` changes purely from an external programmatic
            // onChange (as opposed to the Select's own interaction) —
            // confirmed directly in the browser, the preferred-staff
            // auto-apply below correctly updated item.staffMemberId in
            // React state, but the Select kept showing the placeholder
            // and no option as selected until forced to remount. Keying
            // it this way makes every value change (auto-applied or
            // manual) start the Select fresh with the correct value.
            key={item.staffMemberId || "none"}
            value={item.staffMemberId || undefined}
            onValueChange={(v) => onChange({ ...item, staffMemberId: v as string })}
            disabled={!item.serviceId || loadingStaff}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={loadingStaff ? "Yükleniyor…" : "Personel seçin"}>
                {(value: string | null) => staffOptions.find((s) => s.id === value)?.fullName ?? (loadingStaff ? "Yükleniyor…" : "Personel seçin")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {staffOptions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {item.serviceId && !loadingStaff && staffOptions.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Bu şubede bu hizmeti verebilecek personel yok.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Başlangıç saati</Label>
          <Input type="time" value={item.startTime} onChange={(e) => onChange({ ...item, startTime: e.target.value })} />
        </div>
      </div>

      {selectedService && item.startTime && (
        <p className="text-muted-foreground text-xs">
          Süre: {selectedService.durationMinutes} dk · Fiyat: ₺{selectedService.price}
        </p>
      )}

      {availability.status !== "idle" && (
        <div className="flex items-center gap-1.5 text-xs">
          {availability.status === "checking" && (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <span className="text-muted-foreground">Müsaitlik kontrol ediliyor…</span>
            </>
          )}
          {availability.status === "available" && (
            <>
              <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-500" />
              <span className="text-emerald-600 dark:text-emerald-500">Müsait</span>
            </>
          )}
          {availability.status === "unavailable" && (
            <>
              <XCircle className="size-3.5 text-destructive" />
              <span className="text-destructive">{availability.message}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AppointmentItemsEditor({
  tenantId,
  branchId,
  tenantTimezone,
  date,
  items,
  services,
  excludeAppointmentId,
  preferredStaffMemberId,
  onItemsChange,
}: {
  tenantId: string;
  branchId: string;
  tenantTimezone: string;
  date: string;
  items: ItemDraft[];
  services: ServiceForBranch[];
  /** When set (a reschedule of an existing appointment), the availability
   * preview ignores that appointment's own current items — otherwise
   * every reschedule preview would flag a self-conflict against the
   * slot it already occupies. Never passed when creating a new
   * appointment. */
  excludeAppointmentId?: string;
  /** Quick-create-from-calendar: the clicked staff member, applied only
   * to the first item and only once it's confirmed eligible for
   * whichever service the operator ends up selecting. */
  preferredStaffMemberId?: string;
  onItemsChange: (items: ItemDraft[]) => void;
}) {
  function updateItem(index: number, next: ItemDraft) {
    const copy = [...items];
    copy[index] = next;
    onItemsChange(copy);
  }

  function removeItem(index: number) {
    onItemsChange(items.filter((_, i) => i !== index));
  }

  function addItem() {
    // Default the next item's start to the previous item's computed end
    // (start + selected service duration) — operationally the common
    // case; the operator can still change it per item.
    const last = items[items.length - 1];
    let nextStart = "";
    if (last) {
      const lastService = services.find((s) => s.id === last.serviceId);
      if (lastService && last.startTime) {
        const [h, m] = last.startTime.split(":").map(Number);
        const totalMinutes = h! * 60 + m! + lastService.durationMinutes;
        const nh = Math.floor(totalMinutes / 60) % 24;
        const nm = totalMinutes % 60;
        nextStart = `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
      }
    }
    onItemsChange([
      ...items,
      { key: crypto.randomUUID(), serviceId: "", staffMemberId: "", startTime: nextStart || last?.startTime || "" },
    ]);
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item, index) => (
        <ItemRow
          key={item.key}
          item={item}
          index={index}
          tenantId={tenantId}
          branchId={branchId}
          tenantTimezone={tenantTimezone}
          date={date}
          services={services}
          canRemove={items.length > 1}
          excludeAppointmentId={excludeAppointmentId}
          preferredStaffMemberId={index === 0 ? preferredStaffMemberId : undefined}
          onChange={(next) => updateItem(index, next)}
          onRemove={() => removeItem(index)}
        />
      ))}
      <Button type="button" variant="outline" onClick={addItem} disabled={!branchId} className="self-start">
        <Plus />
        Hizmet ekle
      </Button>
    </div>
  );
}
