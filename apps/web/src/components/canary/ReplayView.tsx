import Link from "next/link";
import c from "@/components/site/canary.module.css";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import { brandCardClass, ExternalLink, TxLink } from "@/components/ui";
import { CANARY_COPY, replayRows } from "@/lib/canary/copy";
import { utcMinute } from "@/lib/canary/format";
import { REPLAY, type ReplayEntry } from "@/lib/canary/replay";
import type { Banner } from "@/lib/canary/view";
import { LINKS } from "@/lib/site/facts";
import { Chip } from "./Chip";

const R = CANARY_COPY.replay;

/**
 * Cut line 7 of the spec: the Canary falls back to a replay of recorded attacks. It shows when the live Canary is paused,
 * when a replay is chosen, when the live one is not open and when its ledger is full, and the banner says which. Under
 * the banner, what a visitor can do instead with no wallet. The list is `REPLAY`, the team's own runs, which the owner
 * records in content/attack-replay.json; an empty list draws no card.
 */
export function ReplayView({
  banner,
  entries = REPLAY,
}: {
  banner: Banner;
  entries?: readonly ReplayEntry[];
}) {
  return (
    <div>
      <p role="status" className={c.banner}>
        <b>{R[banner]}</b>
        {entries.length > 0 ? ` ${replayRows(entries)}` : null}
      </p>
      <p className={c.meanwhile}>
        {R.meanwhile}{" "}
        <Link className={c.link} href={R.tamperHref}>
          {R.tamper}
        </Link>{" "}
        {R.noWallet} ·{" "}
        <ExternalLink className={c.link} href={LINKS.x}>
          {R.follow}
        </ExternalLink>{" "}
        {R.followTail}
      </p>
      {entries.length === 0 ? null : (
        <section className={brandCardClass}>
          <h2 className={c.cardTitle}>{R.title}</h2>
          <ScrollRegion label={R.tableLabel} className={c.scroll}>
            <table className={c.table}>
              <thead>
                <tr>
                  <th scope="col">{R.when}</th>
                  <th scope="col">{R.technique}</th>
                  <th scope="col">{R.tried}</th>
                  <th scope="col">{R.stoppedBy}</th>
                  <th scope="col">{R.tx}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((r, i) => (
                  // Two entries may share a time and a result, so the position is part of the key.
                  // biome-ignore lint/suspicious/noArrayIndexKey: the list is a file, replaced whole.
                  <tr key={`${r.at}-${r.result}-${i}`}>
                    <td>{utcMinute(r.at)}</td>
                    <td>
                      <code>{r.technique}</code>
                    </td>
                    <td className={c.wide}>{r.summary}</td>
                    <td>
                      <Chip tone="good">{`${r.layer}: ${r.result}`}</Chip>
                    </td>
                    <td>
                      {r.tx_hash ? (
                        <TxLink network={r.network} hash={r.tx_hash} />
                      ) : (
                        <span className={c.quiet}>{R.noTx}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </section>
      )}
    </div>
  );
}
