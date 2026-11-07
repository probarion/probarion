import Link from "next/link";
import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";
import { SignOutButton } from "@/components/wallet/SignInButton";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { requireSession } from "@/lib/auth/guard";
import { requestNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

/**
 * Every console page is behind a signed session. The layout's check is for the header only: each page
 * runs its own guard (requireSession for /console, requireMember for a vault), because a layout does
 * not re-run on every navigation.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // The wallet is the network's of the address this is opened at (the session is too: requireSession read it).
  const network = await requestNetwork();
  return (
    <WalletProvider network={network}>
      <Container>
        <div className="mb-4 flex items-center justify-between gap-3 text-sm text-[#0B0B0C]/60">
          <span className="min-w-0">
            Signed in as <span className="mono wrap-anywhere">{session.accountId}</span>
          </span>
          <span className="flex shrink-0 items-center gap-3">
            <Link href="/extension" className="whitespace-nowrap underline">
              Browser extension
            </Link>
            <span className="shrink-0 whitespace-nowrap">
              <SignOutButton />
            </span>
          </span>
        </div>
        {children}
      </Container>
    </WalletProvider>
  );
}
