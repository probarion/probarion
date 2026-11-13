import Link from "next/link";
import { ExternalLink } from "@/components/ui";
import { CHAIN, CLOSING, EVALUATE_ROUTE, LINKS, STATUS, type StatusTone } from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";
import { NextStep } from "./NextStep";
import { Rich } from "./Rich";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

const TONE: Readonly<Record<StatusTone, string | undefined>> = {
  live: s.live,
  work: s.work,
  plan: s.plan,
};

export function ChainList() {
  return (
    <LandingSection
      id="chain"
      head={{ eyebrow: CHAIN.eyebrow, title: CHAIN.title, lede: CHAIN.intro }}
    >
      {CHAIN.rows.map(({ title, body, tx }) => (
        <div key={tx.hash} className={s.tx}>
          <h3>{title}</h3>
          <p>
            <Rich text={body} />
          </p>
          <ExternalLink className={`${s.link} ${s.txHash}`} href={tx.url}>
            {tx.label}
          </ExternalLink>
        </div>
      ))}
    </LandingSection>
  );
}

export function StatusList() {
  return (
    <section className={`${s.section} ${s.flush}`} id="status">
      <div className={s.wrap}>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{STATUS.title}</h2>
        </div>
        <div className={s.status}>
          {STATUS.rows.map(({ row, pill, tone }) => (
            <div key={row} className={s.statusRow}>
              <span>{row}</span>
              <span className={`${s.pill} ${TONE[tone]}`}>{pill}</span>
            </div>
          ))}
        </div>
        <p className={s.statusNote}>
          <Rich text={STATUS.checked} />
        </p>
        <h3 className={s.gapsTitle} id={STATUS.gaps.id}>
          {STATUS.gaps.title}
        </h3>
        <ul className={s.gaps}>
          <li>
            {STATUS.gaps.auditBefore}
            <ExternalLink className={s.link} href={LINKS.security}>
              {STATUS.gaps.auditLink}
            </ExternalLink>
            <Rich text={STATUS.gaps.auditAfter} />
          </li>
          <li>
            <Rich text={STATUS.gaps.v0} />
          </li>
        </ul>
      </div>
    </section>
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
          <Rich text={CLOSING.live} />
        </p>
        <div className={s.cta}>
          <Link className={`${s.btn} ${s.solid} ${s.big}`} href={EVALUATE_ROUTE}>
            {CLOSING.evaluate}
          </Link>
          <ExternalLink className={`${s.btn} ${s.big}`} href={LINKS.spec}>
            {CLOSING.spec}
          </ExternalLink>
        </div>
        <NextStep step={NEXT_STEP.closing} className={s.closeNext} linkClassName={s.link} />
      </div>
    </section>
  );
}
