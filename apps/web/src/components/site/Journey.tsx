import Link from "next/link";
import { ExternalLink } from "@/components/ui";
import {
  JOURNEY,
  type JourneyStep,
  type PanelLine,
  STORY,
  type StoryInvoice,
  type StoryTone,
} from "@/lib/site/facts";
import { Rich } from "./Rich";
import { ScrollRegion } from "./ScrollRegion";
import s from "./site.module.css";

const TONE = { pass: s.pass, fail: s.fail } as const;
const STORY_TONE: Readonly<Record<StoryTone, string | undefined>> = {
  paid: s.live,
  refused: s.refusedPill,
  held: s.work,
};

function Line({ line }: { line: PanelLine }) {
  if ("note" in line) return <div className={s.panelNote}>{line.note}</div>;
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
        {step.tag === undefined ? null : (
          <div className={s.today}>
            <span className={s.todayLabel}>{JOURNEY.today}</span>
            <Rich text={step.tag} />
          </div>
        )}
        {step.tryIt === undefined ? null : (
          <a className={`${s.link} ${s.tryIt}`} href="#try">
            {step.tryIt}
          </a>
        )}
      </div>
      <ScrollRegion className={s.panel} label={step.panelLabel}>
        {step.panel.map((line) => (
          <Line key={lineKey(line)} line={line} />
        ))}
      </ScrollRegion>
    </div>
  );
}

function StoryCard({ card }: { card: StoryInvoice }) {
  return (
    <li className={s.storyCard}>
      <div className={s.storyTop}>
        <h4>{card.title}</h4>
        <span className={`${s.pill} ${s.pillInline} ${STORY_TONE[card.tone]}`}>{card.pill}</span>
      </div>
      <p className={s.storyAsks}>
        <Rich text={card.asks} />
      </p>
      <p>
        <Rich text={card.body} />
      </p>
      {card.links.length === 0 ? null : (
        <div className={s.storyLinks}>
          {card.links.map((l) => (
            <ExternalLink key={l.url} className={s.link} href={l.url}>
              {l.label}
            </ExternalLink>
          ))}
        </div>
      )}
    </li>
  );
}

/** The journey, as it ran: the four invoices of the testnet demo vault (audit P1-5). */
function Story() {
  return (
    <div className={s.story}>
      <h3>{STORY.title}</h3>
      <p className={s.storyCaption}>{STORY.caption}</p>
      <p className={s.storyIntro}>
        <Rich text={STORY.intro} />
      </p>
      <ul className={s.storyGrid}>
        {STORY.invoices.map((card) => (
          <StoryCard key={card.title} card={card} />
        ))}
      </ul>
      <p className={s.storyProof}>
        {STORY.proof.text}{" "}
        <Link className={s.link} href={STORY.proof.href}>
          {STORY.proof.label} →
        </Link>
      </p>
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
        <Story />
      </div>
    </section>
  );
}
