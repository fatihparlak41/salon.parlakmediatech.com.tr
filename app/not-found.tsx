import Link from "next/link";

/**
 * Fallback for requests that never resolve a valid [locale] segment.
 * Ordinary in-app 404s are handled by app/[locale]/not-found.tsx instead,
 * which can use next-intl. No <html>/<body> here — app/layout.tsx always
 * provides those. Plain next/link + hardcoded Turkish: no next-intl
 * context reaches this boundary.
 */
export default function RootNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="border-border bg-card w-full max-w-sm rounded-lg border p-8 text-center shadow-sm">
        <h1 className="text-card-foreground text-lg font-semibold">
          Sayfa bulunamadı
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Aradığınız sayfa mevcut değil veya taşınmış olabilir.
        </p>
        <Link
          href="/"
          className="bg-primary text-primary-foreground mt-6 inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium"
        >
          Ana sayfaya dön
        </Link>
      </div>
    </div>
  );
}
