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
  | "wouldPay"
  | "wouldPayUnknownPayee"
  | "held"
  | "hijackTail"
  | "unknownCode"
  | "injectedPaid"
  | "injectedPaidUnknownPayee"
>;

/** The words that name a verdict: allow, warn, block, and the hijack's allow. */
export type VerdictCopy = Pick<
  LiveCopy,
  "verdictPay" | "verdictHold" | "verdictBlock" | "verdictInjected"
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
    // A hijacked prompt the contract allows still pays only the mandate's payee: the sentence says who gets nothing.
    if (injected) {
      return a.mandate == null
        ? fill(copy.injectedPaidUnknownPayee, { amount })
        : fill(copy.injectedPaid, { amount, payee: payeeText(a.mandate.payee) });
    }
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

/**
 * The verdict in a few words: allow, warn (an approver decides) or block with the contract's code. An allow for a
 * hijacked prompt (`injected`) says the attacker gets nothing, so it never reads as the attack going through.
 */
export function verdictWord(a: Answer, copy: VerdictCopy, injected = false): string {
  if (!a.verdict.ok) return fill(copy.verdictBlock, { code: a.verdict.code ?? "" });
  if (a.verdict.wouldHold) return copy.verdictHold;
  return injected ? copy.verdictInjected : copy.verdictPay;
}

/** Whether an answer is to a scenario whose invoice text carries a hijack. */
export function isInjected(a: Answer, injectedIds: ReadonlySet<string>): boolean {
  return a.request.scenario !== null && injectedIds.has(a.request.scenario);
}

export type Tone = "pay" | "hold" | "refuse" | "none";

/**
 * The answer panel's headline for a state. A text that is not an amount has its own title. While a request is out,
 * the headline says so: the previous verdict would read as the answer to the new request.
 */
export function verdictText(
  shown: Shown,
  copy: VerdictCopy & Pick<LiveCopy, "noAnswer" | "notAmountTitle" | "waiting">,
  injectedIds: ReadonlySet<string> = new Set(),
): string {
  if (shown.kind === "failed" && shown.reason === "badAmount") return copy.notAmountTitle;
  if (shown.kind === "loading") return copy.waiting;
  const a = lastAnswer(shown);
  if (a === null) return copy.noAnswer;
  return verdictWord(a, copy, isInjected(a, injectedIds));
}

export function verdictTone(shown: Shown): Tone {
  if (shown.kind === "failed" && shown.reason === "badAmount") return "none";
  if (shown.kind === "loading") return "none";
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
  const said = explain(a, isInjected(a, injectedIds), copy, codes);
  if (shown.kind !== "failed") return said;
  return `${shown.reason === "answer" ? copy.failedAnswer : copy.failed} ${said}`;
}

/**
 * The line under the verdict, in parts: the words before the raw answer, the raw answer itself (null when there is
 * none to show), and any words after it. The panel sets the raw answer as code, so the template is cut at its `{raw}`
 * slot before it is filled: nothing is cut out of a filled sentence.
 */
export interface HintParts {
  lead: string;
  raw: string | null;
  tail: string;
}

const NO_HINT: HintParts = { lead: "", raw: null, tail: "" };

export function hintParts(
  shown: Shown,
  copy: Pick<LiveCopy, "asking" | "answeredAt" | "recordedAt">,
  vault: string,
  timeOf: (iso: string) => string,
): HintParts {
  if (shown.kind === "loading") return { ...NO_HINT, lead: fill(copy.asking, { vault }) };
  if (shown.kind === "failed" && shown.reason === "badAmount") return NO_HINT;
  const a = lastAnswer(shown);
  if (a === null) return NO_HINT;
  const template = a.recorded ? copy.recordedAt : copy.answeredAt;
  const vars = { vault, block: a.blockHeight, date: a.at.slice(0, 10), time: timeOf(a.at) };
  const slot = template.indexOf("{raw}");
  if (slot < 0) return { ...NO_HINT, lead: fill(template, vars) };
  return {
    lead: fill(template.slice(0, slot), vars),
    raw: String(JSON.stringify(a.raw)),
    tail: fill(template.slice(slot + "{raw}".length), vars),
  };
}

/**
 * The line under the verdict as one string: where the answer came from. Empty when there is no answer to describe.
 * Test-only: the client renders hintParts, and live-check-view.test.ts reads the line through this to hold its words.
 */
export function hintText(
  shown: Shown,
  copy: Pick<LiveCopy, "asking" | "answeredAt" | "recordedAt">,
  vault: string,
  timeOf: (iso: string) => string,
): string {
  const p = hintParts(shown, copy, vault, timeOf);
  return `${p.lead}${p.raw ?? ""}${p.tail}`;
}

/**
 * A raw JSON answer cut after each comma between its members, so the panel can offer a line break there and nowhere
 * else. A comma inside a string stays where it is. The pieces join back to the input.
 */
export function rawPieces(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === ",") {
      out.push(raw.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < raw.length) out.push(raw.slice(start));
  return out;
}

/** An ISO time as the page shows it, in UTC, to the second: the copy says UTC after it. */
export function utcTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
}

/** A line of copy that names a thing, then gives it ("Method: ...", "RPC: ..."), cut at its first ": ". */
export function labelled(line: string): { label: string; value: string } {
  const at = line.indexOf(": ");
  return at < 0
    ? { label: "", value: line }
    : { label: line.slice(0, at), value: line.slice(at + 2) };
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
