"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Faz DASHBOARD.1 — same clipboard pattern as
 * components/customer-account/link-salon-code-generator.tsx: a plain
 * navigator.clipboard.writeText, a 2s "copied" flip, and a silent catch
 * (the value stays visible/selectable on screen either way, so a
 * clipboard-permission failure is not worth surfacing as an error). */
export function CopyLinkButton({ value, label, copiedLabel }: { value: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail silently — no user-facing error needed.
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? copiedLabel : label}
    </Button>
  );
}
