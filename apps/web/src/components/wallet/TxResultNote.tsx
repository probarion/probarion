import { AccountLink, Badge, TxLink } from "@/components/ui";
import type { Network } from "@/lib/config";
import { describeTxResult, type TxResult } from "@/lib/near/outcome";

/**
 * What the owner reads after a wallet call. An unknown outcome says "Sent: confirm on the
 * explorer" and links to the transaction (or, when the wallet gave no hash, to the signer's
 * account page where it would appear). It never says failed and never invites another attempt:
 * the transaction may have run.
 */
export function TxResultNote({
  result,
  network,
  account,
}: {
  result: TxResult;
  network: Network;
  /** The account that signed, for the explorer link when there is no transaction hash. */
  account?: string | null;
}) {
  const view = describeTxResult(result);
  return (
    <p className="mt-1 text-xs" role="status">
      <Badge tone={view.tone}>{view.headline}</Badge>{" "}
      {view.explorer === "tx" && result.txHash ? (
        <TxLink network={network} hash={result.txHash} />
      ) : null}
      {view.explorer === "account" && account ? (
        <AccountLink network={network} account={account} />
      ) : null}
      {view.detail ? <span className="mt-1 block text-stone-600">{view.detail}</span> : null}
    </p>
  );
}
