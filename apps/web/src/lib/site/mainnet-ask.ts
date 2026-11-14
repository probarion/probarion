// The #mainnet section's question to the chain: one `check_spend` view of the mainnet vault for mandate 1, signed as
// nothing and paying nothing, at an amount the visitor picks. Pure, with no facts.ts import, so the client component,
// the server render and the tests share it. The words are in facts.ts (MAINNET_ASK, and LIVE_CHECK's verdict words).
import {
  checkSpendArgs,
  fill,
  LiveCheckError,
  parseUsdc,
  parseVerdict,
  type Verdict,
  viewCall,
} from "./live-check";

/** The mainnet vault (contracts/deployments/mainnet.json `vault_v0.account_id`). */
export const ASK_VAULT = "v0.probarion.near";
/**
 * One public mainnet RPC, the FastNEAR host the #mainnet stones read too. A click sends one request to it and nothing
 * else: no second host, no retry. It answers a browser from any origin (CORS checked 2026-11-13).
 */
export const ASK_RPC = "https://rpc.mainnet.fastnear.com";
export const ASK_MANDATE = 1;
/**
 * Mandate 1's payee and agent key, which never change on chain: the test holds them to the mandate in the committed
 * snapshot docs/evidence/mainnet-v0/s2-2026-11-13/snapshot-2026-11-13.json. The view asks with that key as the signer.
 */
export const ASK_PAYEE = "probarion-duong.near";
export const ASK_AGENT_PK = "ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd";
/** The amounts offered: mandate 1's limit per payment, then one above it. */
export const ASK_AMOUNTS = ["1", "2"] as const;
export type AskAmount = (typeof ASK_AMOUNTS)[number];

export interface AskAnswer {
  amount: AskAmount;
  verdict: Verdict;
  raw: unknown;
  blockHeight: number;
  /** ISO time the answer came back. */
  at: string;
}

/**
 * Asks the vault once. Any failure throws: no host answer, an HTTP error, an RPC or contract error, or an answer that
 * is not `check_spend`'s Verdict. The caller shows each one as "could not read the chain", never as a verdict.
 */
export async function askMainnet(
  amount: AskAmount,
  opts: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AskAnswer> {
  const units = parseUsdc(amount);
  if (units === null) throw new LiveCheckError("rpc", "not an amount");
  const a = await viewCall(
    [ASK_RPC],
    ASK_VAULT,
    "check_spend",
    checkSpendArgs(ASK_MANDATE, units, ASK_AGENT_PK),
    { timeoutMs: 8000, ...opts },
  );
  return {
    amount,
    verdict: parseVerdict(a.value),
    raw: a.value,
    blockHeight: a.blockHeight,
    at: new Date().toISOString(),
  };
}

export type AskShown =
  | { kind: "rest" }
  | { kind: "asking"; amount: AskAmount }
  | { kind: "answer"; answer: AskAnswer }
  | { kind: "failed"; amount: AskAmount };

/** The words the view reads, as facts.ts has them (type-only, so the client bundle stays free of facts.ts). */
export interface AskCopy {
  rest: string;
  asking: string;
  failed: string;
  allow: string;
  answeredAt: string;
  verdictPay: string;
  verdictHold: string;
  verdictBlock: string;
  held: string;
  unknownCode: string;
}

export type AskTone = "pay" | "hold" | "refuse" | "none";

/** The headline: a verdict only for an answer the page read; resting, asking and failing name no verdict. */
export function askHeadline(shown: AskShown, copy: AskCopy): { text: string; tone: AskTone } {
  if (shown.kind === "rest") return { text: copy.rest, tone: "none" };
  if (shown.kind === "asking")
    return { text: fill(copy.asking, { vault: ASK_VAULT }), tone: "none" };
  if (shown.kind === "failed") return { text: copy.failed, tone: "none" };
  const v = shown.answer.verdict;
  if (!v.ok) return { text: fill(copy.verdictBlock, { code: v.code ?? "" }), tone: "refuse" };
  if (v.wouldHold) return { text: copy.verdictHold, tone: "hold" };
  return { text: copy.verdictPay, tone: "pay" };
}

/** The sentence under an answer's headline, empty in every other state. */
export function askSentence(
  shown: AskShown,
  copy: AskCopy,
  codes: Readonly<Record<string, string>>,
): string {
  if (shown.kind !== "answer") return "";
  const { verdict, amount } = shown.answer;
  if (verdict.ok) {
    return verdict.wouldHold ? copy.held : fill(copy.allow, { amount, payee: ASK_PAYEE });
  }
  const code = verdict.code ?? "";
  return Object.hasOwn(codes, code)
    ? (codes[code] ?? fill(copy.unknownCode, { code }))
    : fill(copy.unknownCode, { code });
}

/** Where an answer came from, cut at its `{raw}` slot so the page can set the raw answer as code. */
export function askSource(
  shown: AskShown,
  copy: Pick<AskCopy, "answeredAt">,
): { lead: string; raw: string | null; tail: string } {
  if (shown.kind !== "answer") return { lead: "", raw: null, tail: "" };
  const a = shown.answer;
  const vars = { vault: ASK_VAULT, block: a.blockHeight, time: a.at.slice(11, 19) };
  const slot = copy.answeredAt.indexOf("{raw}");
  if (slot < 0) return { lead: fill(copy.answeredAt, vars), raw: null, tail: "" };
  return {
    lead: fill(copy.answeredAt.slice(0, slot), vars),
    raw: String(JSON.stringify(a.raw)),
    tail: fill(copy.answeredAt.slice(slot + "{raw}".length), vars),
  };
}
