// What the live check shows, as plain functions the client component calls and the tests run without a browser.
import type { LIVE_CHECK } from "./facts";
import {
  fill,
  formatUsdc,
  type KeyChoice,
  type MandateFacts,
  parseMandate,
  parseUsdc,
  parseVerdict,
  payeeText,
  type RecordedFile,
  SCENARIO_INPUTS,
  type ScenarioId,
  type Verdict,
} from "./live-check";

/** The request an answer is to: the answer is always described with this, never with the controls as they are now. */
export interface AnswerRequest {
  mandateId: number;
  /** Base units. */
  units: bigint;
  key: KeyChoice;
  /** The scenario these fields are, or null. */
  scenario: ScenarioId | null;
}

export interface Answer {
  request: AnswerRequest;
  verdict: Verdict;
  raw: unknown;
  /** null: the chain has no such mandate. undefined: the mandate could not be read, the verdict was. */
  mandate: MandateFacts | null | undefined;
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

export type LiveCopyShape = Pick<
  LiveCopy,
  "wouldPay" | "wouldPayUnknownPayee" | "held" | "hijackTail" | "unknownCode"
>;

export function answerFromRecorded(recorded: RecordedFile, id: ScenarioId): Answer {
  const input = SCENARIO_INPUTS.find((s) => s.id === id);
  if (input === undefined) throw new Error(`no scenario ${id}`);
  const { value, blockHeight } = recorded.answers[id];
  return {
    request: {
      mandateId: input.mandateId,
      units: parseUsdc(input.amount) ?? 0n,
      key: input.key,
      scenario: id,
    },
    verdict: parseVerdict(value),
    raw: value,
    mandate: parseMandate(recorded.mandates[String(input.mandateId)] ?? null),
    blockHeight,
    at: recorded.recordedAt,
    rpcHost: null,
    recorded: true,
  };
}

/** One plain sentence for the verdict, with the amount of the request the answer is to. */
export function explain(
  a: Answer,
  injected: boolean,
  copy: LiveCopyShape,
  codes: Readonly<Record<string, string>>,
): string {
  const amount = formatUsdc(a.request.units);
  if (a.verdict.ok) {
    if (a.verdict.wouldHold) return copy.held;
    return a.mandate == null
      ? fill(copy.wouldPayUnknownPayee, { amount })
      : fill(copy.wouldPay, { amount, payee: payeeText(a.mandate.payee) });
  }
  const code = a.verdict.code ?? "";
  const said = codes[code] ?? fill(copy.unknownCode, { code });
  if (!injected || a.mandate == null) return said;
  const max = formatUsdc(a.mandate.maxPerPayment);
  return `${said} ${fill(copy.hijackTail, { max, payee: payeeText(a.mandate.payee) })}`;
}

/** The verdict as one word: what the contract said, or the pay and held words. */
export function verdictWord(a: Answer, copy: Pick<LiveCopy, "verdictPay" | "verdictHold">): string {
  if (!a.verdict.ok) return a.verdict.code ?? "";
  return a.verdict.wouldHold ? copy.verdictHold : copy.verdictPay;
}

export type Tone = "pay" | "hold" | "refuse" | "none";

/** The answer panel's headline for a state. A text that is not an amount has its own title. */
export function verdictText(
  shown: Shown,
  copy: Pick<LiveCopy, "verdictPay" | "verdictHold" | "noAnswer" | "notAmountTitle">,
): string {
  if (shown.kind === "failed" && shown.reason === "badAmount") return copy.notAmountTitle;
  const a = lastAnswer(shown);
  return a === null ? copy.noAnswer : verdictWord(a, copy);
}

export function verdictTone(shown: Shown): Tone {
  if (shown.kind === "failed" && shown.reason === "badAmount") return "none";
  const a = lastAnswer(shown);
  if (a === null) return "none";
  if (!a.verdict.ok) return "refuse";
  return a.verdict.wouldHold ? "hold" : "pay";
}

/** The sentence under the headline. `injectedIds`: the scenarios whose invoice text carries a hijack. */
export function sentenceText(
  shown: Shown,
  copy: LiveCopyShape & Pick<LiveCopy, "failed" | "failedNoRecord" | "badAmount">,
  codes: Readonly<Record<string, string>>,
  injectedIds: ReadonlySet<string>,
): string {
  if (shown.kind === "failed" && shown.reason === "badAmount") return copy.badAmount;
  const a = lastAnswer(shown);
  if (a === null) return copy.failedNoRecord;
  const said = explain(
    a,
    a.request.scenario !== null && injectedIds.has(a.request.scenario),
    copy,
    codes,
  );
  return shown.kind === "failed" ? `${copy.failed} ${said}` : said;
}

/** The line above the headline: where the answer came from. Empty when there is no answer to describe. */
export function hintText(
  shown: Shown,
  copy: Pick<LiveCopy, "asking" | "answeredAt" | "recordedAt">,
  vault: string,
  timeOf: (iso: string) => string,
): string {
  if (shown.kind === "loading") return fill(copy.asking, { vault });
  if (shown.kind === "failed" && shown.reason === "badAmount") return "";
  const a = lastAnswer(shown);
  if (a === null) return "";
  return fill(a.recorded ? copy.recordedAt : copy.answeredAt, {
    vault,
    block: a.blockHeight,
    date: a.at.slice(0, 10),
    time: timeOf(a.at),
    raw: JSON.stringify(a.raw),
  });
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
