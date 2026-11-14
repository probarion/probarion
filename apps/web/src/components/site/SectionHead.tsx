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
 * A block inside a landing section, with a head one level down: a hairline and `--space-block` of paper above it, then
 * the optional eyebrow, an h3 and the optional lede, so that the page keeps h2 > h3 > h4. The div carries `id`, the
 * block's anchor (#try, #built-on, #status), and the h3 carries `id` plus "-title", which names the block.
 */
export function SubHead({
  id,
  eyebrow,
  title,
  lede,
  className,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: ReactNode;
  /** Backticks are code, as in SectionHead's lede. */
  lede?: string;
  /** Added to the block's class: what the block sets for itself there. */
  className?: string;
  children?: ReactNode;
}) {
  const titleId = `${id}-title`;
  const heading = (
    <h3 className={h.subTitle} id={titleId}>
      {title}
    </h3>
  );
  return (
    <div
      className={className === undefined ? h.block : `${h.block} ${className}`}
      id={id}
      role="group"
      aria-labelledby={titleId}
    >
      <header className={h.subHead}>
        {eyebrow === undefined ? (
          heading
        ) : (
          <hgroup>
            <p className={s.eyebrow}>{eyebrow}</p>
            {heading}
          </hgroup>
        )}
        {lede === undefined ? null : (
          <p className={`${h.lede} ${h.subLede}`}>
            <KeepRich text={lede} />
          </p>
        )}
      </header>
      {children}
    </div>
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
