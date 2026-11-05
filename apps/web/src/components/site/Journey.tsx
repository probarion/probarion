import { JOURNEY, type JourneyStep, type PanelLine } from "@/lib/site/facts";
import { Rich } from "./Rich";
import { ScrollRegion } from "./ScrollRegion";
import s from "./site.module.css";

const TONE = { pass: s.pass, fail: s.fail } as const;

function Line({ line }: { line: PanelLine }) {
  if ("note" in line) return <div className={s.panelNote}>{line.note}</div>;
  if ("command" in line) {
    return (
      <div className={s.panelNote}>
        <span className={s.prompt}>$ </span>
        {line.command}
      </div>
    );
  }
  if ("key" in line) {
    return (
      <div className={s.panelRow}>
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

function Step({ step }: { step: JourneyStep }) {
  return (
    <div className={s.step}>
      <div className={s.stepN}>{step.n}</div>
      <div>
        <h3>{step.title}</h3>
        <p>
          <Rich text={step.body} />
        </p>
        {step.tag === undefined ? null : <span className={s.tag}>{step.tag}</span>}
      </div>
      <ScrollRegion className={s.panel} label={step.panelLabel}>
        {step.panel.map((line) => (
          <Line key={lineKey(line)} line={line} />
        ))}
      </ScrollRegion>
    </div>
  );
}

export function Journey() {
  return (
    <section className={s.section} id="payment">
      <div className={s.wrap}>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{JOURNEY.title}</h2>
          <p>{JOURNEY.intro}</p>
        </div>
        {JOURNEY.steps.map((step) => (
          <Step key={step.n} step={step} />
        ))}
      </div>
    </section>
  );
}
