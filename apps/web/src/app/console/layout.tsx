import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";
import { SignOutButton } from "@/components/wallet/SignInButton";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { requireSession } from "@/lib/auth/guard";
import { BUILD_NETWORK } from "@/lib/site/network";

export const dynamic = "force-dynamic";

/**
 * Every console page is behind a signed session. The layout's check is for the header only: each page
 * runs its own guard (requireSession for /console, requireMember for a vault), because a layout does
 * not re-run on every navigation.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <WalletProvider network={BUILD_NETWORK}>
      <Container>
        <div className="mb-4 flex items-center justify-between text-sm text-[#0B0B0C]/60">
          <span>
            Signed in as <span className="mono">{session.accountId}</span>
          </span>
          <SignOutButton />
        </div>
        {children}
      </Container>
    </WalletProvider>
  );
}
