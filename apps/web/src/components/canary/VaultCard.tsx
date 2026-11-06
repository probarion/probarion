import c from "@/components/site/canary.module.css";
import { AccountLink, brandCardClass } from "@/components/ui";
import { baseLine, CANARY_COPY, mandateParts, tokenNoun } from "@/lib/canary/copy";
import type { VaultSummary } from "@/lib/canary/vault";
import type { Network } from "@/lib/config";

const V = CANARY_COPY.vault;

function MandateText({ line, noun }: { line: VaultSummary["mandate"]; noun: string }) {
  if (line.kind === "unreadable")
    return <p className={`${c.line} ${c.unreadable}`}>{V.unreadable}</p>;
  if (line.kind === "none") return <p className={c.line}>{V.noMandate}</p>;
  const { lead, payee, tail } = mandateParts(line, noun);
  return (
    <p className={c.line}>
      {lead} <span className="mono">{payee}</span>
      {tail}
    </p>
  );
}

/**
 * The Canary vault as the chain shows it now. A read that failed says so: it is never drawn as a zero balance or as a
 * vault with no mandate.
 */
export function VaultCard({
  network,
  vault,
  summary,
}: {
  network: Network;
  vault: string;
  summary: VaultSummary;
}) {
  const noun = tokenNoun(network);
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{V.title}</h2>
      {summary.balance === null ? (
        <p className={c.unreadable}>{V.unreadable}</p>
      ) : (
        <p className={c.balance}>
          {summary.balance}
          <small> {noun}</small>
        </p>
      )}
      {summary.base === null ? null : <p className={c.muted}>{baseLine(summary.base, noun)}</p>}
      <p className={c.line}>
        {V.account} <AccountLink network={network} account={vault} />
      </p>
      <MandateText line={summary.mandate} noun={noun} />
    </section>
  );
}
