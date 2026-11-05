import type { Metadata } from "next";
import { Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { BetaStrip } from "@/components/site/BetaStrip";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import s from "@/components/site/site.module.css";
import { BUILD_NETWORK } from "@/lib/site/network";
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
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  title: { default: "Probarion", template: "%s · Probarion" },
  description: "Spend by mandate. Prove every payment.",
};

// The wallet context lives on the routes that sign (/console and /login). A page that only reads loads no wallet code.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col bg-paper font-sans text-ink antialiased">
        <a className={s.skip} href="#main">
          Skip to content
        </a>
        <BetaStrip network={BUILD_NETWORK} />
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
