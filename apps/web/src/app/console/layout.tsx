import type { ReactNode } from "react";
import { SignOutButton } from "@/components/wallet/SignInButton";
import { requireSession } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/**
 * Every console page is behind a signed session. The layout's check is for the header only: each page
 * runs its own guard (requireSession for /console, requireMember for a vault), because a layout does
 * not re-run on every navigation.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <div>
      <div className="mb-4 flex items-center justify-between text-sm text-[#0B0B0C]/60">
        <span>
          Signed in as <span className="mono">{session.accountId}</span>
        </span>
        <SignOutButton />
      </div>
      {children}
    </div>
  );
}
