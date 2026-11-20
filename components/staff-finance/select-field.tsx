import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A native <select> styled like the shadcn Input. Deliberate for the personnel forms: native pickers are the best experience
 * on the phones salon owners use, they are fully accessible without extra work, and they behave deterministically in tests.
 */
export function SelectField({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select-field"
      className={cn(
        "border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:bg-input/50 dark:bg-input/30 h-8 w-full min-w-0 rounded-lg border bg-transparent px-2 py-1 text-base transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
