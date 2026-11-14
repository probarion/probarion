import Image from "next/image";
import Link from "next/link";
import { CONSOLE_SHOTS, type ConsoleShot } from "@/lib/site/facts";
import { KeepRich, LIST } from "./bits";
import c from "./console.module.css";
import { Away, TermRecord } from "./parts";
import p from "./parts.module.css";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

/**
 * One step: its number, title and sentence, then its transaction, if it has one, under the sentence; then the
 * capture, linked to its file. The number, title and text are the page's shared step (parts.module.css).
 */
function Shot({ shot, n }: { shot: ConsoleShot; n: number }) {
  return (
    <li className={c.step}>
      <figure className={c.row}>
        <figcaption className={c.cap}>
          <div className={p.stepN} aria-hidden="true">
            {n}
          </div>
          <h3 className={`${p.stepTitle} ${c.capTitle}`}>
            <span className="sr-only">Step {n}: </span>
            {shot.title}
          </h3>
          <p className={p.stepBody}>
            <KeepRich text={shot.body} />
          </p>
          {shot.link === undefined ? null : (
            <p className={c.tx}>
              <span className={p.label}>{CONSOLE_SHOTS.txLabel}</span>
              <Away href={shot.link.url} tx={shot.link.label} />
            </p>
          )}
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
        <p className={c.full}>
          <a className={s.link} href={shot.src}>
            {CONSOLE_SHOTS.fullSize}
            <span className="sr-only">: {shot.title}</span>
          </a>
        </p>
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
      headAfter={<TermRecord rows={CONSOLE_SHOTS.record} />}
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
