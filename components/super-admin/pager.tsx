import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { listHref } from "@/components/super-admin/salon-filters";
import type { ListParams } from "@/lib/modules/platform/admin";

export type PagerLabels = { previous: string; next: string; pageOf: string; results: string };

/** Previous / next as plain links (the current filter and search are carried along). Renders nothing for a single page. */
export function Pager({ params, total, pageSize, labels }: { params: ListParams; total: number; pageSize: number; labels: PagerLabels }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{labels.results.replace("{count}", String(total))}</span>
      {pages > 1 ? (
        <div className="flex items-center gap-2">
          {params.page > 1 ? (
            <Button variant="outline" size="sm" render={<Link href={listHref({ ...params, page: params.page - 1 })} rel="prev" />}>
              {labels.previous}
            </Button>
          ) : null}
          <span className="text-muted-foreground tabular-nums">{labels.pageOf.replace("{page}", String(Math.min(params.page, pages))).replace("{pages}", String(pages))}</span>
          {params.page < pages ? (
            <Button variant="outline" size="sm" render={<Link href={listHref({ ...params, page: params.page + 1 })} rel="next" />}>
              {labels.next}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
