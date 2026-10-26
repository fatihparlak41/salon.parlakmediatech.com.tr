import { Link } from "@/lib/i18n/navigation";
import { stepProgress, type OnboardingStatus } from "@/lib/modules/onboarding/model";

/** Dashboard entry to the guided setup. Shown only to a salon that is not ready and has never taken an appointment. */
export function SetupCard({
  status,
  href,
  labels,
}: {
  status: OnboardingStatus;
  href: string;
  labels: { title: string; body: string; cta: string; progress: (done: number, total: number) => string };
}) {
  const { done, total } = stepProgress(status);
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-amber-500/30 dark:bg-amber-950/20">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{labels.title}</h2>
        <p className="text-muted-foreground text-sm">{labels.body}</p>
        <p className="text-muted-foreground text-xs tabular-nums">{labels.progress(done, total)}</p>
      </div>
      <Link href={href} className="bg-primary text-primary-foreground hover:bg-primary/80 inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-3 text-sm font-medium">
        {labels.cta}
      </Link>
    </section>
  );
}
