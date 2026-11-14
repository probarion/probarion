import { createElement, Fragment, type ReactNode } from "react";
import { richParts } from "@/lib/site/rich";
import p from "./parts.module.css";

/*
 * The small pieces the landing's sections share, drawn one way, that a client component may use too (they import no
 * facts and no route table): the new-tab arrow, an outcome with its mark, a part's head, and the helpers that keep an
 * identifier or a label's end whole on its line. The pieces that read facts.ts are in parts.tsx. Their look is
 * parts.module.css; a section's module lays them out and never restyles them.
 */

/**
 * A list's role, said out loud: the stylesheets remove the markers, and Safari then drops a list's semantics. It is
 * spread from here because Biome's noRedundantRoles reads the markup, not the stylesheet.
 */
export const LIST = { role: "list" } as const;

/** ↗ after a link that leaves this site: muted, never underlined, hidden from screen readers (ExternalLink says it). */
export function NewTab() {
  return (
    <span className={p.ext} aria-hidden="true">
      ↗
    </span>
  );
}

/** The end of a link and its arrow, on one line: the arrow never wraps alone onto the next one. */
export function Glued({ children }: { children: ReactNode }) {
  return (
    <span className={p.glue}>
      {children}
      <NewTab />
    </span>
  );
}

/**
 * Identifiers that must not break at a hyphen: ISO dates, invoice numbers, NEAR accounts, a word of two short
 * hyphenated parts (rules-only), and short ranges ("0 to 2", "10 to 13"). A long hash is never one: it stays free to
 * break (WCAG 1.4.10).
 */
const KEEP =
  /\d{4}-\d{2}-\d{2}|INV-[A-Z]?\d+|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:testnet|near)\b|\b[a-z]+-[a-z]+\b|\b\d+ to \d+\b/g;

/** The spans of `text` that KEEP holds whole, as [start, end) pairs. */
function kept(text: string): [number, number][] {
  return [...text.matchAll(KEEP)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/** A run of plain text with every identifier in it (KEEP) on one line. */
export function Keep({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const [a, b] of kept(text)) {
    if (a > last) out.push(text.slice(last, a));
    out.push(createElement("span", { className: p.keep }, text.slice(a, b)));
    last = b;
  }
  if (last < text.length) out.push(text.slice(last));
  return createElement(Fragment, null, ...out);
}

/**
 * A line of copy as Rich reads it (backticks are code), with its identifiers kept whole: in the text by Keep, and a
 * short code span with a hyphen in it (an account) on one line too.
 */
export function KeepRich({ text }: { text: string }) {
  // Spread as children, so they need no keys; a loop, so that the linter does not read them as a keyed list.
  const parts: ReactNode[] = [];
  for (const x of richParts(text)) {
    const short = x.text.includes("-") && x.text.length <= 40;
    parts.push(
      x.code
        ? createElement("code", short ? { className: p.keep } : null, x.text)
        : createElement(Keep, { text: x.text }),
    );
  }
  return createElement(Fragment, null, ...parts);
}

/** A label whose last part, after its last ", " (an entry, a date, a transaction), never splits. */
export function KeepLast({ text }: { text: string }) {
  const cut = text.lastIndexOf(", ") + 2;
  if (cut < 2) return text;
  return (
    <>
      {text.slice(0, cut)}
      <span className={p.keep}>{text.slice(cut)}</span>
    </>
  );
}

/**
 * A link's words with the arrow glued to their end. The glued part is a short part after the last ", " (an entry, a
 * date: "entry 3", "2026-11-09"), or else the last word; a long last word (a file name) is cut at its last hyphen
 * outside an identifier, so "invoice-INV-2001.txt" wraps as "invoice-" and "INV-2001.txt".
 */
export function ArrowLabel({ text }: { text: string }) {
  const comma = text.lastIndexOf(", ");
  let cut = comma >= 0 && text.length - comma - 2 <= 16 ? comma + 2 : text.lastIndexOf(" ") + 1;
  if (text.length - cut > 14 && !text.slice(cut).includes(" ")) {
    const holds = kept(text);
    for (let i = text.length - 1; i > cut; i -= 1) {
      if (text[i - 1] === "-" && !holds.some(([a, b]) => i > a && i < b)) {
        cut = i;
        break;
      }
    }
  }
  return (
    <>
      <KeepRich text={text.slice(0, cut)} />
      <Glued>
        <KeepRich text={text.slice(cut)} />
      </Glued>
    </>
  );
}

/**
 * A file path or an account, in mono, with the arrow glued to its last segment only: a long path may break after
 * each "/", and an account (one segment) stays whole. The two code runs read as one, since code draws no box here.
 */
export function CodeLabel({ text }: { text: string }) {
  const cut = text.lastIndexOf("/") + 1;
  const dirs: ReactNode[] = [];
  for (const d of text.slice(0, cut).split("/").slice(0, -1))
    dirs.push(`${d}/`, createElement("wbr"));
  return (
    <>
      {cut === 0 ? null : createElement("code", null, ...dirs)}
      <Glued>
        <code>{text.slice(cut)}</code>
      </Glued>
    </>
  );
}

/**
 * A transaction as evidence, as every section shows one: its words in the text face, then the short hash (the last
 * word) in mono with the arrow glued to it. `label` is "<words>, tx <hash>" (facts' txEvidence), "<verb> <hash>", or
 * the hash alone.
 */
export function TxLabel({ label }: { label: string }) {
  const at = label.lastIndexOf(" ") + 1;
  return (
    <>
      {label.slice(0, at)}
      <Glued>
        <span className={p.hash}>{label.slice(at)}</span>
      </Glued>
    </>
  );
}

/** An outcome's tone: paid (a dot), refused (a struck circle), held (half filled), or none (an empty ring). */
export type OutcomeTone = "paid" | "refused" | "held" | "none";

/**
 * The outcome's mark, in its tone (--mark), or else in the text's own colour: the live check's verdict draws its big
 * one with `className`. Its words always say the same, so it is hidden from screen readers.
 */
export function Mark({ tone, className = p.mark }: { tone: OutcomeTone; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {tone === "paid" ? (
        <circle className={p.fill} cx="6" cy="6" r="5" />
      ) : (
        <>
          <circle className={p.ring} cx="6" cy="6" r="4.6" />
          {tone === "refused" ? <path className={p.ring} d="M2.8 9.2 9.2 2.8" /> : null}
          {tone === "held" ? <path className={p.fill} d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" /> : null}
        </>
      )}
    </svg>
  );
}

const OUT_TONE: Readonly<Record<OutcomeTone, string | undefined>> = {
  paid: p.outPaid,
  refused: p.outRefused,
  held: p.outHeld,
  none: p.outNone,
};

/**
 * An outcome, or a verifier's result, in words with its mark: the page's one way to say what happened (the hero's
 * cards and mainnet record, the invoices, the chain's rows, the attested decisions, the ledger test's checks). The
 * filled pill is kept for what is shipped (parts.tsx StatusPill).
 */
export function Outcome({
  tone,
  children,
  className,
}: {
  tone: OutcomeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={
        className === undefined
          ? `${p.out} ${OUT_TONE[tone]}`
          : `${p.out} ${OUT_TONE[tone]} ${className}`
      }
    >
      <Mark tone={tone} />
      {children}
    </span>
  );
}

/**
 * A part of a section, under the section's head: a hairline, an optional quiet label, its title as an h3, and an
 * optional line under it, all on the head's left edge. Every part of every section opens this way.
 */
export function PartHead({
  title,
  id,
  note,
  label,
}: {
  title: string;
  id?: string;
  note?: ReactNode;
  label?: string;
}) {
  const heading = (
    <h3 className={p.partTitle} id={id}>
      {title}
    </h3>
  );
  return (
    <div className={p.partHead}>
      {label === undefined ? (
        heading
      ) : (
        <hgroup>
          <p className={p.partLabel}>{label}</p>
          {heading}
        </hgroup>
      )}
      {note === undefined ? null : <p className={p.partNote}>{note}</p>}
    </div>
  );
}
