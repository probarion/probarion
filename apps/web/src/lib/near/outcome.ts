/**
 * Turns what a wallet hands back into one honest result.
 *
 * Three rules, all about money:
 *
 * 1. A wallet call that resolved is not an action that succeeded (R12). `create_vault` refunds and
 *    returns `null` when the name is taken; `approve` returns a `SpendResult` whose status may be
 *    `failed`; `withdraw_intents` returns `"0"` when Intents paid nothing out. The base64
 *    `SuccessValue` is decoded per method before anything is called "ok".
 * 2. An outcome we cannot read is `unknown`, never `ok` and never `failed`.
 * 3. Never retry on `unknown` (the SDK's `TxOutcomeUnknownError` rule). If the wallet reports an
 *    error but there is a transaction hash, or the outcome is missing, or the call timed out after
 *    it may have been broadcast, the transaction may have run. The owner is told to confirm on the
 *    explorer; nothing here, and nothing in the UI, signs the same action again.
 */
import { VAULT_ERROR_CODES } from "@probarion/core";

export interface TxResult {
  status: "ok" | "failed" | "unknown";
  txHash: string | null;
  code: string | null; // PROBARION:<Code> from IF §4.3
  error: string | null;
}

const MAX_TEXT = 500;
const MAX_HASH = 128;
const KNOWN_CODES: ReadonlySet<string> = new Set(VAULT_ERROR_CODES);

/** What the owner is told when the outcome may hide a transaction that ran. */
export const UNKNOWN_HEADLINE = "Sent: confirm on the explorer";
/** R12: the factory's `on_vault_created` returned `null` (the batch rolled back and the deposit went back). */
export const REFUSED_CREATE_VAULT = "name taken or deposit too low, refunded";
/** R12: `approve` came back with status `failed` (the vault released the reservation). */
export const REFUSED_APPROVE = "payout failed, reservation released";
/** `ft_withdraw` resolves to "0" when nothing left Intents (contracts/vault/src/spend.rs `on_withdraw`). */
export const REFUSED_WITHDRAW_INTENTS =
  "nothing was withdrawn: Intents paid nothing out, so the balance stays in Intents";

const NO_OUTCOME = "The wallet returned no outcome; confirm on the explorer.";

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

function hashString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_HASH ? value : null;
}

/** transaction.hash, else transaction_outcome.id (a FinalExecutionOutcome), else a plain hash field. */
function hashOfRecord(o: Record<string, unknown>): string | null {
  const tx = isRecord(o.transaction) ? o.transaction : null;
  const first = isRecord(o.transaction_outcome) ? o.transaction_outcome : null;
  return (
    hashString(tx?.hash) ??
    hashString(first?.id) ??
    hashString(o.txHash) ??
    hashString(o.tx_hash) ??
    hashString(o.transactionHash) ??
    hashString(o.transaction_hash)
  );
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

/** A hash an error object carries, looking a few levels into the places wallets and near-api-js put it. */
function hashInObject(value: unknown, depth = 0, seen = new WeakSet<object>()): string | null {
  if (typeof value !== "object" || value === null || depth > 4 || seen.has(value)) return null;
  seen.add(value);
  try {
    const o = value as Record<string, unknown>;
    const own = hashOfRecord(o);
    if (own !== null) return own;
    for (const key of NESTED_KEYS) {
      const found = hashInObject(o[key], depth + 1, seen);
      if (found !== null) return found;
    }
  } catch {
    // a hostile getter is not worth crashing the result for
  }
  return null;
}

// A transaction hash is 43-44 base58 characters. In free text, only trust one next to a word that
// says what it is, or inside an explorer URL: a public key in the same message must not match.
const HASH_IN_TEXT =
  /(?:\/txns?\/|\btransaction(?:[ _-]?(?:hash|id))?\b[\s:#="']*|\btx(?:[ _-]?(?:hash|id))?\b[\s:#="']*)([1-9A-HJ-NP-Za-km-z]{43,44})(?![1-9A-HJ-NP-Za-km-z])/i;

function hashInText(text: string): string | null {
  return HASH_IN_TEXT.exec(text)?.[1] ?? null;
}

// Errors that say the request may have reached the network and the answer was lost. The wallet
// could have broadcast before this happened, so these are unknown, not failed. (`timeout` also
// covers the TIMEOUT_ERROR near-api-js raises.)
const MAY_HAVE_BEEN_SENT =
  /time(?:d)?[ _-]?out|exceeded\s+\d+\s+seconds|failed to fetch|fetch failed|network\s?error|socket hang up|ECONN(?:RESET|ABORTED|REFUSED)|ENOTFOUND|EAI_AGAIN/i;

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

function unknown(txHash: string | null, error: string, code: string | null = null): TxResult {
  return { status: "unknown", txHash, code, error: truncate(error) };
}

function failed(txHash: string | null, error: string, code: string | null = null): TxResult {
  return { status: "failed", txHash, code, error: truncate(error) };
}

const OK = (txHash: string | null): TxResult => ({
  status: "ok",
  txHash,
  code: null,
  error: null,
});

interface Decoded {
  /** True for an empty SuccessValue: the method returned nothing. */
  empty: boolean;
  value: unknown;
}

/** base64 -> UTF-8 -> JSON. `null` when any step fails (that is not the same as the JSON value null). */
function decodeReturn(base64: string): Decoded | null {
  if (base64 === "") return { empty: true, value: undefined };
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { empty: false, value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

type Verdict =
  | { kind: "ok" }
  | { kind: "refused"; reason: string }
  | { kind: "unknown"; reason: string };

const OK_VERDICT: Verdict = { kind: "ok" };
const explorer = (what: string): Verdict => ({
  kind: "unknown",
  reason: `${what}; confirm on the explorer.`,
});

/**
 * What each method that returns a value must return before the owner is told "Done".
 * Methods that return nothing (freeze, reject, the key calls, withdraw's ft_transfer) are not here:
 * any SuccessValue means the contract ran to the end, and a failed promise fails the transaction.
 */
const READERS: Record<string, (d: Decoded | null) => Verdict> = {
  // contracts/factory/src/lib.rs on_vault_created -> Option<AccountId>
  create_vault(d) {
    if (d === null || d.empty) return explorer("The factory's answer could not be read");
    if (d.value === null) return { kind: "refused", reason: REFUSED_CREATE_VAULT };
    if (typeof d.value === "string" && d.value.length > 0) return OK_VERDICT;
    return explorer("The factory answered with something other than a vault account");
  },
  // contracts/vault/src/held.rs approve -> PromiseOrValue<SpendResult>, settled by on_transfer / on_withdraw
  approve(d) {
    const status = d !== null && isRecord(d.value) ? d.value.status : undefined;
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
    const value = d?.value;
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
      return value === "0" ? { kind: "refused", reason: REFUSED_WITHDRAW_INTENTS } : OK_VERDICT;
    }
    return explorer("Intents' answer could not be read");
  },
  // contracts/vault/src/mandates.rs create_mandate -> u64, the new mandate's id (ids start at 1)
  create_mandate(d) {
    const value = d?.value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return OK_VERDICT;
    return explorer("The vault did not return a mandate id");
  },
};

function fromSuccessValue(
  base64: string,
  method: string | undefined,
  txHash: string | null,
): TxResult {
  const read = method !== undefined && Object.hasOwn(READERS, method) ? READERS[method] : undefined;
  if (read === undefined) return OK(txHash);
  const verdict = read(decodeReturn(base64));
  if (verdict.kind === "ok") return OK(txHash);
  if (verdict.kind === "refused") return failed(txHash, verdict.reason);
  return unknown(txHash, verdict.reason);
}

/**
 * The top-level status reflects the method's final result (including its promise callback).
 * `method` is the last call of the transaction; without it any SuccessValue is "ok".
 */
export function parseTxOutcome(outcome: unknown, method?: string): TxResult {
  if (!isRecord(outcome)) return unknown(null, NO_OUTCOME);
  const txHash = hashOfRecord(outcome);
  const status = outcome.status;
  if (status === "Failure")
    return failed(txHash, "The transaction failed (the wallet gave no details).");
  if (isRecord(status) && "Failure" in status) {
    const text = safeStringify(status.Failure);
    return { status: "failed", txHash, code: codeIn(text), error: truncate(text) };
  }
  if (isRecord(status) && typeof status.SuccessValue === "string") {
    return fromSuccessValue(status.SuccessValue, method, txHash);
  }
  if (isRecord(status) && "SuccessReceiptId" in status) {
    return unknown(
      txHash,
      "The transaction was accepted but its final result is not known yet; confirm on the explorer.",
    );
  }
  return unknown(txHash, "Unrecognised outcome status; confirm on the explorer.");
}

/**
 * A wallet call that threw. With a transaction hash, or an error that looks like a lost answer (a
 * timeout), the transaction may have run: `unknown`. Otherwise the wallet or the contract said no
 * and nothing was sent: `failed`.
 */
export function parseWalletError(e: unknown): TxResult {
  const message = messageOf(e);
  const code = codeIn(searchText(e));
  const txHash = hashInObject(e) ?? hashInText(message);
  if (txHash !== null) return unknown(txHash, message, code);
  if (MAY_HAVE_BEEN_SENT.test(message)) return unknown(null, message, code);
  return failed(null, message, code);
}

/** An error before anything was sent (no wallet to talk to): nothing was signed, so this is a definite failure. */
export function parseConnectError(e: unknown): TxResult {
  return failed(null, messageOf(e));
}

/**
 * Runs one wallet send and turns its result or its error into a `TxResult`. It calls `send` exactly
 * once, never retries, and never throws: whatever happens, the caller gets a result to show.
 */
export async function settleSend(send: () => Promise<unknown>, method?: string): Promise<TxResult> {
  let outcome: unknown;
  try {
    outcome = await send();
  } catch (e) {
    return parseWalletError(e);
  }
  try {
    return parseTxOutcome(outcome, method);
  } catch {
    return unknown(null, "The wallet's outcome could not be read; confirm on the explorer.");
  }
}

/** After an unknown outcome the same action must not be signed again until the owner has checked. */
export function sendLocked(result: TxResult | null): boolean {
  return result?.status === "unknown";
}

export interface TxResultView {
  tone: "good" | "warn" | "bad";
  headline: string;
  detail: string | null;
  /** Which explorer page to link: the transaction, or (no hash) the signer's account. */
  explorer: "tx" | "account" | null;
}

export function describeTxResult(r: TxResult): TxResultView {
  if (r.status === "ok") {
    return { tone: "good", headline: "Done", detail: null, explorer: r.txHash ? "tx" : null };
  }
  if (r.status === "failed") {
    return {
      tone: "bad",
      headline: r.code ? `Refused: ${r.code}` : "Refused",
      detail: r.error,
      explorer: r.txHash ? "tx" : null,
    };
  }
  return {
    tone: "warn",
    headline: UNKNOWN_HEADLINE,
    detail: r.error,
    explorer: r.txHash ? "tx" : "account",
  };
}
