import { Badge, ExternalLink, Notice } from "@/components/ui";
import {
  cliCommand,
  LEVEL_TONES,
  type ReadRow,
  type RequestEntry,
  readRows,
  utc,
  VERDICT_WORDS,
} from "./check-view";
import { CHECK_PAGE } from "./copy";
import type { DoneRun, FailedRun } from "./run";

// A finished check, as /check shows it: the verdict, its reasons, each read with where it came from, the requests the
// browser sent, and the same check as a CLI command. Pure: it renders what it is given, so a test renders it too.

const R = CHECK_PAGE.result;
const H3 = "mt-6 mb-2 text-base font-semibold";
const muted = "text-mute";
const link = "text-ink underline decoration-ink/60 underline-offset-2 hover:decoration-ink";
const CODE_BLOCK =
  "my-2 block whitespace-pre-wrap rounded-2xl bg-ink px-3 py-2 font-mono text-xs text-paper wrap-anywhere";

const ROW_STATE: Readonly<
  Record<ReadRow["state"], { tone: "good" | "warn" | "neutral"; label: string }>
> = {
  read: { tone: "good", label: "read" },
  unknown: { tone: "warn", label: "unknown" },
  not_read: { tone: "neutral", label: "not read" },
};

function Requests({ log }: { log: readonly RequestEntry[] }) {
  if (log.length === 0) return null;
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm font-medium">{R.requests(log.length)}</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Host
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Call
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Answer
              </th>
              <th scope="col" className="py-1 font-medium">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {log.map((e, i) => (
              // Requests repeat (a retry is the same call to the same host), so the order is the key.
              // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows, in order
              <tr key={i} className="border-t border-ink/10 align-top">
                <td className="py-1 pr-3 font-mono wrap-anywhere">{e.host}</td>
                <td className="py-1 pr-3 font-mono wrap-anywhere">{e.call}</td>
                <td className="py-1 pr-3">{e.answer}</td>
                <td className="py-1 tabular-nums whitespace-nowrap">{e.ms} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Reads({ rows }: { rows: readonly ReadRow[] }) {
  return (
    <ul className="divide-y divide-ink/10" data-check-reads>
      {rows.map((r) => {
        const state = ROW_STATE[r.state];
        return (
          <li key={r.id} className="py-3" data-read={r.id} data-state={r.state}>
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <p className="text-sm font-medium">{r.what}</p>
              <Badge tone={state.tone}>{state.label}</Badge>
            </div>
            <p className="mt-1 text-sm wrap-anywhere">{r.value}</p>
            <p className={`mt-1 text-xs ${muted}`}>{r.how}.</p>
            <p className={`mt-1 text-xs ${muted} wrap-anywhere`}>
              From: {r.from.length === 0 ? R.noRequest : r.from.join(", ")}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** A finished check. `shareHref` is the fragment link to the same check, when the page made one. */
export function CheckResult({ run, shareHref }: { run: DoneRun; shareHref?: string }) {
  const { assessment, input, signals, log } = run;
  const words = VERDICT_WORDS[assessment.verdict];
  const shown = `${assessment.payee.chain}:${assessment.payee.address}`;
  return (
    <div data-check-verdict={assessment.verdict}>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={words.tone}>{words.label}</Badge>
        <h3 className="text-lg font-semibold wrap-anywhere">
          {words.label}: <span className="font-mono text-base">{shown}</span> on{" "}
          {assessment.network}
        </h3>
      </div>
      <p className="mt-2 text-sm">{words.line}</p>
      <p className={`mt-1 text-xs ${muted}`}>
        Checked at {utc(assessment.checked_at)}, in {(run.tookMs / 1000).toFixed(1)} s. {R.readOnly}
      </p>

      {/* The reasons beside what was read from 1024px; one column below. */}
      <div className="grid gap-x-12 lg:grid-cols-2">
        <div>
          <h3 className={H3}>{R.reasons}</h3>
          <ol className="divide-y divide-ink/10" data-check-reasons>
            {assessment.reasons.map((r) => (
              <li
                key={`${r.id}-${r.text}`}
                className="py-3"
                data-reason={r.id}
                data-level={r.level}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={LEVEL_TONES[r.level]}>{r.level}</Badge>
                  <code className="text-xs">{r.id}</code>
                </div>
                <p className="mt-1 text-sm wrap-anywhere">{r.text}</p>
                {r.evidence === undefined ? null : (
                  <p className="mt-1 text-xs">
                    <ExternalLink className={link} href={r.evidence}>
                      Evidence
                    </ExternalLink>
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h3 className={H3}>{R.reads}</h3>
          <p className={`mb-1 text-sm ${muted}`}>{R.readsLede}</p>
          <Reads rows={readRows(input, signals, assessment, log)} />
        </div>
      </div>
      <Requests log={log} />

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium">{R.json}</summary>
        <pre className={`${CODE_BLOCK} max-h-96 overflow-auto`}>
          {JSON.stringify({ ...assessment, signals }, null, 2)}
        </pre>
      </details>

      <h3 className={H3}>{R.cli}</h3>
      <code className={CODE_BLOCK}>{cliCommand(input)}</code>
      <p className={`text-xs ${muted}`}>{R.cliNote}</p>
      <p className="mt-4 text-sm">{R.advice}</p>
      {shareHref === undefined ? null : (
        <p className="mt-2 text-sm">
          <a className={link} href={shareHref}>
            {R.link}
          </a>
        </p>
      )}
    </div>
  );
}

/** A check that threw instead of answering: a bug, never an allow. */
export function CheckFailed({ run }: { run: FailedRun }) {
  return (
    <div data-check-verdict="failed">
      <Notice tone="warn">{R.failed(run.message)}</Notice>
      <Requests log={run.log} />
    </div>
  );
}
