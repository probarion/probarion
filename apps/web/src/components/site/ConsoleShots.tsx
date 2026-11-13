import Image from "next/image";
import Link from "next/link";
import { ExternalLink } from "@/components/ui";
import { CONSOLE_SHOTS, type ConsoleShot } from "@/lib/site/facts";
import c from "./console.module.css";
import j from "./journey.module.css";
import { Rich } from "./Rich";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

const NBSP = "\u00a0";

/** list-style: none drops a list's semantics in Safari, so the steps say they are one. Spread past noRedundantRoles. */
const LIST = { role: "list" } as const;

/** What the three shots share: the network, the day they were taken and the vault, said once in the head. */
function Record() {
  return (
    <dl className={c.record}>
      {CONSOLE_SHOTS.record.map((r) => (
        <div key={r.term}>
          <dt>{r.term}</dt>
          <dd>
            <Rich text={r.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A shot's transaction: the verb, the short hash in mono, then the new-tab arrow, all on one line. */
function TxLink({ link }: { link: NonNullable<ConsoleShot["link"]> }) {
  const at = link.label.indexOf(" ");
  return (
    <ExternalLink className={`${s.link} ${c.txLink}`} href={link.url}>
      {link.label.slice(0, at + 1)}
      <span className={c.hash}>{link.label.slice(at + 1)}</span>
      {NBSP}
      <span aria-hidden="true">↗</span>
    </ExternalLink>
  );
}

/** One step: its number, title and sentence, then the capture, linked to its file, then its transaction, if it has one. */
function Shot({ shot, n }: { shot: ConsoleShot; n: number }) {
  return (
    <li className={c.step}>
      <figure className={c.row}>
        <figcaption className={c.cap}>
          <div className={j.stepN} aria-hidden="true">
            {n}
          </div>
          <h3 className={`${j.stepTitle} ${c.capTitle}`}>
            <span className="sr-only">Step {n}: </span>
            {shot.title}
          </h3>
          <p className={j.stepBody}>
            <Rich text={shot.body} />
          </p>
        </figcaption>
        <a className={c.shot} href={shot.src}>
          <Image
            src={shot.src}
            width={shot.width}
            height={shot.height}
            alt={shot.alt}
            sizes="(max-width: 1099px) 100vw, 856px"
          />
        </a>
        <div className={shot.link === undefined ? `${c.ev} ${c.bare}` : c.ev}>
          <p className={c.full}>
            <a className={s.link} href={shot.src}>
              {CONSOLE_SHOTS.fullSize}
            </a>
          </p>
          {shot.link === undefined ? null : (
            <p className={c.tx}>
              <span className={c.txLabel}>{CONSOLE_SHOTS.txLabel}</span>
              <TxLink link={shot.link} />
            </p>
          )}
        </div>
      </figure>
    </li>
  );
}

/**
 * Real testnet screenshots of the console, after the ink band (audit P1-23): one invoice held for an approver, its
 * page, then paid, as three numbered rows. What they share is said once in the head; each capture links to its file.
 */
export function ConsoleShots() {
  return (
    <LandingSection
      id="console"
      head={{
        eyebrow: CONSOLE_SHOTS.eyebrow,
        title: CONSOLE_SHOTS.title,
        lede: CONSOLE_SHOTS.intro,
      }}
      headAfter={<Record />}
    >
      <ol className={c.steps} {...LIST}>
        {CONSOLE_SHOTS.shots.map((shot, i) => (
          <Shot key={shot.id} shot={shot} n={i + 1} />
        ))}
      </ol>
      <div className={c.actions}>
        <p className={c.actionsText}>{CONSOLE_SHOTS.proof.text}</p>
        <div className={c.buttons}>
          <Link className={s.btn} href={CONSOLE_SHOTS.proof.href}>
            {CONSOLE_SHOTS.proof.label} <span aria-hidden="true">→</span>
          </Link>
          <Link className={`${s.btn} ${s.solid}`} href={CONSOLE_SHOTS.open.href}>
            {CONSOLE_SHOTS.open.label}
          </Link>
        </div>
      </div>
    </LandingSection>
  );
}
