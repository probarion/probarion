import { JOURNEY, type JourneyStep, type PanelLine } from "@/lib/site/facts";
import { JourneyRecord, Parts } from "./JourneyRecord";
import j from "./journey.module.css";
import { Rich } from "./Rich";
import { ScrollRegion } from "./ScrollRegion";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

const TONE = { pass: s.pass, fail: s.fail } as const;

/** list-style: none drops a list's semantics in Safari, so the steps say they are one. Spread past noRedundantRoles. */
const LIST = { role: "list" } as const;

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
      <div className={j.stepN} aria-hidden="true">
        {step.n}
      </div>
      <div className={j.stepText}>
        <h3 className={j.stepTitle}>
          <span className="sr-only">Step {step.n}: </span>
          {step.title}
        </h3>
        <p className={j.stepBody}>
          <Rich text={step.body} />
        </p>
        {step.note === undefined ? null : <Note note={step.note} />}
        {step.tryIt === undefined ? null : (
          <a className={`${s.link} ${j.stepLink}`} href={step.tryIt.href}>
            {step.tryIt.label}
          </a>
        )}
      </div>
      <div className={j.panel}>
        <p className={j.panelCap}>
          <Rich text={step.caption} />
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
 * What happens to one invoice, in two parts: how it works, in five steps of one shape, then the record of it on NEAR
 * testnet (JourneyRecord), where each claim sits next to its evidence.
 */
export function Journey() {
  return (
    <LandingSection
      id="payment"
      head={{ eyebrow: JOURNEY.eyebrow, title: JOURNEY.title, lede: JOURNEY.intro }}
    >
      <ol className={j.steps} {...LIST}>
        {JOURNEY.steps.map((step) => (
          <Step key={step.n} step={step} />
        ))}
      </ol>
      <JourneyRecord />
    </LandingSection>
  );
}
