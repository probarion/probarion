import Link from "next/link";
import { ExternalLink } from "@/components/ui";
import { CHAIN, CLOSING, EVALUATE_ROUTE, LINKS } from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";
import { NextStep } from "./NextStep";
import { Rich } from "./Rich";
import s from "./site.module.css";

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
