import Link from "next/link";
import { RouteLink } from "@/components/RouteLink";
import { HERO, NUMBERS, PROBLEM, STORY, type TxFact } from "@/lib/site/facts";
import { type HeroMainnetView, heroMainnet } from "@/lib/site/hero-mainnet";
import { KeepLast, KeepRich, LIST, Outcome, type OutcomeTone } from "./bits";
import h from "./hero.module.css";
import { Away, Parts } from "./parts";
import p from "./parts.module.css";
import { ReadChainLink } from "./ReadChainLink";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

/** A card's transaction: the page's evidence label for its network, then the short hash in mono and its arrow. */
function TxRow({ tx, label = HERO.txLabel }: { tx: TxFact; label?: string }) {
  return (
    <div>
      <dt>{label}</dt>
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

/**
 * The mainnet payout an attested model proposed (HERO.s2), from the recorded payouts. Its link scrolls to #mainnet and,
 * with JavaScript, reads that payout's chain there.
 */
function MainnetCard({ c }: { c: HeroMainnetView }) {
  const R = HERO.s2.rows;
  return (
    <article className={`${s.card} ${s.metal} ${h.paid}`} aria-label={c.aria}>
      <div className={s.cardTop}>
        <CardLabel text={c.label} />
        <CardState tone="paid">{c.state}</CardState>
      </div>
      <div className={s.cardBig}>{c.big}</div>
      <dl className={`${s.rows} ${h.cardRows}`}>
        <div>
          <dt>{R.vault}</dt>
          <dd>{c.vault}</dd>
        </div>
        <div>
          <dt>{R.payee}</dt>
          <dd>{c.payee}</dd>
        </div>
        <div>
          <dt>{R.arrived}</dt>
          <dd>{c.arrived}</dd>
        </div>
        <div>
          <dt>{R.model}</dt>
          <dd>{c.model}</dd>
        </div>
        <TxRow tx={c.tx} label={R.tx} />
      </dl>
      <ReadChainLink
        payoutId={c.payoutId}
        href={c.read.href}
        className={`${s.link} ${s.cardLink} ${h.cardEnd}`}
      >
        {c.read.label} <span aria-hidden="true">→</span>
      </ReadChainLink>
    </article>
  );
}

/** Under the mainnet card: how the payout was decided and paid, then the online check of the model's TEE evidence. */
function MainnetSteps({ c }: { c: HeroMainnetView }) {
  return (
    <div className={h.s2Steps}>
      <ol className={h.steps} aria-label={c.stepsLabel} {...LIST}>
        {c.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className={h.tee}>
        <Parts parts={c.tee} />
      </p>
    </div>
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
  const s2 = heroMainnet();
  return (
    <section className={h.hero}>
      <div className={s.wrap}>
        <p className={`${s.eyebrow} ${s.heroEyebrow}`}>{HERO.eyebrow}</p>
        <h1 className={s.h1}>
          <span>{HERO.line1}</span> <span className={s.gold}>{HERO.line2}</span>
        </h1>
        {/*
         * Three parts: the lede and its links, the cards, then the mainnet record and the audience line. The record is
         * last in the source, so that a phone reaches the mainnet card right after the buttons; from 961px it sits under
         * the lede, beside the cards (hero.module.css).
         */}
        <div className={h.heroGrid}>
          <div className={h.leadCol}>
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
            <p className={h.demo}>
              <Away href={HERO.demo.href} label={HERO.demo.label} />
            </p>
          </div>
          {/* The caption is first in the source and above both cards at every width; each card's steps sit under it. */}
          <div className={h.duel}>
            <p className={h.cap}>
              <span className={h.capLead}>{HERO.both.lead}</span>
              {HERO.both.rest}
            </p>
            {s2 === null ? null : <MainnetCard c={s2} />}
            {s2 === null ? null : <MainnetSteps c={s2} />}
            <RefusedCard />
            <ol className={h.steps} aria-label={HERO.canarySteps.label} {...LIST}>
              {HERO.canarySteps.items.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
          <div className={h.recordCol}>
            <MainnetRecord />
            <p className={s.fineprint}>
              <Parts parts={HERO.fineprint} />
            </p>
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
