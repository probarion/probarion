import Link from "next/link";
import { createElement, Fragment, type ReactNode } from "react";
import { ExternalLink } from "@/components/ui";
import { type CopyPart, INTEGRATE, type StatusTone, statusOf } from "@/lib/site/facts";
import { ArrowLabel, CodeLabel, Glued, Keep, KeepRich, TxLabel } from "./bits";
import p from "./parts.module.css";
import s from "./site.module.css";

/*
 * The shared pieces that read facts.ts or link out, for the landing's server components: a link that leaves the site,
 * a line of copy with its links, a record of terms, and a status pill. The client-safe ones are in bits.tsx.
 */

/**
 * A link that leaves this site, in a new tab, its ↗ glued to its end. Give it `label` (words: the arrow joins the last
 * one), `tx` (a transaction: words, then the short hash in mono), `code` (a file path or an account in mono: the
 * arrow joins its last segment) or `children` (glued to the arrow whole). `after`
 * is read by a screen reader only, before ExternalLink's own "(opens in a new tab)". `className` is the site's link
 * style unless given; `null` gives none (the footer styles its own links).
 */
export function Away({
  href,
  className = s.link,
  label,
  tx,
  code,
  children,
  after,
}: {
  href: string;
  className?: string | null;
  label?: string;
  tx?: string;
  code?: string;
  children?: ReactNode;
  after?: string;
}) {
  return (
    <ExternalLink className={className ?? undefined} href={href}>
      {tx !== undefined ? (
        <TxLabel label={tx} />
      ) : label !== undefined ? (
        <ArrowLabel text={label} />
      ) : code !== undefined ? (
        <CodeLabel text={code} />
      ) : (
        <Glued>{children}</Glued>
      )}
      {after === undefined ? null : <span className="sr-only">{after}</span>}
    </ExternalLink>
  );
}

/**
 * One part of a line of copy, as facts.ts writes it: text (backticks are code, identifiers kept whole), a link on the
 * page (#), a page of the site (/), or a file or transaction elsewhere, which opens in a new tab with the arrow.
 */
function part(x: CopyPart): ReactNode {
  if (typeof x === "string") return <KeepRich text={x} />;
  if (x.href.startsWith("#")) {
    return (
      <a className={s.link} href={x.href}>
        {x.label}
      </a>
    );
  }
  if (x.href.startsWith("/")) {
    return (
      <Link className={s.link} href={x.href}>
        {x.label}
      </Link>
    );
  }
  return <Away href={x.href} label={x.label} />;
}

/** A line of copy with its links. Its parts are spread as children, so a line that repeats a word needs no keys. */
export function Parts({ parts }: { parts: readonly CopyPart[] }) {
  return createElement(Fragment, null, ...parts.map(part));
}

/** One term of a record: its value (backticks are code), and, for an account, its explorer page. */
export interface RecordRow {
  term: string;
  value: string;
  link?: { url: string; after: string };
}

/** What a set of rows shares, said once: each term over its value. The console and the chain draw theirs with it. */
export function TermRecord({ rows }: { rows: readonly RecordRow[] }) {
  return (
    <dl className={p.record}>
      {rows.map((r) => (
        <div key={r.term}>
          <dt className={p.label}>{r.term}</dt>
          <dd>
            {r.link === undefined ? (
              <KeepRich text={r.value} />
            ) : (
              <Away href={r.link.url} after={r.link.after}>
                <KeepRich text={r.value} />
              </Away>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const PILL_TONE: Readonly<Record<StatusTone, string | undefined>> = {
  live: s.live,
  work: s.work,
  plan: s.plan,
};

/**
 * A STATUS row's pill, in the page's one status style (site.module.css `.pill` and its tones): Compare and Integrate
 * draw it here, and only here. Its words and tone come from the row, never from here. `prefix` reads "Status: " before
 * it where no column head names it. A hyphenated word in it (rules-only) never splits, and a pill whose words wrap
 * takes a smaller radius (parts.module.css .pill), so that two lines do not read as a blob.
 */
export function StatusPill({
  row,
  prefix = true,
}: {
  row: Parameters<typeof statusOf>[0];
  prefix?: boolean;
}) {
  const st = statusOf(row);
  return (
    <span className={`${s.pill} ${s.pillInline} ${p.pill} ${PILL_TONE[st.tone]}`}>
      {prefix ? <span className="sr-only">{INTEGRATE.statusPrefix}</span> : null}
      <Keep text={st.pill} />
    </span>
  );
}
