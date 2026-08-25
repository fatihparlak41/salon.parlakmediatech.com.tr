"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { createMyLinkCodeAction } from "@/lib/modules/customer-account/actions";
import { formatLinkCodeForDisplay } from "@/lib/modules/customer-account/link-code-format";

/**
 * Faz 2G.3.2 — generates (and can regenerate) a tenant-bound pairing
 * code the customer hands directly to salon staff. Never reveals CRM
 * row/customer id/salon count — the code itself is the entire payload.
 * Regenerating explicitly replaces the previous code (server-side,
 * atomically) rather than allowing several to coexist for this tenant.
 */
export function LinkSalonCodeGenerator({
  tenantSlug,
  labels,
}: {
  tenantSlug: string;
  labels: {
    generate: string;
    generating: string;
    regenerate: string;
    codeLabel: string;
    copy: string;
    copied: string;
    expiresNote: string;
  };
}) {
  const [state, formAction, isPending] = useActionState(createMyLinkCodeAction, null);
  const [copied, setCopied] = useState(false);

  async function handleCopy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, non-secure context) —
      // the code is still fully visible on screen either way, so this
      // is a pure UX nicety, not something that needs a user-facing error.
    }
  }

  if (state?.success) {
    const display = formatLinkCodeForDisplay(state.data.code);
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border p-6 text-center">
        <p className="text-muted-foreground text-sm">{labels.codeLabel}</p>
        <p className="font-mono text-3xl font-semibold tracking-wider tabular-nums">{display}</p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => handleCopy(state.data.code)}>
            {copied ? labels.copied : labels.copy}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{labels.expiresNote}</p>
        <form action={formAction}>
          <input type="hidden" name="tenantSlug" value={tenantSlug} />
          <Button type="submit" variant="ghost" size="sm" disabled={isPending}>
            {isPending ? labels.generating : labels.regenerate}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-center gap-3 rounded-xl border p-6 text-center">
      <input type="hidden" name="tenantSlug" value={tenantSlug} />
      <Button type="submit" disabled={isPending}>
        {isPending ? labels.generating : labels.generate}
      </Button>
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
