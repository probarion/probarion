import Link from "next/link";
import { RouteLink } from "@/components/RouteLink";
import { HERO, PROBLEM, STORY, type TxFact } from "@/lib/site/facts";
import { type HeroMainnetView, heroMainnet } from "@/lib/site/hero-mainnet";
import { KeepLast, KeepRich, Outcome, type OutcomeTone } from "./bits";
import h from "./hero.module.css";
import { InkBand } from "./InkBand";
import { Away, Parts } from "./parts";
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

/*
 * Each card has four parts, in this order: its label and state, the amount, the rows, the link. The mainnet card adds a
 * fifth, its foot line. From 621px the two cards share those rows of the pair's grid, so that their labels, amounts,
 * rows and links line up.
 */

/**
 * The mainnet payout an attested model proposed (HERO.s2), from the recorded payouts. Its link scrolls to #mainnet and,
 * with JavaScript, reads that payout's chain there. Its foot is the online check of the model's TEE evidence, and its
 * limit.
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
      <p className={h.cardFoot}>
        <Parts parts={c.tee} />
      </p>
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
  const s2 = heroMainnet();
  return (
    <section className={h.hero}>
      <div className={s.wrap}>
        <p className={`${s.eyebrow} ${s.heroEyebrow}`}>{HERO.eyebrow}</p>
        <h1 className={s.h1}>
          <span>{HERO.line1}</span> <span className={s.gold}>{HERO.line2}</span>
        </h1>
        {/*
         * Two parts: the lede, its two buttons and the quiet line under them, then the cards. On one column (1100px and
         * below) a phone reaches the mainnet card right after the quiet line; from 1101px the cards sit beside the lede.
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
            </div>
            <p className={h.quiet}>
              <Link className={`${s.link} ${h.quietLink}`} href={STORY.proof.href}>
                {HERO.verify} <span aria-hidden="true">→</span>
              </Link>
              <Away
                className={`${s.link} ${h.quietLink}`}
                href={HERO.demo.href}
                label={HERO.demo.label}
              />
            </p>
          </div>
          {/* The caption is first in the source and above both cards at every width. */}
          <div className={h.duel}>
            <p className={h.cap}>{HERO.both.lead}</p>
            {s2 === null ? null : <MainnetCard c={s2} />}
            <RefusedCard />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The problem: an agent with its own key beside one with a mandate, the line that says why a cap is not enough (its
 * docs page carries the comparison table), then the payee panel (#payee), the one place the payee is told at length.
 */
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
      <div className={s.pull}>
        <p className={s.pullLine}>{PROBLEM.pull.text}</p>
        <Link className={`${s.link} ${s.pullLink}`} href={PROBLEM.pull.link.href}>
          {PROBLEM.pull.link.label} <span aria-hidden="true">→</span>
        </Link>
      </div>
      <InkBand />
    </LandingSection>
  );
}
