"use client";

import { startTransition, useActionState, useState } from "react";
import type { ActionResult } from "@/lib/errors";
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
import { Checkbox } from "@/components/ui/checkbox";
import { createServiceAction, type CreateServiceInput } from "@/lib/modules/services/actions";
import type { BranchOption } from "@/lib/modules/staff/queries";

export function CreateServiceDialog({
  open,
  onOpenChange,
  tenantId,
  tenantSlug,
  branches,
  existingCategories,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  branches: BranchOption[];
  existingCategories: string[];
  onCreated: (serviceId: string) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("30");
  const [price, setPrice] = useState("");
  const [branchIds, setBranchIds] = useState<string[]>(
    branches.length === 1 ? [branches[0]!.id] : [],
  );

  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<{ id: string }> | null,
      input: CreateServiceInput,
    ): Promise<ActionResult<{ id: string }>> => {
      const result = await createServiceAction(prevState, input);
      if (result.success) {
        onCreated(result.data.id);
        setName("");
        setCategory("");
        setDescription("");
        setDurationMinutes("30");
        setPrice("");
        setBranchIds(branches.length === 1 ? [branches[0]!.id] : []);
      }
      return result;
    },
    null,
  );

  function toggleBranch(id: string) {
    setBranchIds((prev) => (prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input: CreateServiceInput = {
      tenantId,
      tenantSlug,
      name,
      category,
      description,
      durationMinutes: Number(durationMinutes),
      price,
      branchIds,
    };
    startTransition(() => formAction(input));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Hizmet ekle</DialogTitle>
            <DialogDescription>
              Salonunuzun sunduğu bir hizmeti tanımlayın.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="service-name">Hizmet adı</Label>
              <Input id="service-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="service-category">Kategori (opsiyonel)</Label>
              <Input
                id="service-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                list="service-category-options"
                placeholder="örn. Saç, Tırnak, Cilt bakımı"
              />
              <datalist id="service-category-options">
                {existingCategories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="service-duration">Takvim Süresi (dakika)</Label>
                <Input
                  id="service-duration"
                  type="number"
                  min={1}
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="service-price">Fiyat (₺)</Label>
                <Input
                  id="service-price"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="150"
                  required
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="service-description">Açıklama (opsiyonel)</Label>
              <Textarea
                id="service-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Şubeler</Label>
              {branches.length === 0 ? (
                <p className="text-muted-foreground text-xs">Önce bir şube oluşturun.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {branches.map((branch) => (
                    <label key={branch.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={branchIds.includes(branch.id)}
                        onCheckedChange={() => toggleBranch(branch.id)}
                      />
                      {branch.name}
                    </label>
                  ))}
                </div>
              )}
              {branchIds.length === 0 && branches.length > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Şube seçilmezse bu hizmet hiçbir şubede randevu için sunulamaz.
                </p>
              )}
            </div>

            {state && !state.success && (
              <p className="text-destructive text-sm" role="alert">
                {state.error.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isPending || !name.trim() || !price.trim()}>
              {isPending ? "Oluşturuluyor…" : "Hizmeti oluştur"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
