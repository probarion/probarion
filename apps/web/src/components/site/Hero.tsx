import { ExternalLink } from "@/components/ui";
import { HERO, NUMBERS, PROBLEM, type TxFact } from "@/lib/site/facts";
import { Rich } from "./Rich";
import s from "./site.module.css";

function TxRow({ tx }: { tx: TxFact }) {
  return (
    <div>
      <dt>Tx</dt>
      <dd>
        <ExternalLink className={`${s.link} ${s.cardHash}`} href={tx.url}>
          {tx.label}
        </ExternalLink>
      </dd>
    </div>
  );
}

function PaidCard() {
  const c = HERO.paid;
  return (
    <article className={`${s.card} ${s.metal}`} aria-label={c.aria}>
      <div className={s.cardTop}>
        <span>{c.mandate}</span>
        <span className={s.state}>{c.state}</span>
      </div>
      <div className={s.cardBig}>{c.big}</div>
      <dl className={s.rows}>
        <div>
          <dt>Caller</dt>
          <dd>{c.caller}</dd>
        </div>
        <div>
          <dt>Payee</dt>
          <dd>{c.payee}</dd>
        </div>
        <div>
          <dt>Event</dt>
          <dd>
            <code>{c.event}</code>
          </dd>
        </div>
        <TxRow tx={c.tx} />
      </dl>
    </article>
  );
}

function RefusedCard() {
  const c = HERO.refused;
  return (
    <article className={`${s.card} ${s.obsidian}`} aria-label={c.aria}>
      <div className={s.cardTop}>
        <span>{c.mandate}</span>
        <span className={s.state}>{c.state}</span>
      </div>
      <div className={s.cardBig}>{c.big}</div>
      <dl className={s.rows}>
        <div>
          <dt>Caller</dt>
          <dd>{c.caller}</dd>
        </div>
        <div>
          <dt>Limit</dt>
          <dd>{c.limit}</dd>
        </div>
        <div>
          <dt>Code</dt>
          <dd>
            <code>{c.code}</code>
          </dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd>{c.paid}</dd>
        </div>
        <TxRow tx={c.tx} />
      </dl>
    </article>
  );
}

export function Hero() {
  return (
    <section className={s.hero}>
      <div className={s.wrap}>
        <p className={`${s.eyebrow} ${s.heroEyebrow}`}>{HERO.eyebrow}</p>
        <h1 className={s.h1}>
          <span>{HERO.line1}</span>
          <span className={s.gold}>{HERO.line2}</span>
        </h1>
        <div className={s.heroGrid}>
          <div>
            <p className={s.lede}>{HERO.lede}</p>
            <div className={s.cta}>
              <a className={`${s.btn} ${s.solid} ${s.big}`} href="#try">
                {HERO.tryLive}
              </a>
              <a className={`${s.btn} ${s.big}`} href="#integrate">
                {HERO.integrate}
              </a>
            </div>
            <p className={s.fineprint}>{HERO.fineprint}</p>
            <p className={`${s.fineprint} ${s.audience}`}>{HERO.audience}</p>
          </div>
          <div className={s.duel}>
            <PaidCard />
            <RefusedCard />
            <p className={s.duelNote}>
              <Rich text={HERO.note} />
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Problem() {
  return (
    <section className={s.section} id="problem">
      <div className={s.wrap}>
        <p className={s.eyebrow}>{PROBLEM.eyebrow}</p>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{PROBLEM.title}</h2>
          <p>{PROBLEM.sub}</p>
        </div>
        <div className={s.vs}>
          <div className={s.vsCol}>
            <h3>{PROBLEM.withoutTitle}</h3>
            <ul>
              {PROBLEM.without.map((line) => (
                <li key={line}>
                  <span className={s.vsNo} role="img" aria-label={PROBLEM.noLabel}>
                    ✕
                  </span>
                  <span>
                    <Rich text={line} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className={`${s.vsCol} ${s.vsWith}`}>
            <h3>{PROBLEM.withTitle}</h3>
            <ul>
              {PROBLEM.with.map((line) => (
                <li key={line}>
                  <span className={s.vsYes} role="img" aria-label={PROBLEM.yesLabel}>
                    ✓
                  </span>
                  <span>
                    <Rich text={line} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className={s.numbers}>
          {NUMBERS.map(({ name, value, rest }) => (
            <div key={name}>
              <b>{value}</b>
              <p>
                <strong>{name}</strong>
                <Rich text={rest} />
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
