import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LIST_FILTERS, LIST_SORTS, type ListFilter, type ListParams, type ListSort } from "@/lib/modules/platform/admin";
import { cn } from "@/lib/utils";

export type SalonFilterLabels = {
  searchLabel: string;
  searchPlaceholder: string;
  searchButton: string;
  clear: string;
  sortLabel: string;
  filters: Record<ListFilter, string>;
  sorts: Record<ListSort, string>;
};

/** Builds a list URL from a (possibly partial) request; defaults are left out so URLs stay short and shareable. */
export function listHref(params: Partial<ListParams>): string {
  const q = new URLSearchParams();
  if (params.search) q.set("q", params.search);
  if (params.filter && params.filter !== "all") q.set("filter", params.filter);
  if (params.sort && params.sort !== "created_desc") q.set("sort", params.sort);
  if (params.page && params.page > 1) q.set("page", String(params.page));
  const s = q.toString();
  return s ? `/super-admin/salons?${s}` : "/super-admin/salons";
}

const SELECT = "border-input bg-background h-9 rounded-lg border px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * Search + filter chips + sort, all plain GET links and one plain GET form: it works without client JavaScript, every state is a shareable
 * URL, and nothing here can submit anything but a read. The server re-validates every value (parseListParams), so a hand-edited URL is
 * harmless.
 */
export function SalonFilters({ params, labels }: { params: ListParams; labels: SalonFilterLabels }) {
  return (
    <div className="flex flex-col gap-3">
      <form method="get" action="/super-admin/salons" className="flex flex-wrap items-center gap-2" role="search">
        <label className="sr-only" htmlFor="salon-search">
          {labels.searchLabel}
        </label>
        <Input id="salon-search" name="q" defaultValue={params.search} placeholder={labels.searchPlaceholder} className="w-full sm:w-80" maxLength={100} autoComplete="off" />
        {params.filter !== "all" ? <input type="hidden" name="filter" value={params.filter} /> : null}
        <label className="sr-only" htmlFor="salon-sort">
          {labels.sortLabel}
        </label>
        <select id="salon-sort" name="sort" defaultValue={params.sort} className={SELECT}>
          {LIST_SORTS.map((s) => (
            <option key={s} value={s}>
              {labels.sorts[s]}
            </option>
          ))}
        </select>
        <Button type="submit">{labels.searchButton}</Button>
        {params.search || params.filter !== "all" || params.sort !== "created_desc" ? (
          <Button variant="ghost" render={<Link href="/super-admin/salons" />}>
            {labels.clear}
          </Button>
        ) : null}
      </form>
      <nav className="flex flex-wrap gap-1.5" aria-label="filter">
        {LIST_FILTERS.map((f) => (
          <Link
            key={f}
            href={listHref({ search: params.search, filter: f, sort: params.sort })}
            aria-current={params.filter === f ? "true" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              params.filter === f ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {labels.filters[f]}
          </Link>
        ))}
      </nav>
    </div>
  );
}
