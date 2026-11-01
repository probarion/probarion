import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Probarion", template: "%s · Probarion" },
  description: "Spend by mandate. Prove every payment.",
};

const NAV = [
  ["/console", "Console"],
  ["/canary", "Canary"],
  ["/open", "Open metrics"],
  ["/security", "Security"],
  ["/status", "Status"],
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">
        <div className="bg-amber-100 px-4 py-1 text-center text-xs text-amber-900">
          Unaudited beta. Non-custodial software: Probarion never holds your owner keys. Use small
          amounts.
        </div>
        <header className="border-b border-stone-200 bg-white">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-6 px-4 py-3">
            <Link href="/" className="font-semibold">
              Probarion
            </Link>
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className="text-sm text-stone-600 hover:text-stone-900">
                {label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-stone-500">
          <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link> ·{" "}
          <Link href="/security">Security</Link> · <Link href="/status">Status</Link> · MIT-licensed
          core · Unaudited beta
        </footer>
      </body>
    </html>
  );
}
