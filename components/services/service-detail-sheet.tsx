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
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import type { ActionResult } from "@/lib/errors";
import { createClient } from "@/lib/supabase/client";
import type { BranchOption } from "@/lib/modules/staff/queries";
import type { ServiceDetail, StaffOption } from "@/lib/modules/services/queries";
import {
  updateServiceProfileAction,
  updateServiceStatusAction,
  updateServiceBranchesAction,
  updateServiceStaffAction,
  type UpdateServiceProfileInput,
  type UpdateServiceStatusInput,
  type UpdateServiceBranchesInput,
  type UpdateServiceStaffInput,
} from "@/lib/modules/services/actions";

async function loadServiceDetail(serviceId: string): Promise<ServiceDetail | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("services")
    .select(
      `id, name, category, description, duration_minutes, price, status,
       service_branches(branch_id), staff_services(staff_member_id)`,
    )
    .eq("id", serviceId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    category: data.category,
    description: data.description,
    durationMinutes: data.duration_minutes,
    price: String(data.price),
    status: data.status,
    branchIds: data.service_branches.map((b) => b.branch_id),
    staffMemberIds: data.staff_services.map((s) => s.staff_member_id),
  };
}

export function ServiceDetailSheet({
  serviceId,
  onOpenChange,
  tenantSlug,
  canManage,
  canManageStaffEligibility,
  branches,
  staffOptions,
  existingCategories,
}: {
  serviceId: string | null;
  onOpenChange: (open: boolean) => void;
  tenantSlug: string;
  canManage: boolean;
  canManageStaffEligibility: boolean;
  branches: BranchOption[];
  staffOptions: StaffOption[];
  existingCategories: string[];
}) {
  return (
    <Sheet open={serviceId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {/* Keyed on serviceId — see the identical comment in
            staff-detail-sheet.tsx: a full remount is the correct way to
            reset every tab's local state when the selected service
            changes, not an effect. */}
        {serviceId && (
          <ServiceDetailSheetBody
            key={serviceId}
            serviceId={serviceId}
            tenantSlug={tenantSlug}
            canManage={canManage}
            canManageStaffEligibility={canManageStaffEligibility}
            branches={branches}
            staffOptions={staffOptions}
            existingCategories={existingCategories}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ServiceDetailSheetBody({
  serviceId,
  tenantSlug,
  canManage,
  canManageStaffEligibility,
  branches,
  staffOptions,
  existingCategories,
}: {
  serviceId: string;
  tenantSlug: string;
  canManage: boolean;
  canManageStaffEligibility: boolean;
  branches: BranchOption[];
  staffOptions: StaffOption[];
  existingCategories: string[];
}) {
  const [detail, setDetail] = useState<ServiceDetail | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setDetail(await loadServiceDetail(serviceId));
  }

  useEffect(() => {
    loadServiceDetail(serviceId).then((result) => {
      setDetail(result);
      setLoading(false);
    });
  }, [serviceId]);

  if (loading || !detail) {
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
        <SheetTitle>{detail.name}</SheetTitle>
        <SheetDescription>Hizmet bilgilerini görüntüleyin ve düzenleyin.</SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Tabs defaultValue="profile">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="profile">Profil</TabsTrigger>
            <TabsTrigger value="branches">Şubeler</TabsTrigger>
            <TabsTrigger value="staff">Personel</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="pt-4">
            <ProfileTab
              tenantSlug={tenantSlug}
              detail={detail}
              canManage={canManage}
              existingCategories={existingCategories}
              onSaved={reload}
            />
          </TabsContent>

          <TabsContent value="branches" className="pt-4">
            <BranchesTab
              tenantSlug={tenantSlug}
              serviceId={detail.id}
              branches={branches}
              initialBranchIds={detail.branchIds}
              canManage={canManage}
              onSaved={reload}
            />
          </TabsContent>

          <TabsContent value="staff" className="pt-4">
            <StaffTab
              tenantSlug={tenantSlug}
              serviceId={detail.id}
              staffOptions={staffOptions}
              initialStaffIds={detail.staffMemberIds}
              canManage={canManageStaffEligibility}
              onSaved={reload}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function ProfileTab({
  tenantSlug,
  detail,
  canManage,
  existingCategories,
  onSaved,
}: {
  tenantSlug: string;
  detail: ServiceDetail;
  canManage: boolean;
  existingCategories: string[];
  onSaved: () => void;
}) {
  const [name, setName] = useState(detail.name);
  const [category, setCategory] = useState(detail.category ?? "");
  const [description, setDescription] = useState(detail.description ?? "");
  const [durationMinutes, setDurationMinutes] = useState(String(detail.durationMinutes));
  const [price, setPrice] = useState(detail.price);

  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateServiceProfileInput) => {
      const result = await updateServiceProfileAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );
  const [statusState, statusAction, statusPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateServiceStatusInput) => {
      const result = await updateServiceStatusAction(prevState, input);
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
            Pasif hizmet yeni randevu için önerilmez, geçmiş kayıtları etkilenmez.
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
                serviceId: detail.id,
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
        <Label htmlFor="edit-service-name">Hizmet adı</Label>
        <Input id="edit-service-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-service-category">Kategori</Label>
        <Input
          id="edit-service-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={!canManage}
          list="edit-service-category-options"
        />
        <datalist id="edit-service-category-options">
          {existingCategories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-service-duration">Takvim Süresi (dakika)</Label>
          <Input
            id="edit-service-duration"
            type="number"
            min={1}
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(e.target.value)}
            disabled={!canManage}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-service-price">Fiyat (₺)</Label>
          <Input
            id="edit-service-price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={!canManage}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-service-description">Açıklama</Label>
        <Textarea
          id="edit-service-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!canManage}
          rows={2}
        />
      </div>

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
                serviceId: detail.id,
                name,
                category,
                description,
                durationMinutes: Number(durationMinutes),
                price,
              }),
            )
          }
          disabled={isPending || !name.trim() || !price.trim()}
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
  serviceId,
  branches,
  initialBranchIds,
  canManage,
  onSaved,
}: {
  tenantSlug: string;
  serviceId: string;
  branches: BranchOption[];
  initialBranchIds: string[];
  canManage: boolean;
  onSaved: () => void;
}) {
  const [branchIds, setBranchIds] = useState(initialBranchIds);
  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateServiceBranchesInput) => {
      const result = await updateServiceBranchesAction(prevState, input);
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
          <Checkbox checked={branchIds.includes(branch.id)} onCheckedChange={() => toggle(branch.id)} disabled={!canManage} />
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
          Hiçbir şube seçili değil — bu hizmet hiçbir yerde randevu için sunulamayacak.
        </p>
      )}
      {state && !state.success && (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      )}
      {canManage && (
        <Button onClick={() => startTransition(() => action({ tenantSlug, serviceId, branchIds }))} disabled={isPending} className="mt-2 self-start">
          {isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      )}
    </div>
  );
}

function StaffTab({
  tenantSlug,
  serviceId,
  staffOptions,
  initialStaffIds,
  canManage,
  onSaved,
}: {
  tenantSlug: string;
  serviceId: string;
  staffOptions: StaffOption[];
  initialStaffIds: string[];
  canManage: boolean;
  onSaved: () => void;
}) {
  const [staffIds, setStaffIds] = useState(initialStaffIds);
  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateServiceStaffInput) => {
      const result = await updateServiceStaffAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );

  function toggle(id: string) {
    setStaffIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  if (staffOptions.length === 0) {
    return <p className="text-muted-foreground text-sm">Henüz personel eklenmedi.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">
        Bu hizmeti kimin gerçekleştirebileceğini seçin. Personel.manage yetkisi olanlar bunu
        Personel ekranından da yönetebilir — aynı ilişkiyi düzenler.
      </p>
      {staffOptions.map((staff) => (
        <label key={staff.id} className="flex items-center gap-2 text-sm">
          <Checkbox checked={staffIds.includes(staff.id)} onCheckedChange={() => toggle(staff.id)} disabled={!canManage} />
          {staff.fullName}
          {staff.status === "inactive" && (
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
        <Button onClick={() => startTransition(() => action({ tenantSlug, serviceId, staffMemberIds: staffIds }))} disabled={isPending} className="mt-2 self-start">
          {isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      )}
    </div>
  );
}
