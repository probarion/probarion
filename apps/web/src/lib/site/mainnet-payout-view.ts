// What the #mainnet section's live parts say, as plain functions the client component calls and the tests run without
// a browser: each check's state word and rows, and the verdict over them. The words come in as an argument, the copy
// the server component passes down (MAINNET_PAYOUT in facts.ts): this file takes nothing but types from facts.ts, so the
// client's first load does not reach the facts file. lib/site/mainnet-payout-section.ts builds the rest of the
// section, with its links, on the server. Every count and amount comes from the data, never from the words.
import type { MAINNET_PAYOUT, PayoutRowCopy } from "./facts";
import {
  CHECKS,
  type CheckOutcome,
  fill,
  type HostFailure,
  type Payout,
  type PayoutCheckId,
  type Problem,
  READS,
  type ReadName,
  type Tally,
  type TrailEntry,
  usdc,
  utcDate,
} from "./mainnet-payout";

/** The section's copy as facts.ts has it. */
export type PayoutCopy = typeof MAINNET_PAYOUT;

/** The parts of the copy a live run needs: what the server component hands the client component. */
export type PayoutLiveCopy = Pick<
  PayoutCopy,
  "run" | "rowState" | "checks" | "problems" | "reads" | "and" | "comma"
>;

/** The live run's copy, cut from the whole: a smaller prop for the client component. */
export const liveCopy = (c: PayoutCopy): PayoutLiveCopy => ({
  run: c.run,
  rowState: c.rowState,
  checks: c.checks,
  problems: c.problems,
  reads: c.reads,
  and: c.and,
  comma: c.comma,
});

/** The tone a word or a figure is set in. A burn on NEAR is neutral, an arrival on Base is ok, a refusal is bad. */
export type Tone = "neutral" | "ok" | "bad";

/** The reads of one payout, counted from READS: 4 transactions and 3 views. */
export const READ_COUNTS = {
  txs: READS.filter((r) => r.kind === "tx").length,
  views: READS.filter((r) => r.kind === "view").length,
} as const;

/** The check ids in route order, with their numbers 01 to 07. */
export const CHECK_ORDER: readonly { id: PayoutCheckId; n: string }[] = CHECKS.map((c, i) => ({
  id: c.id,
  n: String(i + 1).padStart(2, "0"),
}));

/** "a", "a and b", "a, b and c". */
export function listText(c: Pick<PayoutCopy, "and" | "comma">, items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(c.comma)}${c.and}${items[items.length - 1]}`;
}

/** A small count in words ("two"); a larger one in digits. */
export const numberWord = (c: Pick<PayoutCopy, "numbers">, n: number): string =>
  c.numbers[n] ?? String(n);

// --- the ledger, read for the words -----------------------------------------------------------------

/** The entry that allowed the payment: the last allow before its payment entry. */
export function allowingEntry(p: Payout): TrailEntry | undefined {
  return p.trail.filter((e) => e.kind === "decision" && e.verdict === "allow").at(-1);
}

/** The attested proposals code refused before the payment was allowed: the trail's spur. */
export function refusedProposals(p: Payout): TrailEntry[] {
  const allow = allowingEntry(p);
  return p.trail.filter(
    (e) =>
      e.kind === "decision" &&
      e.verdict === "refuse" &&
      e.attested &&
      (allow === undefined || e.seq < allow.seq),
  );
}

/** Who decided the payment: the allowing entry's `decided_by`. */
export const decidedBy = (p: Payout): "model+rules" | "rules-only" =>
  allowingEntry(p)?.decidedBy ?? "rules-only";

// --- the checks -----------------------------------------------------------------------------------

export interface CheckRow {
  label: string;
  text: string;
  /** A value that stays whole, such as an address or a memo. */
  full: boolean;
  /** A quiet line under the rows, with no label. */
  note: boolean;
}

/** A check's title; the burn and the arrival name the payout's amounts. */
export function checkTitle(c: Pick<PayoutCopy, "checks">, id: PayoutCheckId, p: Payout): string {
  return fill(c.checks[id].title, { amount: usdc(p.amount), received: usdc(p.received) });
}

/** A passing check's rows, with the values it read. */
export function checkRows(
  c: Pick<PayoutCopy, "checks">,
  id: PayoutCheckId,
  values: Readonly<Record<string, string>>,
): CheckRow[] {
  return (c.checks[id].rows as readonly PayoutRowCopy[]).map((r) => ({
    label: r.label,
    text: fill(r.text, values),
    full: r.full === true,
    note: r.note === true,
  }));
}

/** Why a check does not pass, with the value it read. */
export function problemText(c: Pick<PayoutCopy, "problems">, problem: Problem): string {
  return fill(c.problems[problem.code], problem.vars);
}

function failureText(c: Pick<PayoutCopy, "reads">, f: HostFailure): string {
  const vars = { host: f.host, detail: f.detail };
  if (f.kind === "rpc" && f.detail === "") return fill(c.reads.rpcBare, vars);
  return fill(c.reads[f.kind], vars);
}

/** Why the reads a check needs did not come back: each read, and each host's answer. */
export function unreadText(
  c: Pick<PayoutCopy, "reads">,
  missing: readonly { read: ReadName; failures: HostFailure[] }[],
  shape = false,
): string {
  if (shape) return c.reads.shape;
  return missing
    .map((m) =>
      fill(c.reads.item, {
        read: c.reads.names[m.read],
        why:
          m.failures.length === 0
            ? c.reads.nobody
            : m.failures.map((f) => failureText(c, f)).join("; "),
      }),
    )
    .join("; ");
}

export interface RowState {
  word: string;
  /** Beside the word, or after a problem: where the values on show come from. */
  note: string | null;
  tone: Tone;
}

/** Where the values a row shows come from: the recorded run, or this browser's last read that passed. */
export type ValuesFrom = "recorded" | "earlier";

/**
 * The state word beside a check: recorded at rest (the verdict above gives the date), reading, then what a live run
 * found. A row that fails or cannot be read keeps the values it showed, and its note says where they come from.
 */
export function rowState(
  c: Pick<PayoutCopy, "rowState" | "problems" | "reads">,
  o: CheckOutcome | "recorded" | "reading",
  from: ValuesFrom = "recorded",
): RowState {
  const S = c.rowState;
  if (o === "recorded") return { word: S.recorded, note: null, tone: "neutral" };
  if (o === "reading") return { word: S.reading, note: null, tone: "neutral" };
  if (o.state === "pass") return { word: S.pass, note: S.passNote, tone: "ok" };
  const shown = S.shown[from];
  if (o.state === "fail") {
    return { word: fill(S.fail, { why: problemText(c, o.problem) }), note: shown, tone: "bad" };
  }
  return {
    word: fill(S.unread, { why: unreadText(c, o.missing, o.shape === true) }),
    note: shown,
    tone: "neutral",
  };
}

// --- the verdict ----------------------------------------------------------------------------------

export interface VerdictView {
  title: string;
  sub: string;
  tone: Tone;
}

/** At rest, from the recorded run. */
export function restVerdict(c: Pick<PayoutCopy, "run">, t: Tally, recordedAt: string): VerdictView {
  return {
    title: fill(c.run.atRest, { date: utcDate(recordedAt), pass: t.pass, total: t.total }),
    sub: fill(c.run.atRestSub, READ_COUNTS),
    tone: t.state === "pass" ? "ok" : "bad",
  };
}

/** While the reads run. */
export function readingVerdict(c: Pick<PayoutCopy, "run">): VerdictView {
  return { title: fill(c.run.reading, READ_COUNTS), sub: c.run.readingSub, tone: "neutral" };
}

/** After a live run: `at` is when it started, `ms` how long it took, `hosts` the hosts that answered. */
export function liveVerdict(
  c: Pick<PayoutCopy, "run" | "and" | "comma">,
  t: Tally,
  at: number,
  ms: number,
  hosts: readonly string[],
): VerdictView {
  const vars = { pass: t.pass, total: t.total, unread: t.unread };
  if (t.state === "fail") return { title: fill(c.run.fail, vars), sub: c.run.failSub, tone: "bad" };
  if (t.state === "unread") {
    return { title: fill(c.run.unread, vars), sub: c.run.unreadSub, tone: "neutral" };
  }
  return {
    title: fill(c.run.pass, vars),
    sub: fill(c.run.passSub, {
      time: new Date(at).toISOString().slice(11, 19),
      seconds: (ms / 1000).toFixed(1),
      hosts: listText(c, hosts),
    }),
    tone: "ok",
  };
}
