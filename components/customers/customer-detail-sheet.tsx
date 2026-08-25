"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import type { ActionResult } from "@/lib/errors";
import type { CustomerRow } from "@/lib/modules/customers/queries";
import {
  updateCustomerProfileAction,
  updateCustomerStatusAction,
  type UpdateCustomerProfileInput,
  type UpdateCustomerStatusInput,
} from "@/lib/modules/customers/actions";
import { AccountLinkSection } from "@/components/customers/account-link-section";

async function loadCustomer(customerId: string): Promise<CustomerRow | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("customers")
    .select("id, full_name, phone, email, notes, status, created_at")
    .eq("id", customerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    fullName: data.full_name,
    phone: data.phone,
    email: data.email,
    notes: data.notes,
    status: data.status,
    createdAt: data.created_at,
  };
}

export function CustomerDetailSheet({
  customerId,
  onOpenChange,
  tenantSlug,
  canManage,
  canLinkAccount,
  onSaved,
}: {
  customerId: string | null;
  onOpenChange: (open: boolean) => void;
  tenantSlug: string;
  canManage: boolean;
  canLinkAccount: boolean;
  onSaved: () => void;
}) {
  return (
    <Sheet open={customerId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {/* Keyed on customerId — see the identical reasoning in
            staff-detail-sheet.tsx / service-detail-sheet.tsx: a full
            remount is the correct way to reset local state when the
            selected customer changes. */}
        {customerId && (
          <CustomerDetailSheetBody
            key={customerId}
            customerId={customerId}
            tenantSlug={tenantSlug}
            canManage={canManage}
            canLinkAccount={canLinkAccount}
            onSaved={onSaved}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CustomerDetailSheetBody({
  customerId,
  tenantSlug,
  canManage,
  canLinkAccount,
  onSaved,
}: {
  customerId: string;
  tenantSlug: string;
  canManage: boolean;
  canLinkAccount: boolean;
  onSaved: () => void;
}) {
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setCustomer(await loadCustomer(customerId));
    onSaved();
  }

  useEffect(() => {
    loadCustomer(customerId).then((result) => {
      setCustomer(result);
      setLoading(false);
    });
  }, [customerId]);

  if (loading || !customer) {
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
        <SheetTitle>{customer.fullName}</SheetTitle>
        <SheetDescription>Müşteri bilgilerini görüntüleyin ve düzenleyin.</SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Tabs defaultValue="profile">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="profile">Profil</TabsTrigger>
            <TabsTrigger value="appointments">Randevular</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="pt-4">
            <ProfileTab
              tenantSlug={tenantSlug}
              customer={customer}
              canManage={canManage}
              canLinkAccount={canLinkAccount}
              onSaved={reload}
            />
          </TabsContent>

          <TabsContent value="appointments" className="pt-4">
            <div className="border-border flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
              <CalendarClock className="text-muted-foreground size-6" />
              <p className="text-muted-foreground text-sm">Randevu geçmişi yakında burada görünecek.</p>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function ProfileTab({
  tenantSlug,
  customer,
  canManage,
  canLinkAccount,
  onSaved,
}: {
  tenantSlug: string;
  customer: CustomerRow;
  canManage: boolean;
  canLinkAccount: boolean;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(customer.fullName);
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [email, setEmail] = useState(customer.email ?? "");
  const [notes, setNotes] = useState(customer.notes ?? "");

  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateCustomerProfileInput) => {
      const result = await updateCustomerProfileAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );
  const [statusState, statusAction, statusPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: UpdateCustomerStatusInput) => {
      const result = await updateCustomerStatusAction(prevState, input);
      if (result.success) onSaved();
      return result;
    },
    null,
  );

  return (
    <div className="flex flex-col gap-4">
      <AccountLinkSection tenantSlug={tenantSlug} customerId={customer.id} canManageLink={canLinkAccount} />

      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">Durum</p>
          <p className="text-muted-foreground text-xs">
            Arşivlenmiş müşteri normal listede görünmez, geçmiş kayıtları etkilenmez.
          </p>
        </div>
        <Badge variant={customer.status === "active" ? "default" : "secondary"}>
          {customer.status === "active" ? "Aktif" : "Arşivlenmiş"}
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
                customerId: customer.id,
                status: customer.status === "active" ? "archived" : "active",
              }),
            )
          }
        >
          {customer.status === "active" ? "Arşivle" : "Aktifleştir"}
        </Button>
      )}
      {statusState && !statusState.success && (
        <p className="text-destructive text-sm" role="alert">
          {statusState.error.message}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-customer-full-name">Ad soyad</Label>
        <Input
          id="edit-customer-full-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          disabled={!canManage}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-customer-phone">Telefon</Label>
          <Input id="edit-customer-phone" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!canManage} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-customer-email">E-posta</Label>
          <Input
            id="edit-customer-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!canManage}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-customer-notes">Notlar</Label>
        <Textarea
          id="edit-customer-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={!canManage}
          rows={3}
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
              action({ tenantSlug, customerId: customer.id, fullName, phone, email, notes }),
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
