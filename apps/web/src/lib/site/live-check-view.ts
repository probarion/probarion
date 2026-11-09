// What the live check shows, as plain functions the client component calls and the tests run without a browser.
import type { LIVE_CHECK } from "./facts";
import {
  fill,
  formatUsdc,
  type MandateFacts,
  parseMandate,
  parseVerdict,
  payeeText,
  type RecordedFile,
  SCENARIO_INPUTS,
  type ScenarioId,
  type Verdict,
} from "./live-check";

export interface Answer {
  verdict: Verdict;
  raw: unknown;
  mandate: MandateFacts | null;
  blockHeight: number;
  /** ISO time of the answer: the recording time when `recorded`. */
  at: string;
  rpcHost: string | null;
  recorded: boolean;
}

export type Shown =
  | { kind: "answer"; answer: Answer }
  | { kind: "loading"; previous: Answer }
  | { kind: "failed"; fallback: Answer | null; reason: "transport" | "badAmount" };

/** The live check's copy as `facts.ts` has it. Type-only: the client's first load must not reach the facts file. */
export type LiveCopy = typeof LIVE_CHECK.copy;

export interface LiveCopyShape {
  wouldPay: string;
  held: string;
  hijackTail: string;
  unknownCode: string;
}

export function answerFromRecorded(recorded: RecordedFile, id: ScenarioId): Answer {
  const input = SCENARIO_INPUTS.find((s) => s.id === id);
  if (input === undefined) throw new Error(`no scenario ${id}`);
  const { value, blockHeight } = recorded.answers[id];
  return {
    verdict: parseVerdict(value),
    raw: value,
    mandate: parseMandate(recorded.mandates[String(input.mandateId)] ?? null),
    blockHeight,
    at: recorded.recordedAt,
    rpcHost: null,
    recorded: true,
  };
}

/** One plain sentence for the verdict. `amount` is in base units. */
export function explain(
  a: Answer,
  amount: bigint,
  injected: boolean,
  copy: LiveCopyShape,
  codes: Readonly<Record<string, string>>,
): string {
  const payee = a.mandate === null ? "" : payeeText(a.mandate.payee);
  if (a.verdict.ok) {
    return a.verdict.wouldHold
      ? copy.held
      : fill(copy.wouldPay, { amount: formatUsdc(amount), payee });
  }
  const code = a.verdict.code ?? "";
  const said = codes[code] ?? fill(copy.unknownCode, { code });
  if (!injected || a.mandate === null) return said;
  return `${said} ${fill(copy.hijackTail, { max: formatUsdc(a.mandate.maxPerPayment), payee })}`;
}

/** What to show after an answer arrives: only the answer to the latest request counts. */
export function nextAnswer(
  current: Shown,
  latestSeq: number,
  incoming: { seq: number; shown: Shown },
): Shown {
  return incoming.seq === latestSeq ? incoming.shown : current;
}

export function lastAnswer(shown: Shown): Answer | null {
  if (shown.kind === "answer") return shown.answer;
  if (shown.kind === "loading") return shown.previous;
  return shown.fallback;
}
