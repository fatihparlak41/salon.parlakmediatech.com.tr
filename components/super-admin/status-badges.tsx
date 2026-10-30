import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { HealthLevel, HealthSignal, Lifecycle } from "@/lib/modules/platform/admin";

/** Lifecycle of a salon as a platform operator reads it. Colour is never the only carrier: the label is always printed. */
export function LifecycleBadge({ lifecycle, labels }: { lifecycle: Lifecycle; labels: Record<Lifecycle, string> }) {
  const variant = lifecycle === "active" ? "default" : lifecycle === "suspended" ? "destructive" : lifecycle === "setup" ? "secondary" : "outline";
  return (
    <Badge variant={variant} data-lifecycle={lifecycle}>
      {labels[lifecycle]}
    </Badge>
  );
}

export function HealthBadge({ level, labels }: { level: HealthLevel; labels: Record<HealthLevel, string> }) {
  const variant = level === "critical" ? "destructive" : level === "info" ? "secondary" : "outline";
  return (
    <Badge
      variant={variant}
      data-health={level}
      className={cn(level === "warning" && "border-amber-500/60 text-amber-700 dark:text-amber-400", level === "ok" && "text-muted-foreground")}
    >
      {labels[level]}
    </Badge>
  );
}

/** One health signal as a sentence with its severity; unknown codes fall back to the code itself (never blank). */
export function SignalList({
  signals,
  codes,
  levels,
}: {
  signals: HealthSignal[];
  codes: Record<string, string>;
  levels: Record<HealthLevel, string>;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {signals.map((s) => (
        <li key={`${s.severity}-${s.code}`} className="flex items-center gap-2 text-sm" data-signal={s.code}>
          <HealthBadge level={s.severity} labels={levels} />
          <span>{codes[s.code] ?? s.code}</span>
        </li>
      ))}
    </ul>
  );
}
