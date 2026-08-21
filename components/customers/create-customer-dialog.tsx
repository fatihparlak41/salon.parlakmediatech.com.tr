"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import type { ActionResult } from "@/lib/errors";
import { createCustomerAction, type CreateCustomerInput } from "@/lib/modules/customers/actions";

type DuplicateMatch = { id: string; fullName: string; phone: string | null; email: string | null };

async function findDuplicates(tenantId: string, query: string): Promise<DuplicateMatch[]> {
  if (!query.trim()) return [];
  const supabase = createClient();
  const { data } = await supabase.rpc("search_customers", {
    p_tenant_id: tenantId,
    p_query: query,
    p_status: "all",
    p_limit: 5,
    p_offset: 0,
  });
  return (data ?? []).map((r) => ({ id: r.id, fullName: r.full_name, phone: r.phone, email: r.email }));
}

export function CreateCustomerDialog({
  open,
  onOpenChange,
  tenantId,
  tenantSlug,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  onCreated: (customerId: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);

  // Debounced, non-blocking — only ever queries this tenant's own
  // customers (RLS-scoped client, same as everywhere else), so a match
  // from another salon can never surface here.
  useEffect(() => {
    const term = phone.trim() || email.trim();
    const handle = setTimeout(async () => {
      setDuplicates(term ? await findDuplicates(tenantId, term) : []);
    }, 400);
    return () => clearTimeout(handle);
  }, [phone, email, tenantId]);

  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<{ id: string }> | null,
      input: CreateCustomerInput,
    ): Promise<ActionResult<{ id: string }>> => {
      const result = await createCustomerAction(prevState, input);
      if (result.success) {
        onCreated(result.data.id);
        setFullName("");
        setPhone("");
        setEmail("");
        setNotes("");
        setDuplicates([]);
      }
      return result;
    },
    null,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input: CreateCustomerInput = { tenantId, tenantSlug, fullName, phone, email, notes };
    startTransition(() => formAction(input));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Müşteri ekle</DialogTitle>
            <DialogDescription>Salonunuza gelen bir müşteriyi kaydedin.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer-full-name">Ad soyad</Label>
              <Input
                id="customer-full-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customer-phone">Telefon</Label>
                <Input id="customer-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05xx xxx xx xx" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customer-email">E-posta</Label>
                <Input id="customer-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>

            {duplicates.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-500">
                  <AlertTriangle className="size-4 shrink-0" />
                  Bu telefon veya e-posta ile eşleşen müşteri(ler) zaten var:
                </p>
                <ul className="text-muted-foreground flex flex-col gap-0.5 text-sm">
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      {d.fullName}
                      {d.phone ? ` — ${d.phone}` : ""}
                      {d.email ? ` — ${d.email}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer-notes">Notlar (opsiyonel)</Label>
              <Textarea id="customer-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>

            {state && !state.success && (
              <p className="text-destructive text-sm" role="alert">
                {state.error.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isPending || !fullName.trim()}>
              {isPending ? "Oluşturuluyor…" : "Müşteriyi oluştur"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
