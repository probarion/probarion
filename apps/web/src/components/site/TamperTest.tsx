"use client";

import type { CheckId, Snapshot } from "@probarion/core";
import { type ReactNode, useRef, useState } from "react";
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
import { ScrollRegion } from "./ScrollRegion";
import s from "./site.module.css";

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
  sheetTitle: string;
  atRest: string;
  notRun: string;
  caption: string;
  recorded: string;
  live: string;
  restore: string;
  running: string;
  firstBroken: string;
  loadFailed: string;
  runFailed: string;
  noScript: string;
}

/** The label keeps its place while the button is busy, so that the row of buttons does not reflow. */
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

/**
 * The verdict panel: PASS or FAIL with one plain sentence, each check's word, and the verifier's own words on the
 * checks that did not pass in a closed disclosure. `next` goes last; TamperTest passes it only when `offersNext`.
 */
export function TamperVerdict({
  result,
  checks,
  live,
  copy,
  next,
}: {
  result: TamperResult;
  checks: readonly { id: CheckId; label: string; hint: string }[];
  live: boolean;
  copy: TamperCopy;
  next?: ReactNode;
}) {
  const views = checks.map(({ id, label, hint }) => ({
    id,
    label,
    hint,
    ...checkView(result.checks.find((c) => c.id === id)),
  }));
  const explained = views.filter((v) => v.why !== "");
  return (
    <>
      <div className={s.verdict} aria-atomic="true">
        <b className={result.ok ? s.pass : s.fail}>{result.ok ? "PASS" : "FAIL"}</b>
        <span>{plainVerdict(result, copy.firstBroken)}</span>
      </div>
      <ul className={s.checks}>
        {views.map(({ id, label, hint, word, bad, caveat }) => (
          <li key={id} className={bad ? s.checkBad : undefined} aria-atomic="true">
            <span className={s.checkId}>{id}</span>
            <span>{label}</span>
            <span className={s.checkWord}>{word}</span>
            <span className={s.checkHint}>{hint}</span>
            {caveat === "" ? null : <span className={s.caveat}>{caveat}</span>}
          </li>
        ))}
      </ul>
      {explained.length === 0 ? null : (
        <details className={s.detail}>
          <summary>{VERIFIER_DETAIL}</summary>
          <p>{resultSummary(result, copy.firstBroken)}</p>
          <ul>
            {explained.map(({ id, why }) => (
              <li key={id}>
                <span className={s.checkId}>{id}</span>
                <span className={s.why}>{why}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className={s.sheetNote}>{live ? copy.live : copy.recorded}</p>
      {next}
    </>
  );
}

/**
 * The ledger test. At rest it shows what the server read from the fixture and the recorded result. Each button runs the
 * real `runChecks` on an edited copy, in the visitor's browser, and shows what the verifier said, in its own words.
 */
export function TamperTest({
  rows,
  checks,
  edits,
  recorded,
  copy,
  source,
  next,
}: {
  rows: readonly LedgerRow[];
  checks: readonly { id: CheckId; label: string; hint: string }[];
  edits: readonly TamperEdit[];
  recorded: TamperResult;
  copy: TamperCopy;
  source: ReactNode;
  /** Where to go once the verifier has caught an edit. Left out where the page already gives the next step. */
  next?: ReactNode;
}) {
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
  return (
    <div className={s.tamper}>
      <div className={s.sheet}>
        <div className={s.sheetHead}>
          <span>{copy.sheetTitle}</span>
          <span className={active === undefined && failed === null ? undefined : s.edited}>
            {failed === null
              ? statusLine(shown.result.ok, active?.summary ?? copy.atRest)
              : notRunLine(copy.notRun)}
          </span>
        </div>
        <div className={s.sheetActions}>
          <div className={s.actions}>
            {edits.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={s.act}
                aria-pressed={shown.edit === id}
                aria-busy={busy === id}
                aria-disabled={busy !== null}
                onClick={() => run(id)}
              >
                <ActLabel label={label} busy={busy === id} running={copy.running} />
              </button>
            ))}
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
          <noscript>
            <p className={s.source}>{copy.noScript}</p>
          </noscript>
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
        <div className={s.sheetFoot}>{source}</div>
      </div>
      <div className={s.sheet} aria-live="polite" aria-busy={busy !== null}>
        <TamperVerdict
          result={shown.result}
          checks={checks}
          live={shown.live}
          copy={copy}
          next={offersNext(shown, failed !== null) ? next : undefined}
        />
        {failed === null ? null : (
          <p className={s.sheetError}>
            {failed === "load_failed" ? copy.loadFailed : copy.runFailed}
          </p>
        )}
      </div>
    </div>
  );
}
