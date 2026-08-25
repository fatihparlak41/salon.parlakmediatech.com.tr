"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/errors";
import {
  linkCustomerAccountAction,
  unlinkCustomerAccountAction,
  type LinkCustomerAccountInput,
  type UnlinkCustomerAccountInput,
} from "@/lib/modules/customers/actions";

type LinkStatus = { isLinked: boolean; claimedVia: string | null; canUnlink: boolean };

/**
 * Faz 2G.3.2 — the staff-facing account-link status + actions, shown in
 * the customer detail sheet. Never renders an operational unlink
 * control for future_booking/verified_booking_claim links — those
 * carry stronger, customer-owned identity evidence and are structurally
 * refused by the RPC itself even if a control existed here, but the UI
 * doesn't offer the button at all rather than relying on the backend to
 * reject it.
 */
export function AccountLinkSection({
  tenantSlug,
  customerId,
  canManageLink,
}: {
  tenantSlug: string;
  customerId: string;
  canManageLink: boolean;
}) {
  const t = useTranslations("Customers.accountLink");
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [unlinkDialogOpen, setUnlinkDialogOpen] = useState(false);

  async function reload() {
    const supabase = createClient();
    const { data } = await supabase.rpc("get_customer_account_link_status", { p_customer_id: customerId });
    const result = data as unknown as { isLinked: boolean; claimedVia?: string; canUnlink?: boolean } | null;
    setStatus({
      isLinked: result?.isLinked ?? false,
      claimedVia: result?.claimedVia ?? null,
      canUnlink: result?.canUnlink ?? false,
    });
  }

  useEffect(() => {
    // Deferred one tick — same pattern as booking-wizard.tsx's own slot-
    // fetch effect, to avoid a synchronous setState directly in the
    // effect body.
    const timer = setTimeout(() => {
      reload();
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- customerId identity change is the only thing that should refetch
  }, [customerId]);

  if (!status) {
    return <Skeleton className="h-16 w-full" />;
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">SalonOS Hesabı</p>
          {status.isLinked ? (
            <Badge variant="secondary" className="mt-1">
              {status.canUnlink ? t("linkedBadgeSalonAssisted") : t("linkedBadgeVerified")}
            </Badge>
          ) : (
            <p className="text-muted-foreground text-xs">{t("notLinked")}</p>
          )}
        </div>
        {canManageLink && !status.isLinked && (
          <Button type="button" variant="outline" size="sm" onClick={() => setLinkDialogOpen(true)}>
            {t("linkAction")}
          </Button>
        )}
        {canManageLink && status.isLinked && status.canUnlink && (
          <Button type="button" variant="outline" size="sm" onClick={() => setUnlinkDialogOpen(true)}>
            {t("unlinkAction")}
          </Button>
        )}
      </div>

      <LinkAccountDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        tenantSlug={tenantSlug}
        customerId={customerId}
        onLinked={() => {
          setLinkDialogOpen(false);
          reload();
        }}
      />
      <UnlinkAccountDialog
        open={unlinkDialogOpen}
        onOpenChange={setUnlinkDialogOpen}
        tenantSlug={tenantSlug}
        customerId={customerId}
        onUnlinked={() => {
          setUnlinkDialogOpen(false);
          reload();
        }}
      />
    </div>
  );
}

function LinkAccountDialog({
  open,
  onOpenChange,
  tenantSlug,
  customerId,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantSlug: string;
  customerId: string;
  onLinked: () => void;
}) {
  const t = useTranslations("Customers.accountLink");
  const [code, setCode] = useState("");
  const [state, action, isPending] = useActionState<ActionResult<null> | null, LinkCustomerAccountInput>(
    async (prevState, input) => {
      const result = await linkCustomerAccountAction(prevState, input);
      if (result.success) onLinked();
      return result;
    },
    null,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCode("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="link-account-code">{t("codeInputLabel")}</Label>
          <Input
            id="link-account-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="text-center font-mono tracking-wider uppercase"
            placeholder="XXXX-XXXX-XXXX"
          />
        </div>
        {state && !state.success && (
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={isPending || code.trim().length === 0}
            onClick={() => startTransition(() => action({ tenantSlug, customerId, rawCode: code }))}
          >
            {isPending ? t("linking") : t("confirmLink")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnlinkAccountDialog({
  open,
  onOpenChange,
  tenantSlug,
  customerId,
  onUnlinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantSlug: string;
  customerId: string;
  onUnlinked: () => void;
}) {
  const t = useTranslations("Customers.accountLink");
  const [state, action, isPending] = useActionState<ActionResult<null> | null, UnlinkCustomerAccountInput>(
    async (prevState, input) => {
      const result = await unlinkCustomerAccountAction(prevState, input);
      if (result.success) onUnlinked();
      return result;
    },
    null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("unlinkDialogTitle")}</DialogTitle>
          <DialogDescription>{t("unlinkDialogDescription")}</DialogDescription>
        </DialogHeader>
        {state && !state.success && (
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={() => startTransition(() => action({ tenantSlug, customerId }))}
          >
            {isPending ? t("unlinking") : t("confirmUnlink")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
