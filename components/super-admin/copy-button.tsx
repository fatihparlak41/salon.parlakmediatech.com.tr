"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Copies a non-secret value (a booking link, a tenant id) to the clipboard. This is the ONLY client-side script in the Super Admin console:
 * it handles text it is handed and calls nothing. Clipboard access can be refused (insecure context, permissions), so a failure is silent
 * and the value stays visible next to the button.
 */
export function CopyButton({ value, label, doneLabel }: { value: string; label: string; doneLabel: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? doneLabel : label}
    </Button>
  );
}
