"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { Search, UserPlus, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import type { BranchOption } from "@/lib/modules/staff/queries";
import type { ServiceForBranch } from "@/lib/modules/appointments/queries";
import { fetchServicesForBranch } from "@/lib/modules/appointments/client-queries";
import { createCustomerAction, type CreateCustomerInput } from "@/lib/modules/customers/actions";
import { createAppointmentAction, type CreateAppointmentInput } from "@/lib/modules/appointments/actions";
import { tenantLocalToUtcIso } from "@/lib/modules/appointments/timezone";
import { AppointmentItemsEditor, type ItemDraft } from "@/components/appointments/appointment-items-editor";

type CustomerOption = { id: string; fullName: string; phone: string | null; email: string | null };

async function searchCustomers(tenantId: string, query: string): Promise<CustomerOption[]> {
  const supabase = createClient();
  const { data } = await supabase.rpc("search_customers", {
    p_tenant_id: tenantId,
    p_query: query,
    p_status: "active",
    p_limit: 8,
    p_offset: 0,
  });
  return (data ?? []).map((r) => ({ id: r.id, fullName: r.full_name, phone: r.phone, email: r.email }));
}

function todayLocalDate(tenantTimezone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: tenantTimezone, year: "numeric", month: "2-digit", day: "2-digit" });
  return dtf.format(new Date());
}

function CustomerPicker({
  tenantId,
  tenantSlug,
  selected,
  onSelect,
}: {
  tenantId: string;
  tenantSlug: string;
  selected: CustomerOption | null;
  onSelect: (customer: CustomerOption | null) => void;
}) {
  const [mode, setMode] = useState<"search" | "create">("search");
  const [query, setQuery] = useState("");
  const [resultsRaw, setResultsRaw] = useState<CustomerOption[]>([]);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  // Derived rather than reset via a synchronous setState in the effect
  // (react-hooks/set-state-in-effect) — same pattern as appointment-items-editor.tsx.
  const searchActive = mode === "search" && query.trim().length > 0;
  const results = searchActive ? resultsRaw : [];

  useEffect(() => {
    if (!searchActive) return;
    const handle = setTimeout(async () => setResultsRaw(await searchCustomers(tenantId, query)), 300);
    return () => clearTimeout(handle);
  }, [searchActive, query, tenantId]);

  const [createState, createAction, createPending] = useActionState(
    async (prevState: ActionResult<{ id: string }> | null, input: CreateCustomerInput) => {
      const result = await createCustomerAction(prevState, input);
      if (result.success) {
        onSelect({ id: result.data.id, fullName: input.fullName, phone: input.phone || null, email: input.email || null });
      }
      return result;
    },
    null,
  );

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">{selected.fullName}</p>
          <p className="text-muted-foreground text-xs">{[selected.phone, selected.email].filter(Boolean).join(" · ") || "—"}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onSelect(null)}>
          Değiştir
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Button type="button" variant={mode === "search" ? "default" : "outline"} size="sm" onClick={() => setMode("search")}>
          <Search />
          Mevcut müşteri
        </Button>
        <Button type="button" variant={mode === "create" ? "default" : "outline"} size="sm" onClick={() => setMode("create")}>
          <UserPlus />
          Yeni müşteri
        </Button>
      </div>

      {mode === "search" ? (
        <div className="flex flex-col gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="İsim, telefon veya e-posta ara…"
            autoFocus
          />
          {results.length > 0 && (
            <ul className="divide-border max-h-56 divide-y overflow-y-auto rounded-lg border">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c)}
                    className="hover:bg-muted/50 flex w-full flex-col px-3 py-2 text-left text-sm"
                  >
                    <span className="font-medium">{c.fullName}</span>
                    <span className="text-muted-foreground text-xs">{[c.phone, c.email].filter(Boolean).join(" · ") || "—"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && results.length === 0 && (
            <p className="text-muted-foreground text-xs">Sonuç bulunamadı. Yeni müşteri oluşturabilirsiniz.</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-customer-name">Ad soyad</Label>
            <Input id="quick-customer-name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quick-customer-phone">Telefon</Label>
              <Input id="quick-customer-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05xx xxx xx xx" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quick-customer-email">E-posta</Label>
              <Input id="quick-customer-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          {createState && !createState.success && (
            <p className="text-destructive text-sm" role="alert">
              {createState.error.message}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={createPending || !fullName.trim()}
            onClick={() =>
              startTransition(() => createAction({ tenantId, tenantSlug, fullName, phone, email }))
            }
            className="self-start"
          >
            <Check />
            {createPending ? "Oluşturuluyor…" : "Müşteriyi oluştur ve seç"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function CreateAppointmentSheet({
  open,
  onOpenChange,
  tenantId,
  tenantSlug,
  tenantTimezone,
  branches,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  branches: BranchOption[];
  onCreated: (appointmentId: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {/* Keyed on `open` — full remount each time the sheet opens, same
            reset-via-remount pattern used by every other detail sheet in
            this codebase. */}
        {open && (
          <CreateAppointmentForm
            key={String(open)}
            tenantId={tenantId}
            tenantSlug={tenantSlug}
            tenantTimezone={tenantTimezone}
            branches={branches}
            onCreated={onCreated}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CreateAppointmentForm({
  tenantId,
  tenantSlug,
  tenantTimezone,
  branches,
  onCreated,
}: {
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  branches: BranchOption[];
  onCreated: (appointmentId: string) => void;
}) {
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [branchId, setBranchId] = useState(branches.length === 1 ? branches[0]!.id : "");
  const [date, setDate] = useState(() => todayLocalDate(tenantTimezone));
  const [servicesRaw, setServicesRaw] = useState<ServiceForBranch[]>([]);
  const [items, setItems] = useState<ItemDraft[]>([{ key: crypto.randomUUID(), serviceId: "", staffMemberId: "", startTime: "" }]);
  const [notes, setNotes] = useState("");

  // Derived rather than reset via a synchronous setState in the effect
  // (react-hooks/set-state-in-effect) — same pattern as appointment-items-editor.tsx.
  const services = branchId ? servicesRaw : [];

  useEffect(() => {
    if (!branchId) return;
    fetchServicesForBranch(tenantId, branchId).then(setServicesRaw);
  }, [branchId, tenantId]);

  const [state, formAction, isPending] = useActionState(
    async (prevState: ActionResult<{ id: string }> | null, input: CreateAppointmentInput) => {
      const result = await createAppointmentAction(prevState, input);
      if (result.success) onCreated(result.data.id);
      return result;
    },
    null,
  );

  const itemsValid = items.every((i) => i.serviceId && i.staffMemberId && i.startTime);
  const canSubmit = customer && branchId && date && items.length > 0 && itemsValid;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !customer) return;
    const input: CreateAppointmentInput = {
      tenantSlug,
      tenantId,
      branchId,
      customerId: customer.id,
      items: items.map((item, index) => ({
        serviceId: item.serviceId,
        staffMemberId: item.staffMemberId,
        scheduledStartAt: tenantLocalToUtcIso(date, item.startTime, tenantTimezone),
        sequence: index + 1,
      })),
      notes: notes || undefined,
    };
    startTransition(() => formAction(input));
  }

  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>Randevu oluştur</SheetTitle>
        <SheetDescription>Müşteri, şube ve hizmetleri seçerek yeni bir randevu oluşturun.</SheetDescription>
      </SheetHeader>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
        <div className="flex flex-col gap-1.5">
          <Label>Müşteri</Label>
          <CustomerPicker tenantId={tenantId} tenantSlug={tenantSlug} selected={customer} onSelect={setCustomer} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Şube</Label>
            <Select value={branchId || undefined} onValueChange={(v) => setBranchId(v as string)}>
              <SelectTrigger className="w-full">
                {/* Base UI's Select.Value shows the raw value string unless
                    given an explicit label-lookup render function — it has
                    no other way to resolve a display label. */}
                <SelectValue placeholder="Şube seçin">
                  {(value: string | null) => branches.find((b) => b.id === value)?.name ?? "Şube seçin"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="appointment-date">Tarih</Label>
            <Input id="appointment-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Hizmetler</Label>
          <AppointmentItemsEditor
            tenantId={tenantId}
            branchId={branchId}
            tenantTimezone={tenantTimezone}
            date={date}
            items={items}
            services={services}
            onItemsChange={setItems}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="appointment-notes">Notlar (opsiyonel)</Label>
          <Textarea id="appointment-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>

        {state && !state.success && (
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
        )}
      </div>

      <SheetFooter>
        <Button type="submit" disabled={!canSubmit || isPending}>
          {isPending ? "Oluşturuluyor…" : "Randevuyu oluştur"}
        </Button>
      </SheetFooter>
    </form>
  );
}
