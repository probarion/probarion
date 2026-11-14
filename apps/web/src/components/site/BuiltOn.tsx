import Link from "next/link";
import { BUILT_ON, STACK, type StackRow } from "@/lib/site/facts";
import { KeepRich, LIST } from "./bits";
import { Away } from "./parts";
import { SubHead } from "./SectionHead";
import sh from "./ships.module.css";
import s from "./site.module.css";

/** A no-break space: a link that wraps keeps its arrow on the line of its last word. */
const NBSP = " ";

/** A page of this site, in this tab, its arrow hidden from screen readers. */
function Here({ href, label }: { href: string; label: string }) {
  return (
    <Link className={s.link} href={href}>
      {label}
      {NBSP}
      <span aria-hidden="true">→</span>
    </Link>
  );
}

/** A row: its part, its sentences, then what a reader can check, each token in mono with what it names. */
function Row({ row }: { row: StackRow }) {
  return (
    <li className={sh.rest} data-row={row.id}>
      <hgroup className={sh.restHead}>
        <p className={sh.restLabel}>{row.label}</p>
        <h4 className={sh.restTitle}>{row.name}</h4>
      </hgroup>
      <div className={sh.restText}>
        <p className={sh.stackBody}>
          <KeepRich text={row.body} />
        </p>
        {row.link === undefined ? null : (
          <p className={sh.stackLink}>
            <Here href={row.link.href} label={row.link.label} />
          </p>
        )}
      </div>
      <div className={sh.tokens}>
        {row.tokensNote === undefined ? null : <p className={sh.tokensNote}>{row.tokensNote}</p>}
        <ul className={sh.tokenList} {...LIST}>
          {row.tokens.map((t) => (
            <li key={t.code} className={sh.token}>
              <code>{t.code}</code>
              {t.note === undefined ? null : (
                <span className={sh.tokenNote}>
                  <span className="sr-only">, </span>
                  {t.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

/**
 * What it rests on (id="built-on"), a block of the #verify section after the tamper test: four text rows under a rule,
 * each its part, one or two sentences, and the tokens a reader can check (an account, a command, a contract). No
 * logos. The foot says that no endorsement is implied and links the architecture page.
 */
export function Foundations() {
  const rows: readonly StackRow[] = STACK.rows;
  return (
    <SubHead id={STACK.id} eyebrow={STACK.eyebrow} title={STACK.title} lede={STACK.lede}>
      <ul className={sh.stackList} {...LIST}>
        {rows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </ul>
      <p className={sh.restFoot}>
        <span>{STACK.noEndorsement}</span>{" "}
        <Here href={STACK.architecture.href} label={STACK.architecture.label} />
      </p>
    </SubHead>
  );
}

/**
 * Where to get Probarion (id="get-probarion"), a row of the closing: each place a text link by its name, then what is
 * there in a few words. No logos.
 */
export function GetProbarion() {
  const titleId = `${BUILT_ON.shipsId}-title`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of links in the closing, not a form, so no fieldset.
    <div className={sh.get} id={BUILT_ON.shipsId} role="group" aria-labelledby={titleId}>
      <h3 className={sh.getTitle} id={titleId}>
        {BUILT_ON.shipsTitle}
      </h3>
      <ul className={sh.getList} {...LIST}>
        {BUILT_ON.ships.map((ship) => (
          <li key={ship.id} className={sh.getItem} data-ship={ship.id}>
            <Away className={`${s.link} ${sh.getLink}`} href={ship.link.href} label={ship.name} />
            <span className={sh.getDetail}>
              <span className="sr-only">: </span>
              <KeepRich text={ship.short} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The README's License line, as one line of small print in the closing. */
export function TrademarkLead() {
  return <p className={sh.legal}>{BUILT_ON.trademark.lead}</p>;
}
