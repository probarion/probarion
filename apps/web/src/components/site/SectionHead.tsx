import type { ReactNode } from "react";
import { KeepRich } from "./bits";
import h from "./head.module.css";
import s from "./site.module.css";

/**
 * What a section's head says, from `lib/site/facts.ts`. Parts of the lede in backticks render as code, and its
 * identifiers (dates, accounts, re-signed) stay whole on their line (bits.tsx KeepRich).
 */
export interface HeadCopy {
  eyebrow: string;
  title: string;
  lede: string;
}

/** A head as SectionHead draws it: a heading in parts (the mainnet section's two lines) is a node. */
export type HeadProps = Omit<HeadCopy, "title"> & { title: ReactNode };

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
}: HeadProps & { id: string; after?: ReactNode }) {
  return (
    <header className={h.head}>
      <hgroup>
        <p className={s.eyebrow}>{eyebrow}</p>
        <h2 className={`${s.h2} ${h.title}`} id={id}>
          {title}
        </h2>
      </hgroup>
      <p className={h.lede}>
        <KeepRich text={lede} />
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
  wrapClassName,
  children,
}: {
  id: string;
  head: HeadProps;
  /** Added to the wrap's class: what the section's body sets for itself there (the status board's columns). */
  wrapClassName?: string;
  /** Rendered in the head, under the lede: see SectionHead's `after`. */
  headAfter?: ReactNode;
  children: ReactNode;
}) {
  const titleId = `${id}-title`;
  return (
    <section className={h.section} id={id} aria-labelledby={titleId}>
      <div className={wrapClassName === undefined ? s.wrap : `${s.wrap} ${wrapClassName}`}>
        <SectionHead id={titleId} {...head} after={headAfter} />
        {children}
      </div>
    </section>
  );
}
