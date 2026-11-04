import type { Metadata } from "next";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { RouteLink } from "@/components/RouteLink";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { FOOTER_NAV, isBuilt, SITE_NAV } from "@/lib/routes";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Probarion", template: "%s · Probarion" },
  description: "Spend by mandate. Prove every payment.",
};

// next.config.ts maps NEAR_NETWORK (default testnet) onto this public variable at build time.
const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink antialiased">
        {/* The wallet context wraps the whole page, so a nav or footer widget can use it too. */}
        <WalletProvider network={NETWORK}>
          <div className="bg-amber-100 px-4 py-1 text-center text-xs text-amber-900">
            Unaudited beta. Non-custodial software: Probarion never holds your owner keys. Use small
            amounts.
          </div>
          <header className="border-b border-stone-200 bg-white">
            <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-6 px-4 py-3">
              <Link href="/" className="font-semibold">
                Probarion
              </Link>
              {/* A page that is still planned (src/lib/routes.ts) is left out until it is built. */}
              {SITE_NAV.map(({ route, label }) => (
                <RouteLink
                  key={route}
                  route={route}
                  whenPlanned="hide"
                  className="text-sm text-stone-600 hover:text-stone-900"
                >
                  {label}
                </RouteLink>
              ))}
            </nav>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
          <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-stone-500">
            {FOOTER_NAV.filter(({ route }) => isBuilt(route)).map(({ route, label }) => (
              <Fragment key={route}>
                <Link href={route}>{label}</Link>
                {" · "}
              </Fragment>
            ))}
            MIT-licensed core · Unaudited beta
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
