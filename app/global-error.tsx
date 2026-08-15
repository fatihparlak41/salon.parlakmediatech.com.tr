"use client";

/**
 * Root-layout-level fallback. Renders its own <html>/<body> because it
 * replaces the [locale] layout entirely when that layout itself throws —
 * next-intl context is not available here, so this file cannot use
 * useTranslations and stays in plain Turkish.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="tr">
      <body className="flex min-h-screen items-center justify-center bg-[#faf9f7] p-6 font-sans text-[#221d18]">
        <div className="w-full max-w-sm rounded-lg border border-[#e2dacd] bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold">Bir şeyler ters gitti</h1>
          <p className="mt-2 text-sm text-[#6e6459]">
            Beklenmeyen bir hata oluştu. Sorun devam ederse lütfen tekrar
            deneyin.
          </p>
          {error.digest ? (
            <p className="mt-3 font-mono text-xs text-[#9c9184]">
              Hata referansı: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="mt-6 inline-flex h-9 items-center justify-center rounded-md bg-[#221d18] px-4 text-sm font-medium text-white"
          >
            Tekrar dene
          </button>
        </div>
      </body>
    </html>
  );
}
