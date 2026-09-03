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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createStaffMemberAction, type CreateStaffInput } from "@/lib/modules/staff/actions";
import type { BranchOption, MembershipOption } from "@/lib/modules/staff/queries";

export function CreateStaffDialog({
  open,
  onOpenChange,
  tenantId,
  tenantSlug,
  branches,
  memberships,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantSlug: string;
  branches: BranchOption[];
  memberships: MembershipOption[];
  onCreated: (staffMemberId: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [branchIds, setBranchIds] = useState<string[]>(
    branches.length === 1 ? [branches[0]!.id] : [],
  );
  const [membershipId, setMembershipId] = useState<string>("");
  const [concurrentCapacity, setConcurrentCapacity] = useState("1");

  // Success handling lives in the action itself, not a useEffect watching
  // `state` — setState belongs in the code that causes the change (the
  // dispatched action), not in an effect reacting to its result afterward.
  const [state, formAction, isPending] = useActionState(
    async (
      prevState: ActionResult<{ id: string }> | null,
      input: CreateStaffInput,
    ): Promise<ActionResult<{ id: string }>> => {
      const result = await createStaffMemberAction(prevState, input);
      if (result.success) {
        onCreated(result.data.id);
        setFullName("");
        setEmail("");
        setPhone("");
        setBranchIds(branches.length === 1 ? [branches[0]!.id] : []);
        setMembershipId("");
        setConcurrentCapacity("1");
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
    const input: CreateStaffInput = {
      tenantId,
      tenantSlug,
      fullName,
      email,
      phone,
      branchIds,
      tenantMembershipId: membershipId,
      concurrentCapacity: Number(concurrentCapacity) || 1,
    };
    startTransition(() => formAction(input));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Personel ekle</DialogTitle>
            <DialogDescription>
              Bir çalışan hesabı gerekmez — istenirse sonradan mevcut bir üyelikle
              ilişkilendirebilirsiniz.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="staff-full-name">Ad soyad</Label>
              <Input
                id="staff-full-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="staff-email">E-posta (opsiyonel)</Label>
                <Input
                  id="staff-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="staff-phone">Telefon (opsiyonel)</Label>
                <Input
                  id="staff-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Şubeler</Label>
              {branches.length === 0 ? (
                <p className="text-muted-foreground text-xs">Önce bir şube oluşturun.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {branches.map((branch) => (
                    <label
                      key={branch.id}
                      className="group/field flex items-center gap-2 text-sm"
                    >
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
                  Şube seçilmezse bu personel hiçbir şubede randevu için müsait görünmez.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="staff-concurrent-capacity">Aynı anda bakabileceği müşteri sayısı</Label>
              <Input
                id="staff-concurrent-capacity"
                type="number"
                min={1}
                max={20}
                value={concurrentCapacity}
                onChange={(e) => setConcurrentCapacity(e.target.value)}
                className="w-24"
              />
              <p className="text-muted-foreground text-xs">
                Çoğu personel için 1 yeterlidir. Bu personel aynı anda birden fazla müşteriyle
                ilgilenebiliyorsa (örn. boya sürerken başka bir müşteriyi de alabiliyorsa) artırın.
              </p>
            </div>

            {memberships.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>Giriş erişimi bağla (opsiyonel)</Label>
                <Select
                  value={membershipId || undefined}
                  onValueChange={(v) => setMembershipId(v === "none" ? "" : (v as string))}
                >
                  <SelectTrigger className="w-full">
                    {/* Base UI's Select.Value shows the raw stored value
                        unless given an explicit label-lookup render
                        function. */}
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
                <p className="text-muted-foreground text-xs">
                  Yalnızca bu personelin SalonOS&apos;a giriş yapması gerekiyorsa seçin.
                </p>
              </div>
            )}

            {state && !state.success && (
              <p className="text-destructive text-sm" role="alert">
                {state.error.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isPending || !fullName.trim()}>
              {isPending ? "Oluşturuluyor…" : "Personeli oluştur"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
