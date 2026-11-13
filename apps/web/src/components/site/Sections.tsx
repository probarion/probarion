import Link from "next/link";
import { CHAIN, CLOSING, EVALUATE_ROUTE, LINKS } from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";
import { KeepRich, LIST, Outcome } from "./bits";
import ch from "./chain.module.css";
import { NextStep } from "./NextStep";
import { Away, Parts, TermRecord } from "./parts";
import p from "./parts.module.css";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

/**
 * The smoke run's three transactions: each row opens with its outcome, then its title and the call the agent key
 * made, what the chain shows, and the transaction on the testnet explorer. What the rows share is the head's record.
 * A short foot points to the demo vault's newer record and to v0's known gap.
 */
export function ChainList() {
  return (
    <LandingSection
      id="chain"
      head={{ eyebrow: CHAIN.eyebrow, title: CHAIN.title, lede: CHAIN.intro }}
      headAfter={<TermRecord rows={CHAIN.record} />}
    >
      <ul className={ch.rows} {...LIST}>
        {CHAIN.rows.map(({ outcome, title, call, body, tx }) => (
          <li key={tx.hash} className={ch.row}>
            <div className={ch.what}>
              <Outcome tone={outcome.tone} className={ch.out}>
                {outcome.word}
              </Outcome>
              <h3 className={ch.title}>{title}</h3>
              <p className={ch.call}>
                <KeepRich text={call} />
              </p>
            </div>
            <p className={ch.body}>
              <KeepRich text={body} />
            </p>
            <dl className={ch.ev}>
              <dt className={p.label}>{CHAIN.evidenceLabel}</dt>
              <dd>
                <Away href={tx.url} tx={tx.label} after={CHAIN.txExplorer} />
              </dd>
            </dl>
          </li>
        ))}
      </ul>
      <div className={ch.foot}>
        {CHAIN.foot.map((line) => (
          <p key={String(line[0])} className={ch.line}>
            <Parts parts={line} />
          </p>
        ))}
      </div>
    </LandingSection>
  );
}

export function Closing() {
  return (
    <section className={s.close}>
      <div className={s.wrap}>
        <h2 className={s.closeTitle}>
          <span>{CLOSING.line1}</span> <span className={s.gold}>{CLOSING.line2}</span>
        </h2>
        <p className={s.closeNote}>{CLOSING.sub}</p>
        <p className={s.closeNote}>
          <KeepRich text={CLOSING.live} />
        </p>
        <div className={s.cta}>
          <Link className={`${s.btn} ${s.solid} ${s.big}`} href={EVALUATE_ROUTE}>
            {CLOSING.evaluate}
          </Link>
          <Away className={`${s.btn} ${s.big}`} href={LINKS.spec} label={CLOSING.spec} />
        </div>
        <NextStep step={NEXT_STEP.closing} className={s.closeNext} linkClassName={s.link} />
      </div>
    </section>
  );
}
