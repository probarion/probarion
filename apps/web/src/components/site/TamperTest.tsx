"use client";

import type { CheckId, Snapshot } from "@probarion/core";
import { type ReactNode, useRef, useState } from "react";
import type { LedgerRow, TamperEdit, TamperEditId, TamperResult } from "@/lib/site/tamper";
import { checkView, resultSummary, runVerifier } from "@/lib/site/tamper-view";
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

function Result({
  result,
  checks,
  live,
  copy,
}: {
  result: TamperResult;
  checks: readonly { id: CheckId; label: string }[];
  live: boolean;
  copy: TamperCopy;
}) {
  return (
    <>
      <div className={s.verdict} aria-atomic="true">
        <b className={result.ok ? s.pass : s.fail}>{result.ok ? "PASS" : "FAIL"}</b>
        <span>{resultSummary(result, copy.firstBroken)}</span>
      </div>
      <ul className={s.checks}>
        {checks.map(({ id, label }) => {
          const { word, bad, why, caveat } = checkView(result.checks.find((c) => c.id === id));
          return (
            <li key={id} className={bad ? s.checkBad : undefined} aria-atomic="true">
              <span className={s.checkId}>{id}</span>
              <span>{label}</span>
              <span className={s.checkWord}>{word}</span>
              {why === "" ? null : <span className={s.why}>{why}</span>}
              {caveat === "" ? null : <span className={s.caveat}>{caveat}</span>}
            </li>
          );
        })}
      </ul>
      <p className={s.sheetNote}>{live ? copy.live : copy.recorded}</p>
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
}: {
  rows: readonly LedgerRow[];
  checks: readonly { id: CheckId; label: string }[];
  edits: readonly TamperEdit[];
  recorded: TamperResult;
  copy: TamperCopy;
  source: ReactNode;
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
          <span className={active === undefined ? undefined : s.edited}>
            {active?.summary ?? copy.atRest}
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
        <Result result={shown.result} checks={checks} live={shown.live} copy={copy} />
        {failed === null ? null : (
          <p className={s.sheetError}>
            {failed === "load_failed" ? copy.loadFailed : copy.runFailed}
          </p>
        )}
      </div>
    </div>
  );
}
