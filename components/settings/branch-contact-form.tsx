"use client";

import { startTransition, useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { updateBranchContactAction } from "@/lib/modules/branches/actions";
import type { BranchContact } from "@/lib/modules/branches/queries";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Faz 2I.2F (Batch A) — same overall shape as SelfServicePolicyForm
 * (useActionState + startTransition + local optimistic state), extended
 * with a branch picker since these fields are branch-level, not
 * tenant-level (see the migration's own architecture comment). A
 * single-branch tenant — the actual shape of the Gökhan pilot — never
 * sees the picker at all, keeping that case exactly as simple as the
 * spec asked for; a multi-branch tenant gets one extra Select above the
 * same fields, editing one branch at a time.
 *
 * `feedback` is tracked separately from useActionState's own `state`
 * (rather than rendering `state` directly, as SelfServicePolicyForm
 * does) specifically so switching branches doesn't keep showing a
 * previous branch's "Kaydedildi." after navigating away from it.
 */
export function BranchContactForm({
  tenantSlug,
  branches,
}: {
  tenantSlug: string;
  branches: BranchContact[];
}) {
  const t = useTranslations("Settings.branchContact");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [byId, setById] = useState<Record<string, BranchContact>>(() =>
    Object.fromEntries(branches.map((b) => [b.id, b])),
  );
  const [feedback, setFeedback] = useState<{ branchId: string; success: boolean; message: string } | null>(null);
  const current = byId[branchId];

  const [, action, isPending] = useActionState<null, Parameters<typeof updateBranchContactAction>[1]>(
    async (_prevState, input) => {
      const result = await updateBranchContactAction(null, input);
      if (result.success) {
        setById((prev) => ({ ...prev, [result.data.id]: result.data }));
        setFeedback({ branchId: input.branchId, success: true, message: t("saved") });
      } else {
        setFeedback({ branchId: input.branchId, success: false, message: result.error.message });
      }
      return null;
    },
    null,
  );

  if (!current) return null;

  function update(field: "address" | "phone" | "whatsappPhone" | "instagramHandle" | "locationUrl", value: string) {
    setById((prev) => ({ ...prev, [branchId]: { ...prev[branchId]!, [field]: value } }));
  }

  function selectBranch(id: string | null) {
    if (!id) return;
    setBranchId(id);
    setFeedback(null);
  }

  function handleSave() {
    startTransition(() =>
      action({
        branchId,
        tenantSlug,
        address: current.address ?? "",
        phone: current.phone ?? "",
        whatsappPhone: current.whatsappPhone ?? "",
        instagramHandle: current.instagramHandle ?? "",
        locationUrl: current.locationUrl ?? "",
      }),
    );
  }

  return (
    <div className="flex flex-col gap-6 rounded-lg border p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t("heading")}</h2>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      {branches.length > 1 && (
        <div className="flex flex-col gap-1.5 border-t pt-4">
          <Label>{t("branchLabel")}</Label>
          <Select value={branchId} onValueChange={selectBranch}>
            <SelectTrigger className="w-full">
              <SelectValue>{(id: string) => byId[id]?.name ?? id}</SelectValue>
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
      )}

      <div className={`flex flex-col gap-4 ${branches.length > 1 ? "" : "border-t pt-4"}`}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bc-address">{t("addressLabel")}</Label>
          <Input id="bc-address" value={current.address ?? ""} onChange={(e) => update("address", e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bc-phone">{t("phoneLabel")}</Label>
          <Input
            id="bc-phone"
            type="tel"
            value={current.phone ?? ""}
            onChange={(e) => update("phone", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bc-whatsapp">{t("whatsappLabel")}</Label>
          <Input
            id="bc-whatsapp"
            type="tel"
            placeholder={t("whatsappPlaceholder")}
            value={current.whatsappPhone ?? ""}
            onChange={(e) => update("whatsappPhone", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bc-instagram">{t("instagramLabel")}</Label>
          <Input
            id="bc-instagram"
            placeholder={t("instagramPlaceholder")}
            value={current.instagramHandle ?? ""}
            onChange={(e) => update("instagramHandle", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bc-location">{t("locationLabel")}</Label>
          <Input
            id="bc-location"
            type="url"
            placeholder={t("locationPlaceholder")}
            value={current.locationUrl ?? ""}
            onChange={(e) => update("locationUrl", e.target.value)}
          />
        </div>
      </div>

      {feedback && feedback.branchId === branchId && !feedback.success ? (
        <p className="text-destructive text-sm" role="alert">
          {feedback.message}
        </p>
      ) : null}
      {feedback && feedback.branchId === branchId && feedback.success ? (
        <p className="text-sm text-green-600 dark:text-green-500">{feedback.message}</p>
      ) : null}

      <Button type="button" onClick={handleSave} disabled={isPending} className="w-fit">
        {isPending ? t("saving") : t("save")}
      </Button>
    </div>
  );
}
