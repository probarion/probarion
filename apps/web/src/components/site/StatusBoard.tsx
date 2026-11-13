import Link from "next/link";
import type { ReactNode } from "react";
import { ExternalLink } from "@/components/ui";
import {
  BOARD_GROUPS,
  type BoardEvidence,
  type BoardItem,
  type BoardPart,
  type CopyPart,
  EVIDENCE_KINDS,
  type ProofMark,
  proofSummary,
  REAL_MONEY_KINDS,
  RESULT_KINDS,
  STATUS,
  STATUS_BOARD,
  STATUS_KEY,
  type UseMark,
} from "@/lib/site/facts";
import { Rich } from "./Rich";
import s from "./site.module.css";
import b from "./status.module.css";

/**
 * The lists say their role out loud: Tailwind's preflight sets list-style: none, and Safari's VoiceOver then drops
 * list semantics (as in BuiltOn.tsx). Spread from here because Biome's noRedundantRoles reads the markup.
 */
const LIST = { role: "list" } as const;
/**
 * A list of the key, named by its label: a `dl` takes no name of its own in ARIA in HTML, so its box is a named group.
 * Spread from here too: Biome's useSemanticElements would make it a fieldset, which is for form controls.
 */
const namedGroup = (labelledBy: string) =>
  ({ role: "group", "aria-labelledby": labelledBy }) as const;

type Mark = ProofMark | UseMark;

const WORD: Readonly<Record<Mark, string>> = Object.fromEntries(
  [...STATUS_KEY.proof.marks, ...STATUS_KEY.use.marks].map((m) => [m.id, m.word]),
) as Record<Mark, string>;

const MARK_CLASS: Readonly<Record<Mark, string | undefined>> = {
  verified: b.mVerified,
  part: b.mPart,
  untried: b.mUntried,
  running: b.mRunning,
  released: b.mReleased,
};

/** A mark's shape, in the colour of its word's class. Shape and word carry the meaning; colour only repeats it. */
function Glyph({ mark }: { mark: Mark }) {
  return (
    <svg className={b.glyph} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      {mark === "verified" ? (
        <path
          d="M2.6 7.4l2.8 2.7L11.4 3.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : mark === "part" ? (
        <>
          <circle cx="7" cy="7" r="4.9" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7 2.1a4.9 4.9 0 0 0 0 9.8z" fill="currentColor" />
        </>
      ) : mark === "untried" ? (
        <circle
          cx="7"
          cy="7"
          r="4.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeDasharray="2.2 1.57"
        />
      ) : mark === "running" ? (
        <circle cx="7" cy="7" r="4.1" fill="currentColor" />
      ) : (
        <rect
          x="3.6"
          y="3.6"
          width="6.8"
          height="6.8"
          transform="rotate(45 7 7)"
          fill="currentColor"
        />
      )}
    </svg>
  );
}

function MarkWord({ mark }: { mark: Mark }) {
  return (
    <span className={`${b.mark} ${MARK_CLASS[mark]}`}>
      <Glyph mark={mark} />
      <span>{WORD[mark]}</span>
    </span>
  );
}

/** A row's marks: proof first, always in the same place, then its use where it has one. */
function Marks({ proof, use }: { proof: ProofMark; use?: UseMark }) {
  return (
    <ul className={b.marks} aria-label={STATUS_BOARD.marksLabel} {...LIST}>
      <li>
        <span className="sr-only">{STATUS_KEY.proof.label}: </span>
        <MarkWord mark={proof} />
      </li>
      {use === undefined ? null : (
        <li>
          <span className="sr-only">{STATUS_KEY.use.label}: </span>
          <MarkWord mark={use} />
        </li>
      )}
    </ul>
  );
}

/** `#id` stays on this page, a path of this site opens in this tab, and a full URL in a new one. */
function Href({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  if (href.startsWith("#")) {
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  }
  if (href.startsWith("/")) {
    return (
      <Link className={className} href={href}>
        {children}
      </Link>
    );
  }
  return (
    <ExternalLink className={className} href={href}>
      {children}
    </ExternalLink>
  );
}

function Parts({ parts }: { parts: readonly CopyPart[] }) {
  return parts.map((p) =>
    typeof p === "string" ? (
      <Rich key={p} text={p} />
    ) : (
      <Href key={p.href} className={s.link} href={p.href}>
        {p.label}
      </Href>
    ),
  );
}

/** A row's records: what kind each is, the link, then its amount or result (a check's result in ink). */
function Evidence({ list }: { list: readonly BoardEvidence[] }) {
  return (
    <ul className={b.ev} aria-label={STATUS_BOARD.evidenceLabel} {...LIST}>
      {list.map((e) => (
        <li key={`${e.kind} ${e.label}`}>
          <span
            className={`${b.evKind} ${REAL_MONEY_KINDS.includes(e.kind) ? b.evReal : ""}`}
            data-kind={e.kind}
          >
            {EVIDENCE_KINDS[e.kind]}
            <span className="sr-only">: </span>
          </span>
          <span className={b.evBody}>
            <Href className={b.evLink} href={e.href}>
              {e.label}
            </Href>
            {e.note === undefined ? null : (
              <span className={`${b.evNote} ${RESULT_KINDS.includes(e.kind) ? b.evResult : ""}`}>
                <span className="sr-only">, </span>
                {e.note}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Limit({ text }: { text: string }) {
  return (
    <p className={b.limit}>
      <span className={b.limitLabel}>{STATUS_BOARD.limitLabel}</span> <Rich text={text} />
    </p>
  );
}

function Part({ part }: { part: BoardPart }) {
  return (
    <li
      className={`${b.part} ${part.untried === undefined ? "" : b.partUntried}`}
      id={part.id}
      data-row={part.id}
      data-status={part.status}
    >
      {/* The date sits beside the name, in the part's title line, not in a paragraph of its own. */}
      <div className={b.partHead}>
        <h5 className={b.partTitle}>{part.name}</h5>
        {part.tried === undefined ? null : <span className={b.tried}>{part.tried}</span>}
      </div>
      <Marks proof={part.proof} />
      {part.what === undefined ? null : (
        <p className={b.what}>
          <Rich text={part.what} />
        </p>
      )}
      {part.untried === undefined ? null : (
        <ul className={b.untriedList} {...LIST}>
          {part.untried.map((u) => (
            <li key={u.area}>
              <span className={b.untriedArea}>{u.area}:</span> <Rich text={u.what} />{" "}
              <span className={b.untriedWhy}>
                <Rich text={u.why} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <Evidence list={part.evidence} />
    </li>
  );
}

function Row({ item }: { item: BoardItem }) {
  // A row with real USDC says so in its Where line too, in bold: no new colour.
  const real = item.evidence.some((e) => REAL_MONEY_KINDS.includes(e.kind));
  return (
    <li className={b.row} id={item.id} data-row={item.id} data-status={item.status}>
      <h4 className={b.rowTitle}>{item.name}</h4>
      <Marks proof={item.proof} use={item.use} />
      <p className={b.what}>
        <Rich text={item.what} />
      </p>
      {item.limit === undefined ? null : <Limit text={item.limit} />}
      <p className={b.where} data-real={real ? "true" : undefined}>
        <span className={b.whereLabel}>{STATUS_BOARD.whereLabel}</span>{" "}
        <span className={real ? b.whereReal : undefined}>{item.where.place}</span>
        {item.where.detail === undefined ? null : (
          <span className={b.whereDetail}>
            <span className="sr-only">, </span>
            <Rich text={item.where.detail} />
          </span>
        )}
      </p>
      <Evidence list={item.evidence} />
      {item.parts === undefined ? null : <RowParts name={item.name} parts={item.parts} />}
    </li>
  );
}

/**
 * A row's parts. The ones tried for real fold under a line that names them, so the row stays short to scan and each
 * part's record is one click away (a link to a part's id opens the fold). What is left to try always shows.
 */
function RowParts({ name, parts }: { name: string; parts: readonly BoardPart[] }) {
  const tried = parts.filter((p) => p.untried === undefined);
  const left = parts.filter((p) => p.untried !== undefined);
  const label = `Parts of the ${name.toLowerCase()}`;
  return (
    <div className={b.parts}>
      {tried.length === 0 ? null : (
        <details className={b.fold}>
          <summary className={b.foldSummary}>
            <span className={b.foldLead}>
              {STATUS_BOARD.partsFold.lead.replace("{names}", tried.map((p) => p.name).join(", "))}
            </span>{" "}
            <span className={b.foldHint}>{STATUS_BOARD.partsFold.hint}</span>
          </summary>
          <ul className={b.partList} aria-label={`${label}, tried`} {...LIST}>
            {tried.map((p) => (
              <Part key={p.id} part={p} />
            ))}
          </ul>
        </details>
      )}
      {left.length === 0 ? null : (
        <ul className={b.partList} aria-label={`${label}, left to try`} {...LIST}>
          {left.map((p) => (
            <Part key={p.id} part={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The answer first: one line a proof mark, computed from the board. Verified gives its count; the other two name each
 * row, which links to it, and what it misses.
 */
function Summary() {
  return (
    <ul className={b.summary} aria-label={STATUS_BOARD.summaryLabel} {...LIST}>
      {proofSummary().map((line) => (
        <li key={line.mark} className={b.sumLine} data-mark={line.mark}>
          <span className={b.sumMark}>
            <MarkWord mark={line.mark} />
            <span className="sr-only">: </span>
          </span>
          <span className={b.sumText}>
            {line.rows.length === 0
              ? `${line.count}.`
              : line.rows.map((r) => (
                  <span key={r.id} className={b.sumRow}>
                    <a className={s.link} href={`#${r.id}`}>
                      {r.name}
                    </a>
                    : {r.missing}
                    {". "}
                  </span>
                ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The key: what each mark means, in two short lists. */
function Key() {
  return (
    <div className={b.key}>
      {(["proof", "use"] as const).map((k) => {
        const group = STATUS_KEY[k];
        const id = `status-key-${k}`;
        return (
          <div key={k} className={b.keyGroup} {...namedGroup(id)}>
            <p className={b.keyLabel} id={id}>
              {group.label} <span>{group.note}</span>
            </p>
            <dl className={b.keyList}>
              {group.marks.map((m) => (
                <div key={m.id} className={b.keyRow} data-mark={m.id}>
                  <dt>
                    <MarkWord mark={m.id} />
                  </dt>
                  <dd className={b.keyMeans}>{m.means}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function KnownGaps() {
  const gaps = STATUS.gaps;
  return (
    <div className={b.gapsBlock}>
      <div className={b.gapsHead}>
        <h3 className={b.gapsTitle} id={gaps.id}>
          {gaps.title}
        </h3>
        <p>{gaps.sub}</p>
      </div>
      <div className={b.gapCols}>
        {gaps.lists.map((l) => (
          <div key={l.id} className={b.gapCol}>
            <h4 className={b.gapTitle} id={l.id}>
              {l.title}
            </h4>
            <ul className={b.gaps} {...LIST}>
              {l.items.map((g) => (
                <li key={g.lead}>
                  <strong className={b.gapLead}>{g.lead}</strong> <Parts parts={g.parts} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * What works today, and what does not: the summary, the key, four groups of rows on one set of columns, what else is
 * built, and the known gaps, which close the section. Each row answers two questions, was it tried for real (proof)
 * and can you reach it now (use), and links its record.
 */
export function StatusBoard() {
  return (
    <section className={`${s.section} ${s.flush}`} id="status">
      <div className={`${s.wrap} ${b.board}`}>
        <p className={s.eyebrow}>{STATUS_BOARD.eyebrow}</p>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{STATUS.title}</h2>
          <p>{STATUS_BOARD.lede}</p>
        </div>
        <Summary />
        <Key />
        {BOARD_GROUPS.map((g) => (
          <div key={g.id} className={b.group} data-group={g.id}>
            <div className={b.groupHead}>
              <div className={b.groupName}>
                <h3 className={b.groupTitle}>{g.title}</h3>
                <p>{g.sub}</p>
              </div>
              <span className={`${b.colLabel} ${b.colMarks}`} aria-hidden="true">
                <span>{STATUS_BOARD.columns.proof}</span>
                <span>{STATUS_BOARD.columns.use}</span>
              </span>
              <span className={b.colLabel} aria-hidden="true">
                {STATUS_BOARD.columns.where}
              </span>
              <span className={b.colLabel} aria-hidden="true">
                {STATUS_BOARD.columns.evidence}
              </span>
            </div>
            <ul className={b.rows} {...LIST}>
              {g.items.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </ul>
          </div>
        ))}
        <div className={b.notes}>
          <h3 className={b.notesTitle}>{STATUS_BOARD.notesTitle}</h3>
          <p className={b.note}>
            <Parts parts={STATUS_BOARD.footer} />
          </p>
          <p className={b.note}>
            <Rich text={STATUS.checked} />
          </p>
        </div>
        <KnownGaps />
      </div>
    </section>
  );
}
