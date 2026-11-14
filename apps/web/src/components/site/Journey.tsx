import Link from "next/link";
import type { ReactNode } from "react";
import { JOURNEY, type JourneyStep, type PanelLine } from "@/lib/site/facts";
import { KeepRich, LIST } from "./bits";
import { JourneyRecord } from "./JourneyRecord";
import j from "./journey.module.css";
import { Parts } from "./parts";
import p from "./parts.module.css";
import { ScrollRegion } from "./ScrollRegion";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

const TONE = { pass: s.pass, fail: s.fail } as const;

function Line({ line }: { line: PanelLine }) {
  if ("note" in line) return <div className={j.panelNote}>{line.note}</div>;
  if ("command" in line) {
    return (
      <div className={s.panelCommand}>
        <span className={s.prompt}>$ </span>
        {line.command}
      </div>
    );
  }
  if ("key" in line) {
    return (
      <div className={j.kv}>
        <span className={line.tone === undefined ? s.panelKey : undefined}>{line.key}</span>
        <span className={line.tone === undefined ? undefined : TONE[line.tone]}>{line.value}</span>
      </div>
    );
  }
  return <div className={line.tone === undefined ? undefined : TONE[line.tone]}>{line.text}</div>;
}

function lineKey(line: PanelLine): string {
  if ("note" in line) return line.note;
  if ("command" in line) return line.command;
  return "key" in line ? line.key : line.text;
}

/** What is true of a step on testnet: a gold rule, a label, and short lines, each with its link. */
function Note({ note }: { note: NonNullable<JourneyStep["note"]> }) {
  return (
    <div className={j.note}>
      <p className={j.noteLabel}>{note.label}</p>
      {note.lines.map((line) => (
        <p key={line.lead ?? JSON.stringify(line.parts)} className={j.noteLine}>
          {line.lead === undefined ? null : <span className={j.lead}>{line.lead} </span>}
          <Parts parts={line.parts} />
        </p>
      ))}
    </div>
  );
}

/** One step: its number, its title and text, then its panel, which opens with the caption strip every panel has. */
function Step({ step }: { step: JourneyStep }) {
  return (
    <li className={j.step}>
      <div className={p.stepN} aria-hidden="true">
        {step.n}
      </div>
      <div className={j.stepText}>
        <h3 className={p.stepTitle}>
          <span className="sr-only">Step {step.n}: </span>
          {step.title}
        </h3>
        <p className={p.stepBody}>
          <KeepRich text={step.body} />
        </p>
        {step.note === undefined ? null : <Note note={step.note} />}
      </div>
      <div className={j.panel}>
        <p className={j.panelCap}>
          <KeepRich text={step.caption} />
        </p>
        <ScrollRegion className={j.panelBody} label={step.panelLabel}>
          {step.panel.map((line) => (
            <Line key={lineKey(line)} line={line} />
          ))}
        </ScrollRegion>
      </div>
    </li>
  );
}

/**
 * A step of the compact list, one column of four: its number, its title and one line, then the mono tag of where it
 * runs (JOURNEY.runsOn), held to the column's foot so the four tags sit on one line. The last step, the contract's,
 * opens with a gold rule (journey.module.css).
 */
function CompactStep({ step, runsOn }: { step: JourneyStep; runsOn: string }) {
  return (
    <li className={j.compactStep}>
      <div className={p.stepN} aria-hidden="true">
        {step.n}
      </div>
      <h3 className={j.compactTitle}>
        <span className="sr-only">Step {step.n}: </span>
        {step.title}
      </h3>
      <p className={j.compactBody}>
        <KeepRich text={step.body} />
      </p>
      <p className={j.runsOn}>
        <span className={j.runsOnLabel}>{JOURNEY.runsOnLabel}:</span> <KeepRich text={runsOn} />
      </p>
    </li>
  );
}

/**
 * What happens to one invoice. In full: five steps of one shape, then the record of it on NEAR testnet (JourneyRecord),
 * where each claim sits next to its evidence. `compact`, on the landing: steps 1 to 4, each with where it runs, then
 * the docs page that walks every step with its fields and code; no panels or record, which the docs carry. `children`
 * follow inside the section: the landing's live check of step 4 (#try).
 */
export function Journey({
  compact = false,
  children,
}: {
  compact?: boolean;
  children?: ReactNode;
} = {}) {
  return (
    <LandingSection
      id="payment"
      head={{ eyebrow: JOURNEY.eyebrow, title: JOURNEY.title, lede: JOURNEY.intro }}
    >
      {compact ? (
        <>
          <ol className={j.compactSteps} {...LIST}>
            {JOURNEY.runsOn.map((runsOn, i) => {
              const step = JOURNEY.steps[i];
              return step === undefined ? null : (
                <CompactStep key={step.n} step={step} runsOn={runsOn} />
              );
            })}
          </ol>
          <p className={j.more}>
            <Link className={`${s.link} ${j.moreLink}`} href={JOURNEY.more.href}>
              {JOURNEY.more.label} <span aria-hidden="true">→</span>
            </Link>
          </p>
        </>
      ) : (
        <>
          <ol className={j.steps} {...LIST}>
            {JOURNEY.steps.map((step) => (
              <Step key={step.n} step={step} />
            ))}
          </ol>
          <JourneyRecord />
        </>
      )}
      {children}
    </LandingSection>
  );
}
