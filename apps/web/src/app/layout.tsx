import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { BetaStrip } from "@/components/site/BetaStrip";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import s from "@/components/site/site.module.css";
import { appOrigin } from "@/lib/config";
import { OG_IMAGE, SITE_DESCRIPTION, SITE_TITLE } from "@/lib/site/facts";
import "./globals.css";

// Self-hosted at build time. Each sets its Tailwind theme variable on <html>, which beats the fallback in globals.css.
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  metadataBase: new URL(appOrigin()),
  title: { default: SITE_TITLE, template: "%s · Probarion" },
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Probarion",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
};

// One light scheme (globals.css): "only light" asks a browser not to darken the page on its own. Next keeps its default
// width=device-width, initial-scale=1, so zoom stays free.
export const viewport: Viewport = { colorScheme: "only light" };

// The wallet context lives on the routes that sign (/console and /login). A page that only reads loads no wallet code.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col bg-paper font-sans text-ink antialiased">
        <a className={s.skip} href="#main">
          Skip to content
        </a>
        <BetaStrip />
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
