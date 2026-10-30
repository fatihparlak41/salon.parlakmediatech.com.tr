import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** One operational number. `tone` only colours the figure when it signals a problem; a zero is never alarming. */
export function StatCard({ label, value, tone = "plain", hint }: { label: string; value: number; tone?: "plain" | "critical" | "warning"; hint?: string }) {
  return (
    <Card size="sm" data-stat={label}>
      <CardContent className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs font-medium">{label}</span>
        <span
          className={cn(
            "text-2xl font-semibold tabular-nums",
            value > 0 && tone === "critical" && "text-destructive",
            value > 0 && tone === "warning" && "text-amber-700 dark:text-amber-400",
          )}
        >
          {value}
        </span>
        {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
      </CardContent>
    </Card>
  );
}
