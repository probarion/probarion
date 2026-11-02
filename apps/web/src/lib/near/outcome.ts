/**
 * What a wallet call turned into, without trusting the wallet (W-T6-R1).
 *
 * A wallet's outcome object is only ever mined for two facts: the transaction hash and the signer.
 * Whether the transaction worked is read from the chain by the server (`confirm.ts`), and this file
 * decides what the chain's answer means:
 *
 * 1. A call that ran is not an action that worked (R12). `create_vault` refunds and returns `null`
 *    when the name is taken; `approve` returns a `SpendResult` whose status may be `failed`;
 *    `withdraw_intents` returns `"0"` when Intents paid nothing out. The return value is read per
 *    method, and the table is exhaustive over `ReadableMethod` (the gas table's methods and `Transfer`), so a
 *    new method cannot ship without one.
 * 2. A call that succeeded is not a transaction that finished. A step it started (a key added, a
 *    payee registered on USDC) can fail under a top-level success: that is `unknown`. And a callback
 *    method (`approve`, `create_vault`, `withdraw_intents`) whose first call ran and whose later step
 *    failed may have half happened: that is `unknown` too.
 * 3. Anything we cannot confirm is `unknown`, never `ok` and never a "failed" that invites another
 *    try: no hash, a cancelled or closed wallet, an outcome we cannot read, a node that cannot be
 *    reached. The button stays locked until the owner has looked at the explorer (the SDK's
 *    `TxOutcomeUnknownError` rule: never send the same action again on a guess).
 */
import { VAULT_ERROR_CODES } from "@probarion/core";
import type { PreparedTx, ReadableMethod } from "./tx";
import { isNearAccountId } from "./validate";

export interface TxResult {
  status: "ok" | "failed" | "unknown";
  txHash: string | null;
  code: string | null; // PROBARION:<Code> from IF §4.3, or a chain refusal such as LackBalanceForState
  error: string | null;
}

const MAX_TEXT = 500;
const KNOWN_CODES: ReadonlySet<string> = new Set(VAULT_ERROR_CODES);

/** The chain has the transaction, and it is not known to be finished or whole. */
export const UNKNOWN_HEADLINE = "Sent: confirm on the explorer";
/** The wallet gave no transaction (cancel, closed window, no hash): it may still have gone out. */
export const NOT_CONFIRMED_HEADLINE =
  "Not confirmed: if you approved in your wallet, check the explorer first";
/** Nothing was sent: no wallet to ask, or the wallet is signed in as someone else. */
export const NOT_SENT_HEADLINE = "Not sent";
/** R12: the factory's `on_vault_created` returned `null` (the batch rolled back and the deposit went back). */
export const REFUSED_CREATE_VAULT = "name taken or deposit too low, refunded";
/** R12: `approve` came back with status `failed` (the vault released the reservation). */
export const REFUSED_APPROVE = "payout failed, reservation released";
/** `ft_withdraw` resolves to "0" when nothing left Intents (contracts/vault/src/spend.rs `on_withdraw`). */
export const REFUSED_WITHDRAW_INTENTS =
  "nothing was withdrawn: Intents paid nothing out, so the balance stays in Intents";

/**
 * Methods whose receipt chain ends in a callback that settles state, so a failure after the first
 * call ran can leave the action half done (contracts/vault/src/{held,spend,admin}.rs,
 * contracts/factory/src/lib.rs):
 * - `approve`: payout, then `on_transfer` / `on_withdraw` (Pending until it runs);
 * - `create_vault`: account batch, then `on_vault_created` (registry and refund);
 * - `withdraw_intents`: `intents.ft_withdraw`, which debits, pays and re-credits inside Intents.
 * `withdraw` is not one: it returns the USDC `ft_transfer` itself, and a failed transfer moves nothing.
 */
export const CALLBACK_METHODS: ReadonlySet<ReadableMethod> = new Set<ReadableMethod>([
  "approve",
  "create_vault",
  "withdraw_intents",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printable(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

/** JSON that never throws: bigint becomes a string, a cycle becomes "[Circular]". */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      }) ?? printable(value)
    );
  } catch {
    return printable(value);
  }
}

function truncate(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

/** The first known `PROBARION:<Code>` in `text`. Unknown codes are left in the text, not promoted. */
function codeIn(text: string): string | null {
  for (const m of text.matchAll(/PROBARION:([A-Za-z]+)/g)) {
    const code = m[1];
    if (code !== undefined && KNOWN_CODES.has(code)) return code;
  }
  return null;
}

/** A NEAR transaction hash: base58 of 32 bytes, so 43 or 44 characters from the Bitcoin alphabet. */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export function isTxHash(value: unknown): value is string {
  return typeof value === "string" && TX_HASH.test(value);
}

function txHashField(value: unknown): string | null {
  return isTxHash(value) ? value : null;
}

/** transaction.hash, else transaction_outcome.id (a FinalExecutionOutcome), else a plain hash field. */
function hashOfRecord(o: Record<string, unknown>): string | null {
  const tx = isRecord(o.transaction) ? o.transaction : null;
  const first = isRecord(o.transaction_outcome) ? o.transaction_outcome : null;
  return (
    txHashField(tx?.hash) ??
    txHashField(first?.id) ??
    txHashField(o.txHash) ??
    txHashField(o.tx_hash) ??
    txHashField(o.transactionHash) ??
    txHashField(o.transaction_hash)
  );
}

function signerOfRecord(o: Record<string, unknown>): string | null {
  const tx = isRecord(o.transaction) ? o.transaction : null;
  for (const candidate of [tx?.signer_id, o.signerId, o.signer_id]) {
    if (typeof candidate === "string" && isNearAccountId(candidate)) return candidate;
  }
  return null;
}

const NESTED_KEYS = [
  "cause",
  "context",
  "result",
  "outcome",
  "response",
  "error",
  "data",
  "details",
];

/** Look a few levels into the places wallets and near-api-js put a hash or a signer on an error. */
function search(
  pick: (o: Record<string, unknown>) => string | null,
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): string | null {
  if (typeof value !== "object" || value === null || depth > 4 || seen.has(value)) return null;
  seen.add(value);
  try {
    const o = value as Record<string, unknown>;
    const own = pick(o);
    if (own !== null) return own;
    for (const key of NESTED_KEYS) {
      const found = search(pick, o[key], depth + 1, seen);
      if (found !== null) return found;
    }
  } catch {
    // a hostile getter is not worth crashing the result for
  }
  return null;
}

// In free text, only trust a hash next to a word that says what it is, or inside an explorer URL: a
// public key in the same message must not match. Case-sensitive on purpose: the base58 alphabet has
// no 0, O, I or l, and an `i` flag would let them in.
const HASH_IN_TEXT =
  /(?:\/txns?\/|\b(?:transaction|Transaction|TRANSACTION|tx|Tx|TX)(?:[ _-]?(?:hash|Hash|HASH|id|Id|ID))?\b[\s:#="']*)([1-9A-HJ-NP-Za-km-z]{43,44})(?![1-9A-HJ-NP-Za-km-z])/;

function hashInText(text: string): string | null {
  return HASH_IN_TEXT.exec(text)?.[1] ?? null;
}

function messageOf(e: unknown): string {
  let text: string;
  if (e instanceof Error) text = e.message;
  else if (typeof e === "string") text = e;
  else if (isRecord(e) && typeof e.message === "string") text = e.message;
  else text = e === undefined || e === null ? "" : safeStringify(e);
  return text.trim() === "" ? "The wallet reported an error with no message." : text;
}

/** Message plus the message of a `cause`, for finding a PROBARION code the wallet wrapped. */
function searchText(e: unknown): string {
  const own = messageOf(e);
  // an Error is an object too, so `cause` is read the same way for both
  if (isRecord(e) && e.cause !== undefined) return `${own} ${messageOf(e.cause)}`;
  return own;
}

// ---------------------------------------------------------------------------------------------
// What the wallet told us: a hash and a signer, nothing more.
// ---------------------------------------------------------------------------------------------

export interface WalletReport {
  txHash: string | null;
  signerId: string | null;
  /** The wallet's own words, shown to the owner but never believed. */
  message: string | null;
  /** A PROBARION code found in those words: shown, never acted on. */
  code: string | null;
}

const EMPTY_REPORT: WalletReport = { txHash: null, signerId: null, message: null, code: null };

/** The wallet resolved. Its `status` is ignored: only the hash and the signer are taken. */
export function reportFromOutcome(outcome: unknown): WalletReport {
  try {
    if (!isRecord(outcome)) return EMPTY_REPORT;
    return {
      txHash: hashOfRecord(outcome),
      signerId: signerOfRecord(outcome),
      message: null,
      code: null,
    };
  } catch {
    return EMPTY_REPORT; // a hostile getter is not worth crashing the result for
  }
}

/** The wallet threw: a cancel, a closed window, a timeout, a contract panic it relayed. */
export function reportFromError(e: unknown): WalletReport {
  try {
    const message = messageOf(e);
    return {
      txHash: search(hashOfRecord, e) ?? hashInText(message),
      signerId: search(signerOfRecord, e),
      message,
      code: codeIn(searchText(e)),
    };
  } catch {
    return { ...EMPTY_REPORT, message: "The wallet reported an error it could not describe." };
  }
}

/**
 * What the client sends the server to check against the chain (`confirmTxAction`). Everything in it
 * is untrusted input to the server, and the server re-checks all of it.
 */
export interface ConfirmRequest {
  hash: string;
  /** The account the owner expected to sign (the session's), not whatever the wallet says it used. */
  signerId: string;
  /** The transaction that was shown: the chain's record has to match it action by action. */
  tx: PreparedTx;
  /** The final block height read when the send began; the transaction must be in a block at least this new. */
  baselineHeight: number | null;
}

/**
 * We cannot say what happened. With a hash the transaction exists and the owner can look it up; with
 * none, a cancel and a transaction that went out look the same to us.
 */
export function unconfirmed(report: WalletReport): TxResult {
  const fallback =
    report.txHash === null
      ? "The wallet gave no transaction."
      : "The wallet gave no result for this transaction.";
  return {
    status: "unknown",
    txHash: report.txHash,
    code: report.code,
    error: truncate(report.message ?? fallback),
  };
}

/** Before anything was signed (no wallet to talk to, wrong account): a definite "not sent". */
export function notSent(reason: unknown): TxResult {
  return { status: "failed", txHash: null, code: null, error: truncate(messageOf(reason)) };
}

// ---------------------------------------------------------------------------------------------
// What the chain told us: read by the server, decided here.
// ---------------------------------------------------------------------------------------------

/** The server's reading of a final `tx` RPC result (built by `confirm.ts` with the SDK). */
export interface ChainOutcome {
  txHash: string | null;
  /** The top-level status is a `SuccessValue`. */
  ok: boolean;
  /** The top-level status is a `Failure`. Neither `ok` nor `failed` means not final. */
  failed: boolean;
  /** The decoded return value (JSON, else text). */
  value: unknown;
  /** The `SuccessValue` was empty: the method returned nothing. */
  empty: boolean;
  /** A PROBARION code, or LackBalanceForState / NotEnoughBalance. */
  code: string | null;
  /** The failure in words (the SDK's plain-language text for the chain's balance refusals). */
  failure: string | null;
  /** Did the transaction's first receipt (the call itself) succeed? `null` when there are no receipts. */
  firstReceiptOk: boolean | null;
  /** Did any receipt of the transaction end in a Failure? */
  receiptFailed: boolean;
}

interface Decoded {
  empty: boolean;
  value: unknown;
}

type Verdict =
  | { kind: "ok" }
  | { kind: "refused"; reason: string }
  | { kind: "unknown"; reason: string };

type Reader = (d: Decoded) => Verdict;

const OK_VERDICT: Verdict = { kind: "ok" };
const explorer = (what: string): Verdict => ({
  kind: "unknown",
  reason: `${what}; confirm on the explorer.`,
});

/** Methods that return nothing: any SuccessValue means the contract ran to the end. */
const returnsNothing: Reader = () => OK_VERDICT;

/**
 * What each method must return before the owner is told "Done". Exhaustive over `ReadableMethod` (the
 * gas table's methods and `Transfer`): a method added without a reader here does not compile.
 */
export const READERS: Record<ReadableMethod, Reader> = {
  // contracts/factory/src/lib.rs on_vault_created -> Option<AccountId>
  create_vault(d) {
    if (d.empty) return explorer("The factory's answer was empty");
    if (d.value === null) return { kind: "refused", reason: REFUSED_CREATE_VAULT };
    if (typeof d.value === "string" && isNearAccountId(d.value)) return OK_VERDICT;
    return explorer("The factory answered with something other than a vault account");
  },
  // contracts/vault/src/held.rs approve -> PromiseOrValue<SpendResult>, settled by on_transfer / on_withdraw
  approve(d) {
    const status = isRecord(d.value) ? d.value.status : undefined;
    if (status === "paid" || status === "burned") return OK_VERDICT;
    if (status === "failed") return { kind: "refused", reason: REFUSED_APPROVE };
    return explorer(
      typeof status === "string"
        ? `The vault reports the spend as "${status.slice(0, 20)}", not paid`
        : "The vault's answer could not be read",
    );
  },
  // intents ft_withdraw -> U128: the amount withdrawn, "0" when the withdrawal was undone inside Intents
  withdraw_intents(d) {
    const value = d.value;
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
      return value === "0" ? { kind: "refused", reason: REFUSED_WITHDRAW_INTENTS } : OK_VERDICT;
    }
    return explorer("Intents' answer could not be read");
  },
  // contracts/vault/src/mandates.rs create_mandate -> u64, the new mandate's id (ids start at 1)
  create_mandate(d) {
    const value = d.value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return OK_VERDICT;
    return explorer("The vault did not return a mandate id");
  },
  add_agent: returnsNothing,
  remove_agent: returnsNothing,
  set_ledger_key: returnsNothing,
  revoke_mandate: returnsNothing,
  reject: returnsNothing,
  freeze: returnsNothing,
  unfreeze: returnsNothing,
  withdraw: returnsNothing, // the USDC ft_transfer returns nothing
  storage_deposit: returnsNothing,
  ft_transfer: returnsNothing,
  Transfer: returnsNothing, // a plain NEAR transfer (a vault top-up) returns nothing
};

function result(
  status: TxResult["status"],
  txHash: string | null,
  error: string | null,
  code: string | null = null,
): TxResult {
  return { status, txHash, code, error: error === null ? null : truncate(error) };
}

/** What a final, chain-read transaction means for the owner. */
export function interpretChain(method: ReadableMethod, c: ChainOutcome): TxResult {
  if (c.ok) {
    const verdict = READERS[method]({ empty: c.empty, value: c.value });
    if (verdict.kind === "refused") return result("failed", c.txHash, verdict.reason);
    if (verdict.kind === "unknown") return result("unknown", c.txHash, verdict.reason);
    if (c.receiptFailed) {
      return result(
        "unknown",
        c.txHash,
        "The call succeeded, but a step it started failed (a key, a registration or a refund may be missing); confirm on the explorer.",
      );
    }
    return result("ok", c.txHash, null);
  }
  if (c.failed) {
    const text = c.failure ?? "The transaction failed.";
    if (CALLBACK_METHODS.has(method) && c.firstReceiptOk !== false) {
      return result(
        "unknown",
        c.txHash,
        `The call ran, then a later step failed, so part of it may have happened; confirm on the explorer. (${text})`,
        c.code,
      );
    }
    return result("failed", c.txHash, text, c.code);
  }
  return result(
    "unknown",
    c.txHash,
    c.failure ?? "The transaction is not final yet; confirm on the explorer.",
  );
}

/** After an unconfirmed outcome the same action must not be signed again until the owner has checked. */
export function sendLocked(r: TxResult | null): boolean {
  return r?.status === "unknown";
}

export interface TxResultView {
  tone: "good" | "warn" | "bad";
  headline: string;
  detail: string | null;
  /** Which explorer page to link: the transaction, or (no hash) the signer's account. */
  explorer: "tx" | "account" | null;
}

/**
 * Words a wrapper may swap on what the owner reads, without touching the result: the detail line,
 * and only that. Never the headline, the tone, the explorer link or the result itself, so what a
 * result means, and the locked state, stay as outcome.ts decided.
 */
export interface ResultWords {
  /** `null` shows no detail line; leaving it out keeps the default one. */
  detail?: string | null;
}

/** `TxButton`'s `describe`: wording for a result (live, or read back after a reload), or nothing to keep ours. */
export type DescribeResult = (result: TxResult) => ResultWords | null | undefined;

/**
 * The view with a wrapper's words applied: the detail line only. The headline ("Done", "Refused",
 * "Sent: confirm on the explorer", "Not confirmed...") always stays ours, whatever a wrapper returns
 * (a caller that is not type-checked may still return one: it is ignored).
 */
export function withWords(view: TxResultView, words: ResultWords | null | undefined): TxResultView {
  if (words === null || words === undefined) return view;
  return { ...view, detail: words.detail !== undefined ? words.detail : view.detail };
}

export function describeTxResult(r: TxResult): TxResultView {
  if (r.status === "ok") {
    return { tone: "good", headline: "Done", detail: null, explorer: r.txHash ? "tx" : null };
  }
  if (r.status === "failed") {
    // A failure the chain confirmed always has a hash. One without is a call that never left us.
    return {
      tone: "bad",
      headline: r.txHash === null ? NOT_SENT_HEADLINE : r.code ? `Refused: ${r.code}` : "Refused",
      detail: r.error,
      explorer: r.txHash ? "tx" : null,
    };
  }
  const detail = r.code && r.error ? `${r.code}: ${r.error}` : (r.error ?? r.code);
  return {
    tone: "warn",
    headline: r.txHash ? UNKNOWN_HEADLINE : NOT_CONFIRMED_HEADLINE,
    detail,
    explorer: r.txHash ? "tx" : "account",
  };
}
