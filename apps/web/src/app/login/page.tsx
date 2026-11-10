import type { Metadata } from "next";
import { JustLooking, SignInIntro } from "@/components/console/SignInGuide";
import { Container } from "@/components/site/Container";
import { SignInButton } from "@/components/wallet/SignInButton";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { extensionNextPath } from "@/lib/auth/redirect";
import { softRequestNetwork } from "@/lib/network";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const consoleNext = typeof next === "string" && next.startsWith("/console") ? next : "/console"; // no open redirect
  const safeNext = extensionNextPath(next) ?? consoleNext;
  // The wallet list is the network's of the address this page is opened at; the session it starts is too.
  const network = await softRequestNetwork();
  return (
    <WalletProvider network={network}>
      <Container>
        <div className="mx-auto my-6 max-w-lg rounded-3xl border border-line bg-surface p-6 sm:my-10 sm:p-8">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-gold-ink">Console</p>
          <h1 className="mt-3 text-3xl font-light tracking-tight">Sign in with your NEAR wallet</h1>
          <SignInIntro network={network} />
          <p className="mt-3 mb-6 text-mute">
            Your wallet signs a message (NEP-413). This is not a transaction: it moves no funds and
            adds no keys. Pick your wallet from the list.
          </p>
          <SignInButton next={safeNext} />
          <JustLooking />
        </div>
      </Container>
    </WalletProvider>
  );
}
