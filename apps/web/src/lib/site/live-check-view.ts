// What the live check shows, as plain functions the client component calls and the tests run without a browser.
import type { LIVE_CHECK } from "./facts";
import {
  fill,
  formatUsdc,
  type KeyChoice,
  LiveCheckError,
  type MandateFacts,
  OTHER_PK,
  type Payee,
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

/**
 * failed / transport: no host answered. failed / answer: a host answered, but with an error or something unreadable.
 * loading / previous null: asking again after a failure that had no recorded answer to show.
 */
export type Shown =
  | { kind: "answer"; answer: Answer }
  | { kind: "loading"; previous: Answer | null }
  | { kind: "failed"; fallback: Answer | null; reason: "transport" | "answer" | "badAmount" };

/** Why a request failed, from the error it threw: only a `LiveCheckError` of kind rpc or contract is an answer. */
export function failureKind(e: unknown): "transport" | "answer" {
  return e instanceof LiveCheckError && e.kind !== "transport" ? "answer" : "transport";
}

/** The live check's copy as `facts.ts` has it. Type-only: the client's first load must not reach the facts file. */
export type LiveCopy = typeof LIVE_CHECK.copy;

export type LiveCopyShape = Pick<
  LiveCopy,
  "wouldPay" | "wouldPayUnknownPayee" | "held" | "hijackTail" | "unknownCode"
>;

/** The payee the panel shows for the chosen mandate. A payee never changes on chain, so the recorded one is right. */
export function payeeShown(
  recorded: RecordedFile,
  mandateId: number,
  answer: Answer | null,
): Payee | null | undefined {
  const key = String(mandateId);
  if (Object.hasOwn(recorded.mandates, key)) {
    // null: the record knows there is no such mandate.
    return parseMandate(recorded.mandates[key] ?? null)?.payee ?? null;
  }
  // Not recorded: the answer's own mandate counts only when the answer is for this very id.
  if (answer === null || answer.request.mandateId !== mandateId) return undefined;
  return answer.mandate == null ? answer.mandate : answer.mandate.payee;
}

/** The key the "agent key" choice signs with: the chosen mandate's own, else mandate 1's, else a key no mandate has. */
export function agentKeyFor(recorded: RecordedFile, mandateId: number): string {
  const of = (id: number) => parseMandate(recorded.mandates[String(id)] ?? null)?.agentPk;
  return of(mandateId) ?? of(1) ?? OTHER_PK;
}

/** The amount line of the request preview. A text that is not an amount is quoted as it was typed. */
export function amountLine(
  amount: string,
  copy: Pick<LiveCopy, "unit" | "previewNotAmount">,
): string {
  const units = parseUsdc(amount);
  return units === null
    ? `amount: ${JSON.stringify(amount)},  // ${copy.previewNotAmount}`
    : `amount: "${units}",  // ${formatUsdc(units)} ${copy.unit}`;
}

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
  const said = Object.hasOwn(codes, code)
    ? (codes[code] ?? fill(copy.unknownCode, { code }))
    : fill(copy.unknownCode, { code });
  // "Still goes to the payee at the limit" is true only of a refusal for being over the limit.
  if (!injected || code !== "OverPerPayment" || a.mandate == null) return said;
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
  copy: Pick<LiveCopy, "verdictPay" | "verdictHold" | "noAnswer" | "notAmountTitle" | "waiting">,
): string {
  if (shown.kind === "failed" && shown.reason === "badAmount") return copy.notAmountTitle;
  const a = lastAnswer(shown);
  if (a === null) return shown.kind === "loading" ? copy.waiting : copy.noAnswer;
  return verdictWord(a, copy);
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
  copy: LiveCopyShape &
    Pick<
      LiveCopy,
      "failed" | "failedNoRecord" | "failedAnswer" | "failedAnswerNoRecord" | "badAmount"
    >,
  codes: Readonly<Record<string, string>>,
  injectedIds: ReadonlySet<string>,
): string {
  if (shown.kind === "failed" && shown.reason === "badAmount") return copy.badAmount;
  const a = lastAnswer(shown);
  if (a === null) {
    if (shown.kind === "loading") return "";
    return shown.kind === "failed" && shown.reason === "answer"
      ? copy.failedAnswerNoRecord
      : copy.failedNoRecord;
  }
  const said = explain(
    a,
    a.request.scenario !== null && injectedIds.has(a.request.scenario),
    copy,
    codes,
  );
  if (shown.kind !== "failed") return said;
  return `${shown.reason === "answer" ? copy.failedAnswer : copy.failed} ${said}`;
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
