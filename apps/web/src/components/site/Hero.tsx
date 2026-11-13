import Link from "next/link";
import { RouteLink } from "@/components/RouteLink";
import { ExternalLink } from "@/components/ui";
import { type CopyPart, HERO, NUMBERS, PROBLEM, STORY, type TxFact } from "@/lib/site/facts";
import h from "./hero.module.css";
import { Outcome } from "./JourneyRecord";
import { Rich } from "./Rich";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

/** The id of the mainnet record's sentence, which names its list of transactions. */
const MAINNET_ID = "hero-mainnet";

/** A short hash that opens its explorer in a new tab: mono, then the arrow, which ExternalLink also says in words. */
function TxLink({ tx, className }: { tx: TxFact; className: string }) {
  return (
    <ExternalLink className={`${s.link} ${h.tx} ${className}`} href={tx.url}>
      {tx.label}
      <span className={h.ext} aria-hidden="true">
        ↗
      </span>
    </ExternalLink>
  );
}

function TxRow({ tx }: { tx: TxFact }) {
  return (
    <div>
      <dt>Tx</dt>
      <dd>
        <TxLink tx={tx} className={s.cardHash} />
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

/** A card's label, its last part (a date, an invoice number) kept whole, so that it never breaks at its hyphen. */
function CardLabel({ text }: { text: string }) {
  const cut = text.lastIndexOf(", ") + 2;
  return (
    <span className={h.cardLabel}>
      {text.slice(0, cut)}
      <span className={h.nowrap}>{text.slice(cut)}</span>
    </span>
  );
}

/** The mainnet record: what runs where, then one ruled row per transaction, its outcome, what happened and its hash. */
function MainnetRecord() {
  const m = HERO.mainnet;
  return (
    <div className={h.evidence}>
      <p className={h.evLead} id={MAINNET_ID}>
        <strong>{m.lead}</strong>
        <Rich text={m.intro} />
      </p>
      <ul className={h.evRows} aria-labelledby={MAINNET_ID}>
        {m.rows.map((r) => (
          <li key={r.tx.hash} className={h.evRow}>
            <Outcome tone={r.tone}>{r.state}</Outcome>
            <span className={h.evWhat}>
              <Rich text={r.what} />
            </span>
            <span className={h.evTx}>
              Tx <TxLink tx={r.tx} className={h.evHash} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/*
 * Each card has four parts, in this order: its label and state, the amount, the rows, the link. From 621px the two
 * cards share those four rows of the pair's grid, so that their labels, amounts, rows and links line up.
 */

function PaidCard() {
  const c = HERO.paid;
  return (
    <article className={`${s.card} ${s.metal} ${h.paid}`} aria-label={c.aria}>
      <div className={s.cardTop}>
        <CardLabel text={c.label} />
        <span className={s.state}>{c.state}</span>
      </div>
      <div className={s.cardBig}>{c.big}</div>
      <dl className={`${s.rows} ${h.cardRows}`}>
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
      <Link className={`${s.link} ${s.cardLink} ${h.cardEnd}`} href={c.proof.href}>
        {c.proof.label} <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

function RefusedCard() {
  const c = HERO.refused;
  return (
    <article className={`${s.card} ${s.obsidian} ${h.canary}`} aria-label={c.aria}>
      <div className={s.cardTop}>
        <CardLabel text={c.label} />
        <span className={s.state}>{c.state}</span>
      </div>
      <div className={s.cardBig}>{c.big}</div>
      <dl className={`${s.rows} ${h.cardRows}`}>
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
      <Link className={`${s.link} ${s.cardLink} ${h.cardEnd}`} href={c.tryIt.href}>
        {c.tryIt.label} <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export function Hero() {
  return (
    <section className={h.hero}>
      <div className={s.wrap}>
        <p className={`${s.eyebrow} ${s.heroEyebrow}`}>{HERO.eyebrow}</p>
        <h1 className={s.h1}>
          <span>{HERO.line1}</span> <span className={s.gold}>{HERO.line2}</span>
        </h1>
        <div className={h.heroGrid}>
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
            <MainnetRecord />
            <p className={s.fineprint}>
              <Parts parts={HERO.fineprint} />
            </p>
          </div>
          {/* The caption is first in the source, so that a phone reads it above both cards; from 621px it sits under the paid card. */}
          <div className={h.duel}>
            <p className={h.cap}>
              <span className={h.capLead}>{HERO.both.lead}</span>
              {HERO.both.rest}
            </p>
            <PaidCard />
            <RefusedCard />
            <ol className={h.steps} aria-label={HERO.canarySteps.label}>
              {HERO.canarySteps.items.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Problem() {
  return (
    <LandingSection
      id="problem"
      head={{ eyebrow: PROBLEM.eyebrow, title: PROBLEM.title, lede: PROBLEM.sub }}
    >
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
    </LandingSection>
  );
}
