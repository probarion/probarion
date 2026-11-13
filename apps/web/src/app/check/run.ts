// One payee check as /check runs it: the SDK's reads through a fetch that writes each request down, then core's
// verdict. It never throws: a read that fails is "unknown" (the SDK's rule) and warns, and anything the reads throw
// anyway (a bug) comes back as a failed run, which the page shows as "could not run", never as an allow.
import { assessPayee, type PayeeAssessment, type PayeeSignals } from "@probarion/core";
import { type ReadPayeeSignalsOptions, readPayeeSignals } from "@probarion/sdk/payee";
import { type CheckInput, type RequestEntry, recordingFetch } from "./check-view";

export interface DoneRun {
  kind: "done";
  input: CheckInput;
  signals: PayeeSignals;
  assessment: PayeeAssessment;
  log: readonly RequestEntry[];
  tookMs: number;
}

export interface FailedRun {
  kind: "failed";
  input: CheckInput;
  message: string;
  log: readonly RequestEntry[];
}

export interface RunDeps {
  fetch: typeof fetch;
  /** Milliseconds, from any fixed start (performance.now in the browser). */
  now: () => number;
}

/** The SDK's own limits unless a test sets shorter ones. Nodes and the Base RPC are the SDK's defaults. */
export type RunLimits = Pick<ReadPayeeSignalsOptions, "timeoutMs" | "budgetMs">;

export async function runCheck(
  input: CheckInput,
  deps: RunDeps,
  limits: RunLimits = {},
): Promise<DoneRun | FailedRun> {
  const log: RequestEntry[] = [];
  const t0 = deps.now();
  try {
    const signals = await readPayeeSignals(input, {
      ...limits,
      fetch: recordingFetch(
        deps.fetch,
        (entry) => log.push(entry),
        () => deps.now() - t0,
      ),
    });
    const assessment = assessPayee(signals);
    return { kind: "done", input, signals, assessment, log, tookMs: deps.now() - t0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", input, message, log };
  }
}
