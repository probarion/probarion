import Link from "next/link";
import { RouteLink } from "@/components/RouteLink";
import { ExternalLink } from "@/components/ui";
import { type CopyPart, HERO, NUMBERS, PROBLEM, STORY, type TxFact } from "@/lib/site/facts";
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

/** A line of copy with links in it: a link to a place on this page stays in the tab, any other opens a new one. */
function Parts({ parts }: { parts: readonly CopyPart[] }) {
  return parts.map((p) =>
    typeof p === "string" ? (
      <Rich key={p} text={p} />
    ) : p.href.startsWith("#") ? (
      <a key={p.href} className={s.link} href={p.href}>
        {p.label}
      </a>
    ) : (
      <ExternalLink key={p.href} className={s.link} href={p.href}>
        {p.label}
      </ExternalLink>
    ),
  );
}

function PaidCard() {
  const c = HERO.paid;
  return (
    <article className={`${s.card} ${s.metal}`} aria-label={c.aria}>
      <div className={s.cardTop}>
        <span>{c.label}</span>
        <span className={s.state}>{c.state}</span>
      </div>
      <div className={s.cardBig}>{c.big}</div>
      <dl className={s.rows}>
        <div>
          <dt>Vault</dt>
          <dd>{c.vault}</dd>
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
        <span>{c.label}</span>
        <span className={s.state}>{c.state}</span>
      </div>
      <div className={s.cardBig}>{c.big}</div>
      <dl className={s.rows}>
        <div>
          <dt>Vault</dt>
          <dd>{c.vault}</dd>
        </div>
        <div>
          <dt>Limit</dt>
          <dd>{c.limit}</dd>
        </div>
        <div>
          <dt>Contract</dt>
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
      <Link className={`${s.link} ${s.cardLink}`} href={c.tryIt.href}>
        {c.tryIt.label} <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export function Hero() {
  return (
    <section className={s.hero}>
      <div className={s.wrap}>
        <p className={`${s.eyebrow} ${s.heroEyebrow}`}>{HERO.eyebrow}</p>
        <h1 className={s.h1}>
          <span>{HERO.line1}</span> <span className={s.gold}>{HERO.line2}</span>
        </h1>
        <div className={s.heroGrid}>
          <div>
            <p className={s.lede}>{HERO.lede}</p>
            <div className={s.cta}>
              <a className={`${s.btn} ${s.solid} ${s.big}`} href="#try">
                {HERO.tryLive}
              </a>
              <RouteLink route={HERO.docs.route} className={`${s.btn} ${s.big}`}>
                {HERO.docs.label}
              </RouteLink>
              <Link className={`${s.link} ${s.ctaLink}`} href={STORY.proof.href}>
                {HERO.verify} <span aria-hidden="true">→</span>
              </Link>
            </div>
            <p className={s.fineprint}>
              <Parts parts={HERO.fineprint} />
            </p>
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
