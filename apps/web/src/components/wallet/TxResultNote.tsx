import { AccountLink, Badge, TxLink } from "@/components/ui";
import type { Network } from "@/lib/config";
import {
  type DescribeResult,
  describeTxResult,
  type TxResult,
  withWords,
} from "@/lib/near/outcome";

/**
 * What the owner reads after a wallet call. An unknown outcome says "Sent: confirm on the
 * explorer" and links to the transaction (or, when the wallet gave no hash, to the signer's
 * account page where it would appear). It never says failed and never invites another attempt:
 * the transaction may have run.
 *
 * `describe` lets a wrapper set the words (headline, detail) for a result, live or read back after a
 * reload; it cannot change the tone or the link. If it throws, our words are shown.
 *
 * On its own it is a status region. `inRegion` drops that role, for a note inside a widget's own region (TxButton's),
 * which already reads it out: a live region inside another would be read twice. TxButton also sets it on a lock read
 * back after a reload, which it shows beside its region: that note is not news, so nothing reads it out.
 */
export function TxResultNote({
  result,
  network,
  account,
  describe: wording,
  inRegion = false,
}: {
  result: TxResult;
  network: Network;
  /** The account that signed, for the explorer link when there is no transaction hash. */
  account?: string | null;
  describe?: DescribeResult;
  /** The note sits in its widget's own status region (or is not to be read out), so it has no role of its own. */
  inRegion?: boolean;
}) {
  let words: ReturnType<DescribeResult>;
  try {
    words = wording?.(result);
  } catch {
    words = undefined;
  }
  const view = withWords(describeTxResult(result), words);
  return (
    <p className="mt-1 text-xs" role={inRegion ? undefined : "status"}>
      <Badge tone={view.tone}>{view.headline}</Badge>{" "}
      {view.explorer === "tx" && result.txHash ? (
        <TxLink network={network} hash={result.txHash} />
      ) : null}
      {view.explorer === "account" && account ? (
        <AccountLink network={network} account={account} />
      ) : null}
      {view.detail ? <span className="mt-1 block text-mute">{view.detail}</span> : null}
    </p>
  );
}
