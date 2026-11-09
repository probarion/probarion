import type { Metadata } from "next";
import { ConnectedBrowsers } from "@/components/extension/ConnectedBrowsers";
import { ConnectPanel } from "@/components/extension/ConnectPanel";
import { Container } from "@/components/site/Container";
import { Card, Notice } from "@/components/ui";
import { requireSession } from "@/lib/auth/guard";
import { serviceDb } from "@/lib/db/clients";
import { listTokens } from "@/lib/ext/store";
import { readNonce } from "@/lib/ext/token";

export const metadata: Metadata = { title: "Browser extension" };
export const dynamic = "force-dynamic";

/**
 * Where the Probarion extension connects (spec §4.5). The extension opens it as `/extension?nonce=…`; Connect mints a
 * token and posts it to this window for the extension's content script. Show a code is the fallback. Signed out, the
 * visitor signs in first and comes back with the same nonce.
 */
export default async function ExtensionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nonce = readNonce((await searchParams).nonce);
  const session = await requireSession(nonce === null ? "/extension" : `/extension?nonce=${nonce}`);
  const items = await listTokens(serviceDb(), session.accountId, session.network);
  return (
    <Container>
      <div className="max-w-5xl">
        <h1 className="mb-2 text-2xl font-semibold">Browser extension</h1>
        <p className="mb-6 text-sm text-mute">
          The extension will send invoices to wait for your confirmation and show what waits for
          you, but it can't pay or approve: an invoice it sends will be paid only after you confirm
          it in the console with your wallet.
        </p>
        <Notice tone="info">The Probarion extension for Chrome is not released yet.</Notice>
        <Card title="Connect this browser">
          <ConnectPanel nonce={nonce} account={session.accountId} network={session.network} />
        </Card>
        <Card title="Connected browsers">
          <ConnectedBrowsers items={items} />
        </Card>
      </div>
    </Container>
  );
}
