import { BAND, NUMBERS, SPEND_REQUEST_FIELDS } from "@/lib/site/facts";
import { KeepRich, LIST } from "./bits";
import { ScrollRegion } from "./ScrollRegion";
import s from "./site.module.css";

/**
 * The payee panel (#payee, which the Canary page links to), at the end of the problem: an inset ink panel with the
 * heading, why a forged invoice cannot add a payee, and the fields of `SpendRequest` with `recipient` struck out; beside
 * them the three numerals that say the same in counts (NUMBERS, all but the verifier's checks, which the ledger test
 * shows in its result).
 */
export function InkBand() {
  return (
    <div className={s.payeePanel} id="payee">
      <div className={s.payeeMain}>
        <h3 className={s.payeeTitle}>{BAND.title}</h3>
        <p className={s.payeeBody}>
          <KeepRich text={BAND.body} />
        </p>
        <ScrollRegion className={s.struct} label={`The ${BAND.structName} fields`}>
          <span className={s.structName}>{`${BAND.structName} {`}</span>
          {SPEND_REQUEST_FIELDS.map((field) => (
            <span key={field} className={s.structField}>
              {field}
            </span>
          ))}
          <span className={s.structField}>
            <span className={s.structGone}>{BAND.gone}</span>
            <span className={s.structNote}>{BAND.goneNote}</span>
          </span>
          <span className={s.structMuted}>{"}"}</span>
        </ScrollRegion>
      </div>
      <ul className={s.numerals} {...LIST}>
        {NUMBERS.slice(0, 3).map(({ name, value, rest }) => (
          <li key={name}>
            <b>{value}</b>
            <span className={s.numeralText}>
              <strong>{name}</strong>
              <KeepRich text={rest} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
