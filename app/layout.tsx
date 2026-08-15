import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const fontSans = Plus_Jakarta_Sans({
  subsets: ["latin", "latin-ext"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SalonOS",
  description: "Kuaför ve güzellik salonları için operasyon platformu",
};

/**
 * True root layout — the only place <html>/<body> are defined. Renders for
 * every request, including ones that never resolve a valid [locale]
 * segment, so app/not-found.tsx and everything under app/[locale]/ must
 * never define their own document shell. global-error.tsx is the one
 * deliberate exception, since it replaces this layout when it throws.
 *
 * lang is hardcoded to "tr" because that's the only locale Faz 0 ships —
 * revisit when a second locale is added (see lib/i18n/routing.ts).
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="tr" className={fontSans.variable} suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-screen font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
