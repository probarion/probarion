import Link from "next/link";
import { createElement, Fragment, type ReactNode } from "react";
import { ExternalLink } from "@/components/ui";
import {
  ATTESTED,
  type AttestedCell,
  type CopyPart,
  type EvidenceSlot,
  JOURNEY_IDS,
  STORY,
  type StoryInvoice,
  type StoryTone,
} from "@/lib/site/facts";
import j from "./journey.module.css";
import { Rich } from "./Rich";
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

/** An arrow after a link that opens in a new tab, which ExternalLink says in words. */
const NewTab = () => (
  <span className={j.ext} aria-hidden="true">
    ↗
  </span>
);

/** The end of a link and its arrow, on one line: the arrow never wraps alone onto the next one. */
const Glued = ({ children }: { children: ReactNode }) => (
  <span className={j.glue}>
    {children}
    <NewTab />
  </span>
);

/** A link's words, the part after its last space or hyphen glued to the arrow: a file name still wraps at a hyphen. */
function Label({ text }: { text: string }) {
  const cut = Math.max(text.lastIndexOf(" "), text.lastIndexOf("-")) + 1;
  return (
    <>
      {text.slice(0, cut)}
      <Glued>{text.slice(cut)}</Glued>
    </>
  );
}

/**
 * One part of a line of copy, as facts.ts writes it: text (backticks are code), a link on the page (#), a page of the
 * site (/), or a file or transaction elsewhere, which opens in a new tab.
 */
function part(p: CopyPart): ReactNode {
  if (typeof p === "string") return <Rich text={p} />;
  if (p.href.startsWith("#")) {
    return (
      <a className={s.link} href={p.href}>
        {p.label}
      </a>
    );
  }
  if (p.href.startsWith("/")) {
    return (
      <Link className={s.link} href={p.href}>
        {p.label}
      </Link>
    );
  }
  return (
    <ExternalLink className={s.link} href={p.href}>
      <Label text={p.label} />
    </ExternalLink>
  );
}

/** A line of copy with its links. Its parts are spread as children, so a line that repeats a word needs no keys. */
export function Parts({ parts }: { parts: readonly CopyPart[] }) {
  return createElement(Fragment, null, ...parts.map(part));
}

/** The outcome's mark: a dot for paid, a struck circle for refused, a half-filled circle for held. Its words say it too. */
function Mark({ tone }: { tone: StoryTone }) {
  return (
    <svg className={j.mark} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {tone === "paid" ? (
        <circle className={j.fill} cx="6" cy="6" r="5" />
      ) : (
        <>
          <circle className={j.ring} cx="6" cy="6" r="4.6" />
          {tone === "refused" ? (
            <path className={j.ring} d="M2.8 9.2 9.2 2.8" />
          ) : (
            <path className={j.fill} d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" />
          )}
        </>
      )}
    </svg>
  );
}

const OUT_TONE: Readonly<Record<StoryTone, string | undefined>> = {
  paid: j.outPaid,
  refused: j.outRefused,
  held: j.outHeld,
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
            <ExternalLink className={j.evLink} href={l.url}>
              {l.verb === undefined ? null : `${l.verb} `}
              {mono ? (
                <Glued>
                  <span className={j.mono}>{l.label}</span>
                </Glued>
              ) : (
                <Label text={l.label} />
              )}
            </ExternalLink>
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
        <span className={`${j.out} ${OUT_TONE[card.tone]}`}>
          <Mark tone={card.tone} />
          {card.outcome}
        </span>
      </th>
      <td className={j.asked} {...ROLE.cell}>
        <Rich text={card.asks} />
      </td>
      <td className={j.what} {...ROLE.cell}>
        <Rich text={card.body} />
      </td>
      <td className={j.evCell} {...ROLE.cell}>
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

/** A result word, set the same whether it passes or says what was not run or shown, then what it rests on. */
function Result({ cell }: { cell: AttestedCell }) {
  return (
    <>
      <span className={j.result}>{cell.result}</span>
      <Parts parts={cell.detail} />
    </>
  );
}

/** The attested decisions on testnet: one row per check, one column per ledger. */
function Attested() {
  const titleId = `${JOURNEY_IDS.attested}-title`;
  return (
    <div className={j.att} id={JOURNEY_IDS.attested}>
      <h3 className={j.partTitle} id={titleId}>
        {ATTESTED.title}
      </h3>
      <p className={j.attCap}>{ATTESTED.caption}</p>
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
          <span className={j.lead}>{ATTESTED.paid.lead}</span> {ATTESTED.paid.text}{" "}
          <span className={j.txs}>
            {ATTESTED.paid.txs.map((t) => (
              <ExternalLink key={t.tx.hash} className={j.evLink} href={t.tx.url}>
                {t.label},{" "}
                <Glued>
                  <span className={j.mono}>{t.tx.label}</span>
                </Glued>
              </ExternalLink>
            ))}
          </span>
        </p>
        <p>
          <Link className={s.link} href={ATTESTED.more.href}>
            {ATTESTED.more.label}
          </Link>
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
      <div className={j.recHead}>
        <div className={j.recIntro}>
          <hgroup>
            <p className={`${s.eyebrow} ${j.partLabel}`}>{STORY.eyebrow}</p>
            <h3 className={j.partTitle} id={JOURNEY_IDS.invoices}>
              {STORY.title}
            </h3>
          </hgroup>
          <p className={j.caption}>{STORY.caption}</p>
        </div>
        <p className={j.recLede}>
          <Rich text={STORY.intro} />
        </p>
      </div>
      <Invoices />
      <Attested />
      <div className={j.proofRow}>
        <p className={j.proofText}>{STORY.proof.text}</p>
        <Link className={s.btn} href={STORY.proof.href}>
          {STORY.proof.label} <span aria-hidden="true">→</span>
        </Link>
        <ExternalLink className={`${s.link} ${j.quiet}`} href={STORY.files.url}>
          <Label text={STORY.files.label} />
        </ExternalLink>
      </div>
    </div>
  );
}
