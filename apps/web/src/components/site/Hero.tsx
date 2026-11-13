import Link from "next/link";
import { RouteLink } from "@/components/RouteLink";
import { HERO, NUMBERS, PROBLEM, STORY, type TxFact } from "@/lib/site/facts";
import { KeepLast, KeepRich, LIST, Outcome, type OutcomeTone } from "./bits";
import h from "./hero.module.css";
import { Away, Parts } from "./parts";
import p from "./parts.module.css";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

/** A card's transaction: the page's evidence label, then the short hash in mono and its arrow. */
function TxRow({ tx }: { tx: TxFact }) {
  return (
    <div>
      <dt>{HERO.txLabel}</dt>
      <dd>
        <Away className={`${s.link} ${s.cardHash}`} href={tx.url} tx={tx.label} />
      </dd>
    </div>
  );
}

/** A card's label, its last part (a date, an invoice number) kept whole, so that it never breaks at its hyphen. */
function CardLabel({ text }: { text: string }) {
  return (
    <span className={h.cardLabel}>
      <KeepLast text={text} />
    </span>
  );
}

/** A card's state, said as every outcome on the page is: its mark and its word, on the card's own ground. */
function CardState({ tone, children }: { tone: OutcomeTone; children: string }) {
  return (
    <Outcome tone={tone} className={h.state}>
      {children}
    </Outcome>
  );
}

/**
 * The mainnet record: what runs where, then one ruled row per transaction (its outcome, what happened, then the
 * transaction under it), then a line that points to the vault's later payouts. The list is named without "Testnet today".
 */
function MainnetRecord() {
  const m = HERO.mainnet;
  return (
    <div className={h.evidence}>
      <p className={h.evLead}>
        <strong>{m.lead}</strong>
        <KeepRich text={m.intro} />
      </p>
      <ul className={h.evRows} aria-label={m.listLabel} {...LIST}>
        {m.rows.map((r) => (
          <li key={r.tx.hash} className={h.evRow}>
            <Outcome tone={r.tone} className={h.evOut}>
              {r.state}
            </Outcome>
            <span className={h.evWhat}>
              <KeepRich text={r.what} />
            </span>
            <span className={h.evTx}>
              <span className={p.label}>{m.txLabel}</span>{" "}
              <Away className={`${s.link} ${h.evHash}`} href={r.tx.url} tx={r.tx.label} />
            </span>
          </li>
        ))}
      </ul>
      <p className={h.evAfter}>
        <Parts parts={m.after} />
      </p>
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
        <CardState tone="paid">{c.state}</CardState>
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
        <CardState tone="refused">{c.state}</CardState>
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
            <ol className={h.steps} aria-label={HERO.canarySteps.label} {...LIST}>
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
                  <KeepRich text={line} />
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
                  <KeepRich text={line} />
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
              <KeepRich text={rest} />
            </p>
          </div>
        ))}
      </div>
    </LandingSection>
  );
}
