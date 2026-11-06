import Link from "next/link";
import c from "@/components/site/canary.module.css";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import s from "@/components/site/site.module.css";
import u from "@/components/site/usage.module.css";
import { brandCardClass, linePillClass } from "@/components/ui";
import { thousands } from "@/lib/canary/format";
import type { Network } from "@/lib/config";
import {
  definitions,
  deltaText,
  EMPTY,
  eyebrow,
  pilotsLine,
  priceLine,
  tokensCell,
  UNAVAILABLE,
  USAGE_COPY,
  updatedLine,
} from "@/lib/usage/copy";
import type { UsageMetrics } from "@/lib/usage/parse";
import type { NearAiPrice } from "@/lib/usage/pricing";
import {
  buildUsageTable,
  perDecision,
  type Segment,
  type SegmentCounts,
  type UsageTotal,
} from "@/lib/usage/view";

const H = USAGE_COPY.head;
const T = USAGE_COPY.tiles;
const M = USAGE_COPY.table;
const C = USAGE_COPY.costs;

/** The segment columns, with the heading each one has in the tables. */
const COLUMNS: readonly { segment: Segment; heading: string }[] = [
  { segment: "team", heading: M.team },
  { segment: "external", heading: M.external },
  { segment: "canary", heading: M.canary },
];

export function UsageHeader({ network }: { network: Network }) {
  return (
    <header>
      <p className={s.eyebrow}>{eyebrow(network)}</p>
      <h1 className={c.title}>{H.title}</h1>
      <p className={c.lede}>{H.lede}</p>
      <div className={c.pills}>
        <a className={linePillClass} href="#definitions">
          {H.definitions}
        </a>
        <Link className={linePillClass} href="/canary">
          {H.canary}
        </Link>
        {network === "testnet" ? <span className={c.statePill}>{H.testnetPill}</span> : null}
      </div>
    </header>
  );
}

function Tile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className={c.tile}>
      <p className={c.tileLabel}>{label}</p>
      <p className={c.tileValue}>{thousands(value)}</p>
      <p className={c.tileSub}>{sub}</p>
    </div>
  );
}

/**
 * The three people-and-vault counts. Canary participants are "at least": the page cannot tell one person with two
 * browsers and two addresses from two people, so it shows the smaller of the two counts and says so.
 */
export function UsageTiles({ usage }: { usage: UsageMetrics }) {
  return (
    <div className={`${c.tiles} ${u.tiles}`}>
      <Tile label={T.owners.label} value={usage.external_owners} sub={T.owners.sub} />
      <Tile
        label={T.participants.label}
        value={usage.canary_participants}
        sub={T.participants.sub}
      />
      <Tile label={T.team.label} value={usage.team_vaults} sub={T.team.sub} />
    </div>
  );
}

/** An all-time count with, in grey, what the last 7 days added to it (only when it added something). */
function Cell({ total, week }: { total: number; week: number }) {
  return (
    <td className={c.num}>
      {thousands(total)}
      {week > 0 ? (
        <span className={u.delta}>
          {deltaText(week)}
          <span className={u.srOnly}>{M.weekHint}</span>
        </span>
      ) : null}
    </td>
  );
}

export function UsageTable({ usage }: { usage: UsageMetrics }) {
  const rows = buildUsageTable(usage.totals, usage.recent);
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{M.title}</h2>
      <ScrollRegion label={M.tableLabel} className={c.scroll}>
        <table className={`${c.table} ${u.usage}`}>
          <thead>
            <tr>
              <th scope="col">{M.metric}</th>
              {COLUMNS.map(({ segment, heading }) => (
                <th key={segment} scope="col" className={c.num}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.metric}>
                <td>{row.indent ? <span className={u.indent}>{row.label}</span> : row.label}</td>
                {COLUMNS.map(({ segment }) => (
                  <Cell key={segment} total={row[segment]} week={row.week[segment]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <p className={c.fresh}>{updatedLine(usage.updated_at)}</p>
    </section>
  );
}

/**
 * What a decision costs, from what was measured. A price in dollars appears only when `price` is set (lib/usage/pricing.ts),
 * and the gas and hosting rows say that they are not measured or published yet instead of showing a guess.
 */
export function UnitCostsCard({
  totals,
  price,
}: {
  totals: readonly UsageTotal[];
  price: NearAiPrice | null;
}) {
  const per = COLUMNS.map(({ segment }) => perDecision(totals, segment, price));
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{C.title}</h2>
      <ScrollRegion label={C.tableLabel} className={c.scroll}>
        <table className={`${c.table} ${u.usage}`}>
          <thead>
            <tr>
              <th scope="col">{C.unit}</th>
              {COLUMNS.map(({ segment, heading }) => (
                <th key={segment} scope="col" className={c.num}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{C.tokens}</td>
              {COLUMNS.map(({ segment }, i) => (
                <td key={segment} className={c.num}>
                  {tokensCell(per[i]?.tokensPerDecision ?? null)}
                </td>
              ))}
            </tr>
            <tr>
              <td>{C.usd}</td>
              {price === null ? (
                <td colSpan={COLUMNS.length} className={`${c.num} ${c.quiet}`}>
                  {C.usdUnset}
                </td>
              ) : (
                COLUMNS.map(({ segment }, i) => {
                  const usd = per[i]?.usdPerDecision ?? null;
                  return (
                    <td key={segment} className={c.num}>
                      {usd === null ? EMPTY : `$${usd.toFixed(5)}`}
                    </td>
                  );
                })
              )}
            </tr>
            <tr>
              <td>{C.gas}</td>
              <td colSpan={COLUMNS.length} className={`${c.num} ${c.quiet}`}>
                {C.gasUnset}
              </td>
            </tr>
            <tr>
              <td>{C.hosting}</td>
              <td colSpan={COLUMNS.length} className={`${c.num} ${c.quiet}`}>
                {C.hostingUnset}
              </td>
            </tr>
          </tbody>
        </table>
      </ScrollRegion>
      {price === null ? null : <p className={c.fresh}>{priceLine(price)}</p>}
      <p className={c.fresh}>{C.footnote}</p>
    </section>
  );
}

/** The pilots of each cohort, and the names of those who agreed in writing to be named (and only those). */
export function PilotsCard({ pilots, names }: { pilots: SegmentCounts; names: readonly string[] }) {
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{USAGE_COPY.pilots.title}</h2>
      <p className={u.counts}>{pilotsLine(pilots)}</p>
      {names.length > 0 ? (
        <p className={u.names}>
          {USAGE_COPY.pilots.named} {names.join(", ")}
        </p>
      ) : null}
    </section>
  );
}

/** What the page says when its numbers cannot be read. The header and the definitions stay. */
export function Unavailable() {
  return (
    <section className={brandCardClass}>
      <p>{UNAVAILABLE}</p>
    </section>
  );
}

/** How each number is counted, as plain sentences. The pills of the header link here. */
export function Definitions({ network }: { network: Network }) {
  return (
    <section id="definitions" className={brandCardClass}>
      <h2 className={c.cardTitle}>{USAGE_COPY.definitions.title}</h2>
      <ul className={u.defs}>
        {definitions(network).map((d) => (
          <li key={d.text}>
            {d.lead ? <strong>{d.lead}</strong> : null}
            {d.lead ? " " : ""}
            {d.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
