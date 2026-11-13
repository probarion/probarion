import type { ReactNode } from "react";
import h from "./head.module.css";
import { Rich } from "./Rich";
import s from "./site.module.css";

/** What a section's head says, from `lib/site/facts.ts`. Parts of the lede in backticks render as code. */
export interface HeadCopy {
  eyebrow: string;
  title: string;
  lede: string;
}

/**
 * The head every landing section opens with: a hairline, the eyebrow, the heading and the lede, stacked on one left
 * edge. The eyebrow and the heading are one `hgroup`; the heading carries `id`, which names the section. `after` is
 * what a section says once for its whole body, under the lede and inside the head (the console's record).
 */
export function SectionHead({
  id,
  eyebrow,
  title,
  lede,
  after,
}: HeadCopy & { id: string; after?: ReactNode }) {
  return (
    <header className={h.head}>
      <hgroup>
        <p className={s.eyebrow}>{eyebrow}</p>
        <h2 className={`${s.h2} ${h.title}`} id={id}>
          {title}
        </h2>
      </hgroup>
      <p className={h.lede}>
        <Rich text={lede} />
      </p>
      {after}
    </header>
  );
}

/**
 * A landing section with the shared head: G of paper below it and none above, so that the gap between any two
 * sections is one `--space-section`. The heading's id is the section's id plus "-title", and the section is named by it.
 */
export function LandingSection({
  id,
  head,
  headAfter,
  children,
}: {
  id: string;
  head: HeadCopy;
  /** Rendered in the head, under the lede: see SectionHead's `after`. */
  headAfter?: ReactNode;
  children: ReactNode;
}) {
  const titleId = `${id}-title`;
  return (
    <section className={h.section} id={id} aria-labelledby={titleId}>
      <div className={s.wrap}>
        <SectionHead id={titleId} {...head} after={headAfter} />
        {children}
      </div>
    </section>
  );
}
