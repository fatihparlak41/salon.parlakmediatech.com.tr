"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { ActionResult } from "@/lib/errors";
import { createClient } from "@/lib/supabase/client";
import type {
  BranchOption,
  ServiceOption,
  MembershipOption,
  StaffDetail,
  ScheduleRow,
  ExceptionRow,
} from "@/lib/modules/staff/queries";
import {
  updateStaffProfileAction,
  updateStaffStatusAction,
  updateStaffBranchesAction,
  updateStaffServicesAction,
  type UpdateStaffProfileInput,
  type UpdateStaffStatusInput,
  type UpdateStaffBranchesInput,
  type UpdateStaffServicesInput,
} from "@/lib/modules/staff/actions";
import { ScheduleTab } from "@/components/staff/tabs/schedule-tab";

type Loaded = {
  detail: StaffDetail;
  schedule: ScheduleRow[];
  exceptions: ExceptionRow[];
};

async function loadStaffData(staffMemberId: string): Promise<Loaded | null> {
  const supabase = createClient();

  const [detailRes, scheduleRes, exceptionsRes] = await Promise.all([
    supabase
      .from("staff_members")
      .select(
        `id, full_name, email, phone, status, tenant_membership_id, concurrent_capacity,
         staff_branches(branch_id), staff_services(service_id)`,
      )
      .eq("id", staffMemberId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("staff_schedules")
      .select("id, weekday, branch_id, start_time, end_time")
      .eq("staff_member_id", staffMemberId)
      .is("deleted_at", null),
    supabase
      .from("staff_schedule_exceptions")
      .select("id, exception_date, type, start_time, end_time, reason")
      .eq("staff_member_id", staffMemberId)
      .is("deleted_at", null)
      .order("exception_date", { ascending: true }),
  ]);

  if (!detailRes.data) return null;

  const d = detailRes.data;
  return {
    detail: {
      id: d.id,
      fullName: d.full_name,
      email: d.email,
      phone: d.phone,
      status: d.status,
      tenantMembershipId: d.tenant_membership_id,
      branchIds: d.staff_branches.map((b) => b.branch_id),
      serviceIds: d.staff_services.map((s) => s.service_id),
      concurrentCapacity: d.concurrent_capacity,
    },
    schedule: (scheduleRes.data ?? []).map((r) => ({
      id: r.id,
      weekday: r.weekday,
      branchId: r.branch_id,
      startTime: r.start_time.slice(0, 5),
      endTime: r.end_time.slice(0, 5),
    })),
    exceptions: (exceptionsRes.data ?? []).map((r) => ({
      id: r.id,
      exceptionDate: r.exception_date,
      type: r.type,
      startTime: r.start_time?.slice(0, 5) ?? null,
      endTime: r.end_time?.slice(0, 5) ?? null,
      reason: r.reason,
    })),
  };
}

export function StaffDetailSheet({
  staffMemberId,
  onOpenChange,
  tenantId,
  tenantSlug,
  canManage,
  branches,
  services,
  memberships,
}: {
  staffMemberId: string | null;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  canManage: boolean;
  branches: BranchOption[];
  services: ServiceOption[];
  memberships: MembershipOption[];
}) {
  return (
    <Sheet open={staffMemberId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {/* Keyed on staffMemberId: switching (or opening/closing) staff
            members should start every tab's local state completely fresh,
            not carry over from whoever was open before — a full remount
            is the correct tool here, not an effect that resets state. */}
        {staffMemberId && (
          <StaffDetailSheetBody
            key={staffMemberId}
            staffMemberId={staffMemberId}
            tenantId={tenantId}
            tenantSlug={tenantSlug}
            canManage={canManage}
            branches={branches}
            services={services}
            memberships={memberships}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function StaffDetailSheetBody({
  staffMemberId,
  tenantId,
  tenantSlug,
  canManage,
  branches,
  services,
  memberships,
}: {
  staffMemberId: string;
  tenantId: string;
  tenantSlug: string;
  canManage: boolean;
  branches: BranchOption[];
  services: ServiceOption[];
  memberships: MembershipOption[];
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setData(await loadStaffData(staffMemberId));
  }

  useEffect(() => {
    loadStaffData(staffMemberId).then((result) => {
      setData(result);
      setLoading(false);
    });
  }, [staffMemberId]);

  if (loading || !data) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{data.detail.fullName}</SheetTitle>
        <SheetDescription>Personel bilgilerini görüntüleyin ve düzenleyin.</SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Tabs defaultValue="profile">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="profile">Profil</TabsTrigger>
            <TabsTrigger value="branches">Şubeler</TabsTrigger>
            <TabsTrigger value="services">Hizmetler</TabsTrigger>
            <TabsTrigger value="schedule">Program</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="pt-4">
            <ProfileTab
              tenantSlug={tenantSlug}
              staffMemberId={data.detail.id}
              detail={data.detail}
              canManage={canManage}
              memberships={memberships}
              onSaved={reload}
            />
          </TabsContent>

          <TabsContent value="branches" className="pt-4">
            <BranchesTab
              tenantSlug={tenantSlug}
              staffMemberId={data.detail.id}
              branches={branches}
              initialBranchIds={data.detail.branchIds}
              canManage={canManage}
              onSaved={reload}
            />
          </TabsContent>

          <TabsContent value="services" className="pt-4">
            <ServicesTab
              tenantSlug={tenantSlug}
              staffMemberId={data.detail.id}
              services={services}
              initialServiceIds={data.detail.serviceIds}
              canManage={canManage}
              onSaved={reload}
            />
          </TabsContent>

          <TabsContent value="schedule" className="pt-4">
            <ScheduleTab
              tenantId={tenantId}
              tenantSlug={tenantSlug}
              staffMemberId={data.detail.id}
              branches={branches}
              canManage={canManage}
              schedule={data.schedule}
              exceptions={data.exceptions}
              onScheduleSaved={reload}
              onExceptionsChanged={reload}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function ProfileTab({
  tenantSlug,
  staffMemberId,
  detail,
  canManage,
  memberships,
  onSaved,
}: {
  tenantSlug: string;
  staffMemberId: string;
  detail: StaffDetail;
  canManage: boolean;
  memberships: MembershipOption[];
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(detail.fullName);
  const [email, setEmail] = useState(detail.email ?? "");
  const [phone, setPhone] = useState(detail.phone ?? "");
  const [membershipId, setMembershipId] = useState(detail.tenantMembershipId ?? "");
  const [concurrentCapacity, setConcurrentCapacity] = useState(String(detail.concurrentCapacity));

  // Success handling (notifying the parent to reload) happens inside the
  // action itself, not a useEffect watching the result afterward.
  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateStaffProfileInput) => {
      const result = await updateStaffProfileAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );
  const [statusState, statusAction, statusPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateStaffStatusInput) => {
      const result = await updateStaffStatusAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">Durum</p>
          <p className="text-muted-foreground text-xs">
            Pasif personel yeni randevu için önerilmez, geçmiş kayıtları etkilenmez.
          </p>
        </div>
        <Badge variant={detail.status === "active" ? "default" : "secondary"}>
          {detail.status === "active" ? "Aktif" : "Pasif"}
        </Badge>
      </div>
      {canManage && (
        <Button
          variant="outline"
          size="sm"
          disabled={statusPending}
          onClick={() =>
            startTransition(() =>
              statusAction({
                tenantSlug,
                staffMemberId,
                status: detail.status === "active" ? "inactive" : "active",
              }),
            )
          }
        >
          {detail.status === "active" ? "Pasife al" : "Aktifleştir"}
        </Button>
      )}
      {statusState && !statusState.success && (
        <p className="text-destructive text-sm" role="alert">
          {statusState.error.message}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-full-name">Ad soyad</Label>
        <Input
          id="edit-full-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          disabled={!canManage}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-email">E-posta</Label>
          <Input
            id="edit-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!canManage}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-phone">Telefon</Label>
          <Input
            id="edit-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={!canManage}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-concurrent-capacity">Aynı anda bakabileceği müşteri sayısı</Label>
        <Input
          id="edit-concurrent-capacity"
          type="number"
          min={1}
          max={20}
          value={concurrentCapacity}
          onChange={(e) => setConcurrentCapacity(e.target.value)}
          disabled={!canManage}
          className="w-24"
        />
        <p className="text-muted-foreground text-xs">
          Çoğu personel için 1 yeterlidir. Bu personel aynı anda birden fazla müşteriyle
          ilgilenebiliyorsa (örn. boya sürerken başka bir müşteriyi de alabiliyorsa) artırın.
        </p>
      </div>

      {(memberships.length > 0 || detail.tenantMembershipId) && (
        <div className="flex flex-col gap-1.5">
          <Label>Giriş erişimi</Label>
          <Select
            value={membershipId || "none"}
            onValueChange={(v) => setMembershipId(v === "none" ? "" : (v as string))}
            disabled={!canManage}
          >
            <SelectTrigger className="w-full">
              {/* Base UI's Select.Value shows the raw stored value unless
                  given an explicit label-lookup render function. */}
              <SelectValue placeholder="Bağlantı yok">
                {(value: string) => {
                  const membership = memberships.find((m) => m.id === value);
                  return membership ? `${membership.displayName} — ${membership.roleName}` : "Bağlantı yok";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Bağlantı yok</SelectItem>
              {memberships.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.displayName} — {m.roleName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {state && !state.success && (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      )}

      {canManage && (
        <Button
          onClick={() =>
            startTransition(() =>
              action({
                tenantSlug,
                staffMemberId,
                fullName,
                email,
                phone,
                tenantMembershipId: membershipId,
                concurrentCapacity: Number(concurrentCapacity) || 1,
              }),
            )
          }
          disabled={isPending || !fullName.trim()}
          className="self-start"
        >
          {isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      )}
    </div>
  );
}

function BranchesTab({
  tenantSlug,
  staffMemberId,
  branches,
  initialBranchIds,
  canManage,
  onSaved,
}: {
  tenantSlug: string;
  staffMemberId: string;
  branches: BranchOption[];
  initialBranchIds: string[];
  canManage: boolean;
  onSaved: () => void;
}) {
  const [branchIds, setBranchIds] = useState(initialBranchIds);
  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateStaffBranchesInput) => {
      const result = await updateStaffBranchesAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );

  function toggle(id: string) {
    setBranchIds((prev) => (prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]));
  }

  return (
    <div className="flex flex-col gap-3">
      {branches.map((branch) => (
        <label key={branch.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={branchIds.includes(branch.id)}
            onCheckedChange={() => toggle(branch.id)}
            disabled={!canManage}
          />
          {branch.name}
          {branch.isPrimary && (
            <Badge variant="outline" className="ml-auto">
              Ana şube
            </Badge>
          )}
        </label>
      ))}
      {branchIds.length === 0 && (
        <p className="text-sm text-amber-600 dark:text-amber-500">
          Hiçbir şube seçili değil — bu personel hiçbir yerde randevu için görünmeyecek.
        </p>
      )}
      {state && !state.success && (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      )}
      {canManage && (
        <Button
          onClick={() => startTransition(() => action({ tenantSlug, staffMemberId, branchIds }))}
          disabled={isPending}
          className="mt-2 self-start"
        >
          {isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      )}
    </div>
  );
}

function ServicesTab({
  tenantSlug,
  staffMemberId,
  services,
  initialServiceIds,
  canManage,
  onSaved,
}: {
  tenantSlug: string;
  staffMemberId: string;
  services: ServiceOption[];
  initialServiceIds: string[];
  canManage: boolean;
  onSaved: () => void;
}) {
  const [serviceIds, setServiceIds] = useState(initialServiceIds);
  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateStaffServicesInput) => {
      const result = await updateStaffServicesAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );

  function toggle(id: string) {
    setServiceIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  if (services.length === 0) {
    return <p className="text-muted-foreground text-sm">Henüz hizmet tanımlanmadı.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {services.map((service) => (
        <label key={service.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={serviceIds.includes(service.id)}
            onCheckedChange={() => toggle(service.id)}
            disabled={!canManage}
          />
          {service.name}
          {service.status === "inactive" && (
            <Badge variant="secondary" className="ml-auto">
              Pasif
            </Badge>
          )}
        </label>
      ))}
      {state && !state.success && (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      )}
      {canManage && (
        <Button
          onClick={() => startTransition(() => action({ tenantSlug, staffMemberId, serviceIds }))}
          disabled={isPending}
          className="mt-2 self-start"
        >
          {isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      )}
    </div>
  );
}
