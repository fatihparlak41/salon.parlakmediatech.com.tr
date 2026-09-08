import { Skeleton } from "@/components/ui/skeleton";

/**
 * Faz PERF.2 — the tenant app's one shared loading boundary. Placed at
 * this segment (co-located with layout.tsx) rather than duplicated per
 * page: Next.js wraps this segment's `page` — and everything below it —
 * in a Suspense boundary whose fallback is this component, so the
 * sidebar/mobile header in layout.tsx's own TenantAppShell render
 * unconditionally around it, exactly as they do around real page
 * content — no separate nav-preserving logic needed here at all.
 *
 * HONEST LIMIT, worth stating plainly rather than overclaiming: this
 * boundary sits INSIDE the tenant layout (it wraps {children}, the page
 * segment — it cannot wrap layout.tsx itself, since a segment's
 * loading.tsx never covers its own co-located layout, only the page
 * below it). PERF.1 found the layout's own getTenantAccess +
 * hasPermission waterfall — not any individual page's own fetch — is
 * the majority of the measured per-navigation cost. That portion still
 * renders with nothing on screen; this skeleton appears once the
 * layout has resolved and only the PAGE's own remaining fetch (if any)
 * is still pending. See the Faz PERF.2 final report for the measured
 * tap-to-first-visible-feedback numbers this actually produces per
 * page, rather than assuming the whole wait is now covered.
 *
 * Deliberately one generic skeleton, not one per page: a shape
 * reasonable across every destination (a header, a row of
 * control-sized blocks, a few card/row blocks) rather than a pixel
 * match for any single page's real content — some layout shift when
 * real content swaps in is expected, particularly for the sparser
 * pages (e.g. the dashboard), and is not hidden here.
 */
export default function TenantAppLoading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Yükleniyor…</span>

      {/* Header: icon box + title + description — the one shape common
          to every tenant-app page's own header. */}
      <div className="flex items-start gap-3" aria-hidden="true">
        <Skeleton className="size-10 shrink-0 rounded-lg" />
        <div className="flex-1 space-y-2 py-0.5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-64 max-w-full" />
        </div>
      </div>

      {/* A row of control-sized blocks — stands in for filters/tabs/
          actions, present in one form or another on every page. */}
      <div className="mt-6 flex flex-wrap gap-3" aria-hidden="true">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28 max-sm:hidden" />
      </div>

      {/* Content: a few card/row blocks — stands in for summary cards,
          list rows, or a table body alike without matching any one of
          them exactly. */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl max-sm:hidden" />
        <Skeleton className="h-20 rounded-xl max-sm:hidden" />
      </div>

      <div className="mt-6 space-y-2" aria-hidden="true">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg max-sm:hidden" />
      </div>
    </div>
  );
}
