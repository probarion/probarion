import Link from "next/link";
import { RouteLink } from "@/components/RouteLink";
import {
  ATTESTED,
  type AttestedCell,
  type EvidenceSlot,
  JOURNEY_IDS,
  STORY,
  type StoryInvoice,
} from "@/lib/site/facts";
import { KeepRich, Outcome, type OutcomeTone, PartHead } from "./bits";
import j from "./journey.module.css";
import { Away, Parts } from "./parts";
import s from "./site.module.css";

/**
 * The tables' roles, said out loud. They are redundant on paper, but the stylesheet turns both tables into grids and
 * blocks below 900px and 620px, and some readers (Safari) then drop their table semantics: an explicit role keeps
 * them. They are spread from here because Biome's noRedundantRoles reads the markup, not the stylesheet.
 */
const ROLE = {
  table: { role: "table" },
  rowgroup: { role: "rowgroup" },
  row: { role: "row" },
  columnheader: { role: "columnheader" },
  rowheader: { role: "rowheader" },
  cell: { role: "cell" },
} as const;

/** Each verifier result with the mark the ledger test gives a check: a pass a dot, a check not run or not shown none. */
const RESULT_TONE: Readonly<Record<AttestedCell["result"], OutcomeTone>> = {
  Pass: "paid",
  "Not run": "none",
  "Not shown": "none",
};

/** One evidence slot: its name, then its links, or the words that say why it has none. */
function Slot({ name, slot, mono }: { name: string; slot: EvidenceSlot; mono: boolean }) {
  return (
    <div>
      <dt>{name}</dt>
      {typeof slot === "string" ? (
        <dd className={j.none}>{slot}</dd>
      ) : (
        slot.map((l) => (
          <dd key={l.url}>
            {mono ? (
              <Away
                className={j.evLink}
                href={l.url}
                tx={l.verb === undefined ? l.label : `${l.verb} ${l.label}`}
              />
            ) : (
              <Away className={j.evLink} href={l.url} label={l.label} />
            )}
          </dd>
        ))
      )}
    </div>
  );
}

function InvoiceRow({ card }: { card: StoryInvoice }) {
  return (
    <tr className={j.invRow} {...ROLE.row}>
      <th className={j.invTh} scope="row" {...ROLE.rowheader}>
        <span className={j.idWrap}>
          <span className={j.invId}>{card.invoice}</span>
          {card.again === undefined ? null : <span className={j.again}>{card.again}</span>}
        </span>
        <Outcome tone={card.tone} className={j.invOut}>
          {card.outcome}
        </Outcome>
      </th>
      <td className={j.asked} {...ROLE.cell}>
        <KeepRich text={card.asks} />
      </td>
      <td className={j.what} {...ROLE.cell}>
        <KeepRich text={card.body} />
      </td>
      <td {...ROLE.cell}>
        <dl className={j.evl}>
          <Slot name={STORY.slots.invoice} slot={card.evidence.invoice} mono={false} />
          <Slot name={STORY.slots.tx} slot={card.evidence.tx} mono />
          <Slot name={STORY.slots.ledger} slot={card.evidence.ledger} mono={false} />
        </dl>
      </td>
    </tr>
  );
}

/** The four invoices as one table: the same columns, and the same three evidence slots, on every row. */
function Invoices() {
  return (
    <table className={j.inv} aria-labelledby={JOURNEY_IDS.invoices} {...ROLE.table}>
      <colgroup>
        <col className={j.colId} />
        <col className={j.colAsk} />
        <col className={j.colWhat} />
        <col className={j.colEv} />
      </colgroup>
      <thead className={j.invHead} {...ROLE.rowgroup}>
        <tr {...ROLE.row}>
          {[STORY.head.invoice, STORY.head.asks, STORY.head.happened, STORY.head.evidence].map(
            (h) => (
              <th key={h} scope="col" {...ROLE.columnheader}>
                {h}
              </th>
            ),
          )}
        </tr>
      </thead>
      <tbody {...ROLE.rowgroup}>
        {STORY.invoices.map((card) => (
          <InvoiceRow key={`${card.invoice} ${card.again ?? ""}`} card={card} />
        ))}
      </tbody>
    </table>
  );
}

/**
 * A result word with its mark, the words set the same whether it passes or says what was not run or shown, then what
 * it rests on; a second run of the same check is a line of its own under it.
 */
function Result({ cell }: { cell: AttestedCell }) {
  return (
    <>
      <span className={j.resultLine}>
        <Outcome tone={RESULT_TONE[cell.result]} className={j.result}>
          {cell.result}
        </Outcome>
        <Parts parts={cell.detail} />
      </span>
      {cell.more === undefined ? null : (
        <span className={j.resultLine}>
          <Parts parts={cell.more} />
        </span>
      )}
    </>
  );
}

/** The attested decisions on testnet: one row per check, one column per ledger. */
function Attested() {
  const titleId = `${JOURNEY_IDS.attested}-title`;
  return (
    <div className={j.att} id={JOURNEY_IDS.attested}>
      <PartHead title={ATTESTED.title} id={titleId} note={<KeepRich text={ATTESTED.caption} />} />
      <table className={j.matrix} aria-labelledby={titleId} {...ROLE.table}>
        <colgroup>
          <col className={j.colCheck} />
          <col className={j.colCanary} />
          <col className={j.colDemo} />
        </colgroup>
        <thead {...ROLE.rowgroup}>
          <tr {...ROLE.row}>
            <th className={j.checkHead} scope="col" {...ROLE.columnheader}>
              {ATTESTED.checkHead}
            </th>
            {ATTESTED.ledgers.map((l) => (
              <th key={l.short} scope="col" {...ROLE.columnheader}>
                <Parts parts={l.name} />
                <span className={j.sub}>
                  <Parts parts={l.sub} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody {...ROLE.rowgroup}>
          {ATTESTED.rows.map((row) => {
            const [only] = row.cells;
            const cells = ATTESTED.ledgers.map((ledger, i) => ({ ledger, cell: row.cells[i] }));
            return (
              <tr key={row.check} {...ROLE.row}>
                <th scope="row" {...ROLE.rowheader}>
                  {row.check}
                </th>
                {row.cells.length === 1 && only !== undefined ? (
                  <td
                    className={j.spanAll}
                    colSpan={ATTESTED.ledgers.length}
                    aria-colspan={ATTESTED.ledgers.length}
                    {...ROLE.cell}
                  >
                    <Result cell={only} />
                  </td>
                ) : (
                  cells.map(({ ledger, cell }) => (
                    <td key={ledger.short} {...ROLE.cell}>
                      {/* On a phone the column heads have scrolled away: each cell names its ledger. */}
                      <span className={j.cellLabel} aria-hidden="true">
                        {ledger.short}
                      </span>
                      {cell === undefined ? null : <Result cell={cell} />}
                    </td>
                  ))
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={j.attFoot}>
        <p>
          <span className={j.lead}>{ATTESTED.paid.lead}</span>{" "}
          <KeepRich text={ATTESTED.paid.text} />{" "}
          <span className={j.txs}>
            {ATTESTED.paid.txs.map((t) => (
              <Away
                key={t.tx.hash}
                className={j.evLink}
                href={t.tx.url}
                tx={`${t.label}, ${t.tx.label}`}
              />
            ))}
          </span>
        </p>
        <p>
          <RouteLink route={ATTESTED.more.route} className={s.link}>
            {ATTESTED.more.label}
          </RouteLink>
        </p>
      </div>
    </div>
  );
}

/**
 * The journey as it ran on NEAR testnet, after the five steps: the demo vault's four invoices, the attested decisions
 * of two testnet ledgers, and the demo vault's proof page.
 */
export function JourneyRecord() {
  return (
    <div className={j.record} id={JOURNEY_IDS.record}>
      <PartHead
        label={STORY.eyebrow}
        title={STORY.title}
        id={JOURNEY_IDS.invoices}
        note={
          <>
            {STORY.caption} <KeepRich text={STORY.intro} />
          </>
        }
      />
      <Invoices />
      <Attested />
      <div className={j.proofRow}>
        <p className={j.proofText}>{STORY.proof.text}</p>
        <Link className={s.btn} href={STORY.proof.href}>
          {STORY.proof.label} <span aria-hidden="true">→</span>
        </Link>
        <Away className={`${s.link} ${j.quiet}`} href={STORY.files.url} label={STORY.files.label} />
      </div>
    </div>
  );
}
