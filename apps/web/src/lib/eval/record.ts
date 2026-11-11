import { redactSecrets } from "@probarion/sdk";
import { CASES, type EvalCase } from "./cases";
import { type Proposer, recordAnswer, recordedPath, recordFailure } from "./recorded";
import { prepareCase } from "./run";

// The loop of scripts/eval-record.ts (OWNER only), apart from the key and the file system, so that a test can run
// it with the SDK's NEAR AI test double and a key that is not real (test/eval/record.test.ts). Everything it prints
// goes through redactSecrets with the key, and it writes no file that contains the key.

/** The --only argument: null for every case, or the named ones; an error for an unknown id or no id at all. */
export type OnlyArg = { ok: true; only: ReadonlySet<string> | null } | { ok: false; error: string };

export function parseOnly(argv: readonly string[], cases: readonly EvalCase[] = CASES): OnlyArg {
  const at = argv.indexOf("--only");
  if (at === -1) return { ok: true, only: null };
  const ids = (argv[at + 1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (ids.length === 0) return { ok: false, error: "--only needs case ids, comma-separated" };
  const unknown = ids.filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length > 0) return { ok: false, error: `no such case: ${unknown.join(", ")}` };
  return { ok: true, only: new Set(ids) };
}

export interface RecordRun {
  root: string;
  proposer: Proposer;
  /** Only used to redact what is printed and to refuse a file that would contain it. */
  apiKey: string;
  only: ReadonlySet<string> | null;
  clock: { now: () => Date; ms: () => number };
  /** Writes a file, by its path from the repository root. */
  write: (path: string, body: string) => void;
  say: (line: string) => void;
  cases?: readonly EvalCase[];
}

/**
 * `written`: answers written after A1-A8 passed. `callFailed`: model calls that failed, written as a
 * RecordedFailure. `failed`: cases with no file written (a check failed, or the file would contain the key).
 */
export interface RecordTally {
  written: number;
  callFailed: number;
  failed: number;
}

/** Records every case that reaches the model step (or the ones `only` names). */
export async function recordCases(run: RecordRun): Promise<RecordTally> {
  const cases = run.cases ?? CASES;
  const say = (text: string) => run.say(redactSecrets(text, [run.apiKey]));
  /** Writes the JSON of `value`, or says why not: the key must never reach a file. */
  const save = (path: string, value: unknown): string | null => {
    const json = `${JSON.stringify(value, null, 2)}\n`;
    if (json.includes(run.apiKey)) return "the API key appears in it; refusing to write it";
    run.write(path, json);
    return null;
  };
  const tally: RecordTally = { written: 0, callFailed: 0, failed: 0 };
  for (const c of cases) {
    if (run.only !== null && !run.only.has(c.id)) continue;
    const p = await prepareCase(run.root, c, cases);
    if (p.stage !== "cycle" || p.candidate === null) {
      say(`${c.id}: skipped, the pipeline stops before the model step (${p.stage})`);
      continue;
    }
    let recorded: Awaited<ReturnType<typeof recordAnswer>>;
    try {
      recorded = await recordAnswer(p, run.proposer, run.clock);
    } catch (error) {
      // Probarion.modelStep decides such a cycle rules-only (model.unavailable); the eval records that it failed.
      const failure = recordFailure(p, error, run.proposer.resolvedModel ?? null, run.clock.now(), [
        run.apiKey,
      ]);
      const refused = save(recordedPath(c.id), failure);
      if (refused !== null) {
        tally.failed += 1;
        say(`${c.id}: the model call failed, and its failure was NOT written: ${refused}`);
        continue;
      }
      tally.callFailed += 1;
      say(
        `${c.id}: the model call failed (${failure.failure.error}: ${failure.failure.message}); wrote ${recordedPath(c.id)} as a failed call, which the replay decides rules-only. If it was a network error, record it again with --only ${c.id}.`,
      );
      continue;
    }
    const { answer, ok } = recorded;
    if (!ok) {
      const failedChecks = [
        ...answer.offline_check.checks.filter((x) => !x.pass).map((x) => `${x.id}: ${x.detail}`),
        ...(answer.request_binding_check.pass
          ? []
          : [`A8: ${answer.request_binding_check.detail}`]),
      ];
      tally.failed += 1;
      say(`${c.id}: NOT written, a check failed: ${failedChecks.join("; ")}`);
      continue;
    }
    const refused = save(recordedPath(c.id), answer);
    if (refused !== null) {
      tally.failed += 1;
      say(`${c.id}: NOT written: ${refused}`);
      continue;
    }
    tally.written += 1;
    say(
      `${c.id}: ${answer.model} proposed ${answer.proposal.action} (amount ${answer.proposal.amount ?? "null"}), A1-A8 PASS, ${answer.latency_ms} ms, wrote ${recordedPath(c.id)}`,
    );
  }
  return tally;
}
