import c from "@/components/site/canary.module.css";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import { brandCardClass, TxLink } from "@/components/ui";
import { CANARY_COPY } from "@/lib/canary/copy";
import { utcMinute } from "@/lib/canary/format";
import { REPLAY, type ReplayEntry } from "@/lib/canary/replay";
import type { Banner } from "@/lib/canary/view";
import { Chip } from "./Chip";

const R = CANARY_COPY.replay;

/**
 * Cut line 7 of the spec: the Canary falls back to a replay of recorded attacks. It shows when the live Canary is paused,
 * when a replay is chosen and when the live one is not open, and the banner says which. The list is `REPLAY`, which the
 * owner records in content/attack-replay.json.
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
        <b>{R[banner]}</b> {R.rows}
      </p>
      <section className={brandCardClass}>
        <h2 className={c.cardTitle}>{R.title}</h2>
        {entries.length === 0 ? (
          <p className={c.muted}>{R.empty}</p>
        ) : (
          <ScrollRegion label={R.tableLabel} className={c.scroll}>
            <table className={c.table}>
              <thead>
                <tr>
                  <th>{R.when}</th>
                  <th>{R.technique}</th>
                  <th>{R.tried}</th>
                  <th>{R.stoppedBy}</th>
                  <th>{R.tx}</th>
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
        )}
      </section>
    </div>
  );
}
