import Link from "next/link";
import { ExternalLink } from "@/components/ui";
import { CHAIN, CLOSING, EVALUATE_ROUTE, LINKS, STATUS, type StatusTone } from "@/lib/site/facts";
import { Rich } from "./Rich";
import s from "./site.module.css";

const TONE: Readonly<Record<StatusTone, string | undefined>> = {
  live: s.live,
  work: s.work,
  plan: s.plan,
};

export function ChainList() {
  return (
    <section className={`${s.section} ${s.flush}`} id="chain">
      <div className={s.wrap}>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{CHAIN.title}</h2>
          <p>{CHAIN.intro}</p>
        </div>
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
      </div>
    </section>
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
          {STATUS.noteBefore}
          <ExternalLink className={s.link} href={LINKS.security}>
            {STATUS.noteLink}
          </ExternalLink>
          <Rich text={STATUS.noteAfter} /> <Rich text={STATUS.build} />
        </p>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section className={s.close}>
      <div className={s.wrap}>
        <h2 className={s.closeTitle}>
          <span>{CLOSING.line1}</span>
          <span className={s.gold}>{CLOSING.line2}</span>
        </h2>
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
      </div>
    </section>
  );
}
