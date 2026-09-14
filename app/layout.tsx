import type { Metadata, Viewport } from "next";
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
  applicationName: "SalonOS",
  // Faz NOTIF.2C / 2C.2 — PWA. Emits <link rel="manifest">, the Apple
  // standalone meta tags, and the icon <link>s below. app/favicon.ico is
  // picked up automatically. No hand-written apple-mobile-web-app-* tags
  // here — Next generates them from `appleWebApp`.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "SalonOS",
    statusBarStyle: "default",
  },
  // Static PNGs cropped from the genuine SalonOS gold emblem (emblem
  // only) — see scripts/generate-pwa-icons.mjs. apple-touch icon is
  // opaque for reliable iOS rendering.
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the app's real surface colour so the browser/OS chrome does
  // not flash a foreign colour. Values are the design-system --background
  // token (app/globals.css), light and dark.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdfbf9" },
    { media: "(prefers-color-scheme: dark)", color: "#110c09" },
  ],
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
