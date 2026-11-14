import Link from "next/link";
import { type BoardStamp, CONSOLE_SHOTS } from "@/lib/site/facts";
import { KeepRich, LIST, Mark } from "./bits";
import c from "./console.module.css";
import m from "./integrate.module.css";
import { Away } from "./parts";
import p from "./parts.module.css";
import s from "./site.module.css";

const NBSP = " ";

/** The figure's heading, which names it. */
const TITLE_ID = "integrate-invoice";

/** A stamp's tone: the page's pairs (integrate.module.css), ok for paid, wait for held, plan for no model. */
const STAMP: Readonly<Record<BoardStamp["tone"], string | undefined>> = {
  paid: m.stampPaid,
  held: m.stampHeld,
  none: m.stampNone,
};

/** A row's stamps, each with its mark; the full stop after each is for a screen reader, as on the uses' cards. */
function Stamps({ stamps }: { stamps: readonly BoardStamp[] }) {
  return (
    <p className={m.stamps}>
      {stamps.map((x) => (
        <span key={x.label} className={`${m.stamp} ${STAMP[x.tone]}`}>
          <Mark tone={x.tone} />
          {x.label}
          <span className="sr-only">.</span>
        </span>
      ))}
    </p>
  );
}

/** The invoice as a sheet of paper: its number, its total, the recorded fields and the owner's signed confirm. */
function Sheet() {
  const B = CONSOLE_SHOTS.landing.board;
  const inv = B.invoice;
  return (
    <div className={c.doc}>
      <p className={p.label}>{B.sheetLabel}</p>
      <article className={c.sheet} aria-label={`${inv.kind} ${inv.number}`}>
        <div className={c.sheetTop}>
          <p className={p.label}>{inv.kind}</p>
          <p className={m.net}>{inv.network}</p>
        </div>
        <p className={c.invNo}>
          <KeepRich text={inv.number} />
        </p>
        <p className={c.invIds}>
          <code>{inv.file}</code> <code>{inv.ref}</code>
        </p>
        <div className={c.due}>
          <p className={p.label}>{inv.totalLabel}</p>
          <p className={c.dueAmount}>
            <span className={c.dueNum}>{inv.total}</span>{" "}
            <span className={c.dueUnit}>{inv.unit}</span>
          </p>
        </div>
        <dl className={c.rows}>
          {inv.rows.map((r) => (
            <div key={r.term}>
              <dt>{r.term}</dt>
              <dd>
                <KeepRich text={r.value} />
              </dd>
            </div>
          ))}
          <div>
            <dt>{inv.hash.term}</dt>
            <dd>
              <code title={inv.hash.value}>{inv.hash.short}</code>
            </dd>
          </div>
        </dl>
        <div className={c.sig}>
          <p className={c.sigLabel}>
            <Mark tone="paid" />
            {B.confirm.label}
          </p>
          <p className={c.sigWho}>
            <code title={B.confirm.owner}>{B.confirm.short}</code>
          </p>
          <p className={c.sigMeta}>{B.confirm.meta}</p>
        </div>
      </article>
      <p className={c.docNote}>{B.note}</p>
    </div>
  );
}

/** The code's rules, folded under a pill that says whether it opens or closes: a native details, so no script. */
function Rules() {
  const R = CONSOLE_SHOTS.landing.board.rules;
  return (
    <details className={c.rules}>
      <summary className={c.rulesSummary}>
        <span className={c.whenShut}>{R.show}</span>
        <span className={c.whenOpen}>{R.hide}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <ol className={c.ruleList} {...LIST}>
        {R.list.map((r) => (
          <li key={r.id} className={p.outPaid}>
            <Mark tone="paid" />
            <span className={c.ruleId}>
              <code>{r.id}</code>
              <span className="sr-only">{R.passed}</span>
            </span>{" "}
            <span className={c.ruleWhat}>
              <KeepRich text={r.text} />
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** What happened to the invoice: the console page's three columns as rows, each a sentence and its proof. */
function Verdicts() {
  const B = CONSOLE_SHOTS.landing.board;
  return (
    <div className={c.verdicts}>
      <span className={c.handoff} aria-hidden="true">
        <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
          <path
            d="M2 7h9M7.5 3.5 11 7l-3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <p className={p.label}>{B.rowsLabel}</p>
      <ol className={c.vlist} {...LIST}>
        {B.rows.map((r) => (
          <li key={r.label} className={c.vrow}>
            <div className={c.vhead}>
              <h4 className={p.label}>{r.label}</h4>
              <Stamps stamps={r.stamps} />
            </div>
            <div className={c.vbody}>
              <p className={c.vtext}>
                <KeepRich text={r.text} />
              </p>
              <p className={c.vlinks}>
                {r.entry === undefined ? null : (
                  <Link className={`${s.link} ${c.vlink}`} href={r.entry.href}>
                    {r.entry.label}
                    {NBSP}
                    <span aria-hidden="true">→</span>
                  </Link>
                )}
                {(r.txs ?? []).map((t) => (
                  <Away key={t.url} className={`${s.link} ${c.vlink}`} href={t.url} tx={t.label} />
                ))}
              </p>
            </div>
            {r.rules === true ? <Rules /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The console on the landing, in the use cases (Integrate.tsx) after the three uses: INV-2004's page in Payables on
 * the testnet demo vault, redrawn from its record as one board, so the page loads no image for it. The caption leads:
 * what it is, then the record the console was captured under, the screenshot itself and the console. Then the board:
 * the invoice on the left (above on a phone), and what the model, the code and the contract did with it on the right,
 * the code's rules in a fold. A server component with no script.
 */
export function ConsoleShot() {
  const L = CONSOLE_SHOTS.landing;
  const shot = CONSOLE_SHOTS.shots.find((x) => x.id === L.shot);
  if (shot === undefined) return null;
  return (
    <figure className={c.figure} aria-labelledby={TITLE_ID}>
      <figcaption className={c.cap}>
        <div className={c.capText}>
          <p className={s.eyebrow}>{L.eyebrow}</p>
          {/* A heading of the use cases, between the uses' h3s and the ways' h3: what the board shows. */}
          <h3 className={c.title} id={TITLE_ID}>
            {L.title}
          </h3>
          <p className={c.body}>
            <KeepRich text={L.body} />
          </p>
        </div>
        <div className={c.capSide}>
          <dl className={c.record}>
            {CONSOLE_SHOTS.record.map((r) => (
              <div key={r.term}>
                <dt>{r.term}</dt>
                <dd>
                  <KeepRich text={r.value} />
                </dd>
              </div>
            ))}
          </dl>
          <p className={c.links}>
            <a className={`${s.link} ${c.link}`} href={shot.src}>
              {L.shotLink.label}
              <span className="sr-only">{L.shotLink.after}</span>
            </a>
            <Link className={`${s.link} ${c.link}`} href={CONSOLE_SHOTS.open.href}>
              {CONSOLE_SHOTS.open.label}
              {NBSP}
              <span aria-hidden="true">→</span>
            </Link>
          </p>
        </div>
      </figcaption>
      <div className={c.board}>
        <Sheet />
        <Verdicts />
      </div>
    </figure>
  );
}
