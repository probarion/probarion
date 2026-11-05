import { RouteLink } from "@/components/RouteLink";
import { ExternalLink } from "@/components/ui";
import { CONSOLE_ROUTE, HERO, NUMBERS, THESIS, type TxFact } from "@/lib/site/facts";
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
      <div className={`${s.cardBig} ${s.cardCode}`}>
        {c.code[0]}
        <wbr />
        {c.code[1]}
      </div>
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
        <h1 className={s.h1}>
          <span>{HERO.line1}</span>
          <span className={s.gold}>{HERO.line2}</span>
        </h1>
        <div className={s.heroGrid}>
          <div>
            <p className={s.lede}>{HERO.lede}</p>
            <div className={s.cta}>
              <RouteLink route={CONSOLE_ROUTE} className={`${s.btn} ${s.solid} ${s.big}`}>
                {HERO.openConsole}
              </RouteLink>
              <a className={`${s.btn} ${s.big}`} href="#verify">
                {HERO.breakTheLedger}
              </a>
            </div>
            <p className={s.fineprint}>{HERO.fineprint}</p>
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

export function Thesis() {
  return (
    <section className={s.thesis}>
      <div className={s.wrap}>
        <p>
          {THESIS.lead} <em>{THESIS.rule}</em>
        </p>
      </div>
    </section>
  );
}

export function Numbers() {
  return (
    <div className={s.wrap}>
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
  );
}
