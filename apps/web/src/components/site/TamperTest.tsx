"use client";

import type { CheckId, Snapshot } from "@probarion/core";
import { type ReactNode, useId, useRef, useState } from "react";
import type { LedgerRow, TamperEdit, TamperEditId, TamperResult } from "@/lib/site/tamper";
import {
  checkView,
  notRunLine,
  offersNext,
  plainVerdict,
  resultSummary,
  runVerifier,
  statusLine,
  VERIFIER_DETAIL,
} from "@/lib/site/tamper-view";
import { LIST, Outcome, type OutcomeTone, PartHead } from "./bits";
import { ScrollRegion } from "./ScrollRegion";
import s from "./site.module.css";
import t from "./tamper.module.css";

type Verify = (id: TamperEditId | null) => Promise<TamperResult>;

/** The verifier and the fixture load on the first click and not before, so neither is in the first-load bundle. */
async function loadVerifier(): Promise<Verify> {
  const [{ verifyTamper }, fixture] = await Promise.all([
    import("@/lib/site/tamper"),
    import("@/lib/site/valid-snapshot.json"),
  ]);
  const snapshot = fixture.default as unknown as Snapshot;
  return (id) => verifyTamper(snapshot, id);
}

export interface TamperCopy {
  editsTitle: string;
  editsNote: string;
  sheetTitle: string;
  atRest: string;
  notRun: string;
  caption: string;
  resultTitle: string;
  recorded: string;
  live: string;
  restore: string;
  running: string;
  firstBroken: string;
  loadFailed: string;
  runFailed: string;
  noScript: string;
  /** The summary of the fold the checks sit in, where they fold (`foldChecks`). */
  checksFold: string;
  /** What a screen reader names the checks that did not pass, beside the verdict while the checks are folded. */
  failingLabel: string;
}

/** The label keeps its place while the button is busy, so that the button does not change size. */
function ActLabel({ label, busy, running }: { label: string; busy: boolean; running: string }) {
  return (
    <>
      <span className={busy ? s.actHidden : undefined}>{label}</span>
      {busy ? <span className={s.actBusy}>{running}</span> : null}
    </>
  );
}

function Row({ row, edit }: { row: LedgerRow; edit: TamperEdit | undefined }) {
  const hit = edit?.seq === row.seq ? edit : undefined;
  const erased = hit?.change.erased === true;
  return (
    <tr className={erased ? s.erased : hit === undefined ? undefined : s.hit}>
      <td>{row.seq}</td>
      <td>{row.kind}</td>
      <td>
        {hit?.change.outcome ?? row.outcome}
        {hit === undefined ? null : <span className={s.rowNote}>{hit.rowNote}</span>}
      </td>
      <td>{row.mandate}</td>
      <td className={s.num}>{hit?.change.amount ?? row.amount}</td>
    </tr>
  );
}

/** The counts, with "First broken entry: N" kept on one line, so that a narrow screen does not leave N alone. */
function Counts({ summary, firstBroken }: { summary: string; firstBroken: string }) {
  const at = summary.indexOf(firstBroken);
  if (at <= 0) return summary;
  return (
    <>
      {summary.slice(0, at)}
      <span className={t.keep}>{summary.slice(at)}</span>
    </>
  );
}

/** A check's word with the page's outcome mark: a pass a dot, a failure a struck circle, the rest (skipped, not
 * proven, not run) an empty ring. The words are the verifier's own. */
const checkTone = (word: string, bad: boolean): OutcomeTone =>
  !bad ? "paid" : word === "fail" ? "refused" : "none";

/**
 * The verifier's result. Its title, then one block read whole, the only part announced when it changes: PASS or FAIL,
 * one plain sentence, the counts when they say more than that sentence, and whether this is the recorded result or a
 * run just now. Under that block, in a live region of its own so that a press that did not finish does not read the
 * old verdict again as new: `next`, which TamperTest passes only when `offersNext`, and `error`. Then each check's
 * word, read on demand and never announced, and the verifier's own words on the checks that did not pass, in a closed
 * disclosure. With `foldChecks` the checks sit in a closed fold of their own (the landing), and the ones that did not
 * pass stay named under the verdict, each by its letter, its name and its word.
 */
export function TamperVerdict({
  result,
  checks,
  live,
  copy,
  next,
  error,
  busy = false,
  foldChecks = false,
}: {
  result: TamperResult;
  checks: readonly { id: CheckId; label: string; hint: string }[];
  live: boolean;
  copy: TamperCopy;
  next?: ReactNode;
  /** What to say when the last press produced no result. */
  error?: string;
  /** While a press is running: the verdict block is busy, so it is not read until the new one is in. */
  busy?: boolean;
  /** The checks fold under `copy.checksFold`, and the ones that did not pass are named under the verdict. */
  foldChecks?: boolean;
}) {
  const views = checks.map(({ id, label, hint }) => ({
    id,
    label,
    hint,
    ...checkView(result.checks.find((c) => c.id === id)),
  }));
  const explained = views.filter((v) => v.why !== "");
  const failing = foldChecks ? views.filter((v) => v.bad) : [];
  const list = (
    <ul className={`${t.grid} ${t.checks}`} {...LIST}>
      {views.map(({ id, label, hint, word, bad, caveat }) => (
        <li key={id} className={bad ? `${t.check} ${t.checkBad}` : t.check}>
          <span className={t.checkId}>{id}</span>
          <span className={t.checkLabel}>{label}</span>
          <Outcome tone={checkTone(word, bad)} className={t.checkWord}>
            {word}
          </Outcome>
          <span className={t.checkHint}>{hint}</span>
          {caveat === "" ? null : <span className={t.caveat}>{caveat}</span>}
        </li>
      ))}
    </ul>
  );
  const plain = plainVerdict(result, copy.firstBroken);
  const summary = resultSummary(result, copy.firstBroken);
  return (
    <>
      <PartHead title={copy.resultTitle} />
      <div
        className={`${t.grid} ${t.verdict}`}
        aria-live="polite"
        aria-atomic="true"
        aria-busy={busy}
      >
        <b className={`${t.word} ${result.ok ? s.pass : s.fail}`}>{result.ok ? "PASS" : "FAIL"}</b>
        <p className={t.plain}>{plain}</p>
        {summary === plain ? null : (
          <p className={t.counts}>
            <Counts summary={summary} firstBroken={copy.firstBroken} />
          </p>
        )}
        <p className={t.note}>{live ? copy.live : copy.recorded}</p>
      </div>
      {failing.length === 0 ? null : (
        <div className={`${t.grid} ${t.after}`}>
          <ul className={t.failing} aria-label={copy.failingLabel} {...LIST}>
            {failing.map(({ id, label, word }) => (
              <li key={id} className={t.failingCheck}>
                <span className={t.checkId}>{id}</span>{" "}
                <span className={t.checkLabel}>{label}</span>{" "}
                <Outcome tone={checkTone(word, true)} className={t.failingWord}>
                  {word}
                </Outcome>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Always in the page, so that what comes into it is announced; with nothing in it, it takes no room. */}
      <div
        className={next === undefined && error === undefined ? undefined : `${t.grid} ${t.after}`}
        aria-live="polite"
      >
        {next}
        {error === undefined ? null : <p className={t.runError}>{error}</p>}
      </div>
      {foldChecks ? (
        <details className={t.checksFold}>
          <summary className={t.checksSummary}>{copy.checksFold}</summary>
          {list}
        </details>
      ) : (
        list
      )}
      {explained.length === 0 ? null : (
        <details className={t.detail}>
          <summary>{VERIFIER_DETAIL}</summary>
          <ul>
            {explained.map(({ id, why }) => (
              <li key={id}>
                <span className={t.checkId}>{id}</span>
                <span className={t.why}>{why}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * The ledger test. At rest it shows what the server read from the fixture and the recorded result. Each button runs the
 * real `runChecks` on an edited copy, in the visitor's browser, and shows what the verifier said, in its own words.
 * The bench comes first: the edits beside the signed ledger they change (stacked under 961px), then the readout.
 */
export function TamperTest({
  rows,
  checks,
  edits,
  recorded,
  copy,
  source,
  next,
  foldChecks = false,
}: {
  rows: readonly LedgerRow[];
  checks: readonly { id: CheckId; label: string; hint: string }[];
  edits: readonly TamperEdit[];
  recorded: TamperResult;
  copy: TamperCopy;
  /** The sheet's foot, from the server: the fixture and the verifier on GitHub. */
  source: ReactNode;
  /** Where to go once the verifier has caught an edit. Left out where the page already gives the next step. */
  next?: ReactNode;
  /** The checks fold, on the landing: see TamperVerdict. */
  foldChecks?: boolean;
}) {
  const ids = useId();
  const verifier = useRef<Promise<Verify> | null>(null);
  const [shown, setShown] = useState<{
    edit: TamperEditId | null;
    result: TamperResult;
    live: boolean;
  }>({ edit: null, result: recorded, live: false });
  const [busy, setBusy] = useState<TamperEditId | "restore" | null>(null);
  const [failed, setFailed] = useState<"load_failed" | "run_failed" | null>(null);

  async function run(edit: TamperEditId | null) {
    if (busy !== null) return;
    setBusy(edit ?? "restore");
    setFailed(null);
    const load = () => {
      verifier.current ??= loadVerifier();
      return verifier.current;
    };
    const attempt = await runVerifier(load, edit);
    if (attempt.outcome === "done") {
      setShown({ edit, result: attempt.result, live: true });
    } else {
      if (attempt.outcome === "load_failed") verifier.current = null; // the next click tries the import again
      setFailed(attempt.outcome);
    }
    setBusy(null);
  }

  const active = edits.find((e) => e.id === shown.edit);
  const editsTitle = `${ids}-edits`;
  return (
    <div className={t.tamper}>
      <div className={`${t.grid} ${t.bench}`}>
        <div className={t.rail}>
          <PartHead title={copy.editsTitle} id={editsTitle} note={copy.editsNote} />
          <ul className={t.edits} aria-labelledby={editsTitle} {...LIST}>
            {edits.map(({ id, label, effect }) => (
              <li key={id} className={t.edit}>
                <button
                  type="button"
                  className={s.act}
                  aria-pressed={shown.edit === id}
                  aria-busy={busy === id}
                  aria-disabled={busy !== null}
                  aria-describedby={`${ids}-${id}`}
                  onClick={() => run(id)}
                >
                  <ActLabel label={label} busy={busy === id} running={copy.running} />
                </button>
                <p className={t.editWhat} id={`${ids}-${id}`}>
                  {effect}
                </p>
              </li>
            ))}
          </ul>
          <noscript>
            <p className={t.noScript}>{copy.noScript}</p>
          </noscript>
          <div className={t.restore}>
            <button
              type="button"
              className={`${s.act} ${s.actQuiet}`}
              aria-busy={busy === "restore"}
              aria-disabled={busy !== null || shown.edit === null}
              onClick={() => {
                if (shown.edit !== null) run(null);
              }}
            >
              <ActLabel label={copy.restore} busy={busy === "restore"} running={copy.running} />
            </button>
          </div>
        </div>
        <div className={`${s.sheet} ${t.ledger}`}>
          <div className={s.sheetHead}>
            <span className={t.sheetTitle}>{copy.sheetTitle}</span>
            <span className={active === undefined && failed === null ? undefined : s.edited}>
              {failed === null
                ? statusLine(shown.result.ok, active?.summary ?? copy.atRest)
                : notRunLine(copy.notRun)}
            </span>
          </div>
          <ScrollRegion className={s.scroll} label={copy.caption}>
            <table className={s.table}>
              <caption className="sr-only">{copy.caption}</caption>
              <thead>
                <tr>
                  <th scope="col">Seq</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Mandate</th>
                  <th scope="col">Amount, USDC</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Row key={row.seq} row={row} edit={active} />
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          {source}
        </div>
      </div>
      <div className={t.readout}>
        <TamperVerdict
          busy={busy !== null}
          foldChecks={foldChecks}
          result={shown.result}
          checks={checks}
          live={shown.live}
          copy={copy}
          next={offersNext(shown, failed !== null) ? next : undefined}
          error={
            failed === null
              ? undefined
              : failed === "load_failed"
                ? copy.loadFailed
                : copy.runFailed
          }
        />
      </div>
    </div>
  );
}
