import c from "@/components/site/canary.module.css";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import { brandCardClass, TxLink } from "@/components/ui";
import { type Board, type FeedRow, refusedOnChain } from "@/lib/canary/board";
import { CANARY_COPY, refusedSub, teamSub, visitorsSub, visitorsUnit } from "@/lib/canary/copy";
import { thousands, utcMinute } from "@/lib/canary/format";
import type { Network } from "@/lib/config";
import { Chip } from "./Chip";
import { Tally } from "./Tally";

const B = CANARY_COPY.board;
const F = CANARY_COPY.feed;

function Tile({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: number;
  unit?: string;
  sub: string;
}) {
  return (
    <div className={c.tile}>
      <p className={c.tileLabel}>{label}</p>
      <p className={c.tileValue}>
        {thousands(value)}
        {unit ? <small> {unit}</small> : null}
      </p>
      <p className={c.tileSub}>{sub}</p>
    </div>
  );
}

/**
 * The challenge's numbers: what the page can stand behind and nothing else. There is no "paid to an attacker" figure,
 * because nothing measures one; the page says what is true by construction instead (StaticCards). A scoreboard that could
 * not be read says so and shows no figure. Until an outside visitor has tried, every outside figure is a zero (the
 * techniques and the codes count outside attempts only), so the board is then the one line over the form instead.
 */
export function Scoreboard({ board }: { board: Board | null }) {
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{B.title}</h2>
      {board === null ? (
        <p className={c.muted}>{B.unavailable}</p>
      ) : board.attempts_external === 0 ? (
        <>
          {/* 20px under the line, which takes in .fresh's 12px: 2.5em or more between the two (WCAG 1.4.8). */}
          <Tally board={board} className="mb-5" />
          <p className={c.fresh}>{B.updated}</p>
        </>
      ) : (
        <>
          <div className={c.tiles}>
            <Tile
              label={B.visitorsLead}
              value={board.visitors}
              unit={visitorsUnit(board.visitors)}
              sub={visitorsSub(board.browsers, board.addresses)}
            />
            <Tile
              label={B.attempts}
              value={board.attempts_external}
              sub={teamSub(board.attempts_team)}
            />
            <Tile
              label={B.raw}
              value={board.raw_external}
              sub={refusedSub(refusedOnChain(board))}
            />
          </div>
          {board.techniques.length > 0 ? (
            <ScrollRegion label={B.tableLabel} className={c.scroll}>
              <table className={c.table}>
                <thead>
                  <tr>
                    <th scope="col">{B.technique}</th>
                    <th scope="col" className={c.num}>
                      {B.attempts}
                    </th>
                    <th scope="col" className={c.num}>
                      {B.byCode}
                    </th>
                    <th scope="col" className={c.num}>
                      {B.onChain}
                    </th>
                    <th scope="col" className={c.num}>
                      {B.held}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {board.techniques.map((t) => (
                    <tr key={t.technique}>
                      <td>
                        <code>{t.technique}</code>
                      </td>
                      <td className={c.num}>{thousands(t.attempts)}</td>
                      <td className={c.num}>{thousands(t.refused_by_code)}</td>
                      <td className={c.num}>{thousands(t.refused_by_contract)}</td>
                      <td className={c.num}>{thousands(t.held)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          ) : null}
          <div className={c.codes}>
            <span>{B.codes}</span>
            {board.contract_codes.length === 0 ? (
              <span className={c.quiet}>{B.noCodes}</span>
            ) : (
              board.contract_codes.map((code) => (
                <Chip key={code.code} tone="good">{`${code.code} ×${thousands(code.n)}`}</Chip>
              ))
            )}
          </div>
          <p className={c.fresh}>{B.updated}</p>
        </>
      )}
    </section>
  );
}

function FeedLine({ row, network }: { row: FeedRow; network: Network }) {
  const when = (
    <td>
      {utcMinute(row.created_at)}
      {row.is_team ? (
        <span className={c.team}>
          <Chip>{F.team}</Chip>
        </span>
      ) : null}
    </td>
  );
  const techniques = <td>{row.techniques.join(", ")}</td>;
  const tx = <td>{row.tx_hash ? <TxLink network={network} hash={row.tx_hash} /> : null}</td>;
  if (row.code_status === "killed") {
    return (
      <tr>
        {when}
        {techniques}
        <td colSpan={2} className={c.quiet}>
          {F.killed}
        </td>
        {tx}
      </tr>
    );
  }
  return (
    <tr>
      {when}
      {techniques}
      <td>{row.code_rule ?? row.code_status}</td>
      <td>{row.raw ? (row.contract_code ?? row.contract_status ?? "sent") : F.notSent}</td>
      {tx}
    </tr>
  );
}

/** The newest attempts. A feed that could not be read (null) is told apart from one with nothing in it. */
export function LatestAttempts({ feed, network }: { feed: FeedRow[] | null; network: Network }) {
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{F.title}</h2>
      {feed === null ? (
        <p className={c.muted}>{F.unavailable}</p>
      ) : feed.length === 0 ? (
        <p className={c.muted}>{F.empty}</p>
      ) : (
        <ScrollRegion label={F.tableLabel} className={c.scroll}>
          <table className={c.table}>
            <thead>
              <tr>
                <th scope="col">{F.when}</th>
                <th scope="col">{F.techniques}</th>
                <th scope="col">{F.code}</th>
                <th scope="col">{F.contract}</th>
                <th scope="col">{F.tx}</th>
              </tr>
            </thead>
            <tbody>
              {feed.map((row, i) => (
                // Attempts of the same minute share a time, so the position is part of the key.
                // biome-ignore lint/suspicious/noArrayIndexKey: the feed has no id, and the list is replaced whole.
                <FeedLine key={`${row.created_at}-${i}`} row={row} network={network} />
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </section>
  );
}
