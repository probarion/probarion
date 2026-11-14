import Link from "next/link";
import c from "@/components/site/canary.module.css";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import s from "@/components/site/site.module.css";
import u from "@/components/site/usage.module.css";
import { brandCardClass, ExternalLink, linePillClass } from "@/components/ui";
import { thousands } from "@/lib/canary/format";
import type { Network } from "@/lib/config";
import { REPO_URL } from "@/lib/proof/cli";
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
  SEGMENTS,
  type Segment,
  type SegmentCounts,
  shownSegments,
  type UsageTotal,
} from "@/lib/usage/view";

const H = USAGE_COPY.head;
const T = USAGE_COPY.tiles;
const M = USAGE_COPY.table;
const C = USAGE_COPY.costs;

/** The pilot form: a GitHub issue form (.github/ISSUE_TEMPLATE/pilot.yml), so the issue it opens is public. */
export const PILOT_FORM_URL = `${REPO_URL}/issues/new?template=pilot.yml`;

/** Where the unit costs and the pilots card point: the costs measured on mainnet, and the pilot form. */
export const POINTERS = {
  gasMeasured: "measured on mainnet, see What it costs",
  pilot: "Run a pilot",
  pilotNote: "The form opens a GitHub issue, which is public.",
} as const;

/** The segment columns, with the heading each one has in the tables. */
const COLUMNS: readonly { segment: Segment; heading: string }[] = [
  { segment: "team", heading: M.team },
  { segment: "external", heading: M.external },
  { segment: "canary", heading: M.canary },
];

/** The columns of the segments shown (shownSegments), in the tables' order. */
const columnsOf = (segments: readonly Segment[]) =>
  COLUMNS.filter(({ segment }) => segments.includes(segment));

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
        <Link className={linePillClass} href="/canary?via=usage">
          {H.canary}
        </Link>
        {network === "testnet" ? <span className={c.statePill}>{H.testnetPill}</span> : null}
      </div>
    </header>
  );
}

/** A count with its label. A zero is drawn smaller than a count, so that what has happened leads the page. */
export function Tile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className={c.tile}>
      <p className={c.tileLabel}>{label}</p>
      <p className={value === 0 ? u.counts : c.tileValue}>{thousands(value)}</p>
      <p className={c.tileSub}>{sub}</p>
    </div>
  );
}

/**
 * The people-and-vault counts. Canary participants are "at least": the page cannot tell one person with two browsers and
 * two addresses from two people, so it shows the smaller of the two counts and says so. The two outside counts are
 * shown once they are above zero and left out until then: a count of people who have not come yet is not drawn as a
 * zero. The team's vaults are always shown, counted apart.
 */
export function UsageTiles({ usage }: { usage: UsageMetrics }) {
  return (
    <div className={`${c.tiles} ${u.tiles}`}>
      {usage.external_owners > 0 ? (
        <Tile label={T.owners.label} value={usage.external_owners} sub={T.owners.sub} />
      ) : null}
      {usage.canary_participants > 0 ? (
        <Tile
          label={T.participants.label}
          value={usage.canary_participants}
          sub={T.participants.sub}
        />
      ) : null}
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

/** The counts by segment: the team's column, and an outside one only once it has a count (shownSegments). */
export function UsageTable({ usage }: { usage: UsageMetrics }) {
  const rows = buildUsageTable(usage.totals, usage.recent);
  const columns = columnsOf(shownSegments(usage));
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{M.title}</h2>
      <ScrollRegion label={M.tableLabel} className={c.scroll}>
        <table className={`${c.table} ${u.usage}`}>
          <thead>
            <tr>
              <th scope="col">{M.metric}</th>
              {columns.map(({ segment, heading }) => (
                <th key={segment} scope="col" className={c.num}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.metric}>
                <th scope="row">
                  {row.indent ? <span className={u.indent}>{row.label}</span> : row.label}
                </th>
                {columns.map(({ segment }) => (
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
 * and the hosting row says that it is not published yet instead of showing a guess. The gas row points at What it costs
 * (MainnetSections.tsx), where the gas each mainnet spend burned is shown with its reading. Its columns are the segments
 * the table shows (`segments`, every one when not given), so an outside segment has no column of empty cells here either.
 */
export function UnitCostsCard({
  totals,
  price,
  segments = SEGMENTS,
}: {
  totals: readonly UsageTotal[];
  price: NearAiPrice | null;
  segments?: readonly Segment[];
}) {
  const columns = columnsOf(segments);
  const per = columns.map(({ segment }) => perDecision(totals, segment, price));
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{C.title}</h2>
      <ScrollRegion label={C.tableLabel} className={c.scroll}>
        <table className={`${c.table} ${u.usage}`}>
          <thead>
            <tr>
              <th scope="col">{C.unit}</th>
              {columns.map(({ segment, heading }) => (
                <th key={segment} scope="col" className={c.num}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{C.tokens}</th>
              {columns.map(({ segment }, i) => (
                <td key={segment} className={c.num}>
                  {tokensCell(per[i]?.tokensPerDecision ?? null)}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">{C.usd}</th>
              {price === null ? (
                <td colSpan={columns.length} className={`${c.num} ${c.quiet}`}>
                  {C.usdUnset}
                </td>
              ) : (
                columns.map(({ segment }, i) => {
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
              <th scope="row">{C.gas}</th>
              <td colSpan={columns.length} className={c.num}>
                <a className={c.link} href="#costs">
                  {POINTERS.gasMeasured}
                </a>
              </td>
            </tr>
            <tr>
              <th scope="row">{C.hosting}</th>
              <td colSpan={columns.length} className={`${c.num} ${c.quiet}`}>
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

/**
 * The pilots of each cohort that has one, and the names of those who agreed in writing to be named (and only those). A
 * cohort with no pilot is left out, and with none at all the card has no count line: it offers the pilot form.
 */
export function PilotsCard({ pilots, names }: { pilots: SegmentCounts; names: readonly string[] }) {
  const line = pilotsLine(pilots);
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>
        {line === null ? USAGE_COPY.pilots.titleNone : USAGE_COPY.pilots.title}
      </h2>
      {line === null ? null : <p className={u.counts}>{line}</p>}
      {names.length > 0 ? (
        <p className={u.names}>
          {USAGE_COPY.pilots.named} {names.join(", ")}
        </p>
      ) : null}
      <p className={c.line}>
        <ExternalLink className={c.link} href={PILOT_FORM_URL}>
          {POINTERS.pilot}
        </ExternalLink>
        . {POINTERS.pilotNote}
      </p>
    </section>
  );
}

/** What the page says when its numbers cannot be read. The header and the definitions stay. */
export function Unavailable() {
  return (
    <section className={brandCardClass}>
      <p className="max-w-measure">{UNAVAILABLE}</p>
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
