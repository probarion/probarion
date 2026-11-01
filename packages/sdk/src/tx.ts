import { KeyFormatError, publicKeyFromSecret, type VaultErrorCode } from "@probarion/core";
import {
  Account,
  actions,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPairString,
  type Provider,
} from "near-api-js";
import { ConfigError, extractProbarionCode, ProbarionError } from "./errors.js";

export interface FunctionCallTx {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

/**
 * R15: the chain itself (not the contract) refused the call because the vault account would fall
 * below the NEAR its storage needs. It is not a `PROBARION:` panic, so it is not a `VaultErrorCode`.
 */
export const LACK_BALANCE_CODE = "LackBalanceForState";

/** Every code a failed transaction can carry: a vault panic, or the chain's storage-balance refusal. */
export type TxFailureCode = VaultErrorCode | typeof LACK_BALANCE_CODE;

export const OUT_OF_NEAR_DETAIL =
  "vault is out of free NEAR; top up with a plain transfer (each paid spend keeps about 0.0048 NEAR of storage)";

export interface TxOutcome {
  txHash: string | null;
  ok: boolean;
  value: unknown;
  code: TxFailureCode | null;
  failure: string | null;
  raw: unknown;
}

export interface TxSender {
  readonly accountId: string;
  readonly publicKey: string;
  functionCall(tx: FunctionCallTx): Promise<TxOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ??
      String(value)
    );
  } catch {
    return String(value);
  }
}

function decodeSuccessValue(base64: string): unknown {
  if (base64 === "") return null;
  const text = Buffer.from(base64, "base64").toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The JSON key `LackBalanceForState` (ActionError.kind, InvalidTxError, a NotEnoughBalanceForDeposit
// reason), near-api-js's "lacks balance N yoctoNear for state", and nearcore's plain-text
// "doesn't / wouldn't have enough balance to cover storage".
const LACK_BALANCE_RE =
  /LackBalanceForState|(?:doesn'?t|does not|wouldn'?t|would not) have enough balance to cover storage|lacks balance .* for state/i;
const WALK_MAX_DEPTH = 16;

/** Look through keys, strings, errors and causes; cycles and deep nesting are cut off. */
function mentionsLackBalance(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (typeof value === "string") return LACK_BALANCE_RE.test(value);
  if (typeof value !== "object" || value === null || depth > WALK_MAX_DEPTH || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof Error) {
    if (LACK_BALANCE_RE.test(value.name) || LACK_BALANCE_RE.test(value.message)) return true;
    if (mentionsLackBalance(value.cause, seen, depth + 1)) return true;
  }
  for (const [key, item] of Object.entries(value)) {
    if (LACK_BALANCE_RE.test(key) || mentionsLackBalance(item, seen, depth + 1)) return true;
  }
  return false;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function txHashOf(raw: Record<string, unknown>): string | null {
  const tx = isRecord(raw.transaction) ? raw.transaction : null;
  const outcome = isRecord(raw.transaction_outcome) ? raw.transaction_outcome : null;
  return nonEmptyString(tx?.hash) ?? nonEmptyString(outcome?.id);
}

/**
 * A panic code from a receipt's own failure status. Only `outcome.status` is read: a receipt's logs
 * are text any contract can write, so a `PROBARION:` string there proves nothing.
 */
function codeFromReceipts(receipts: unknown): VaultErrorCode | null {
  if (!Array.isArray(receipts)) return null;
  for (const receipt of receipts) {
    const outcome = isRecord(receipt) && isRecord(receipt.outcome) ? receipt.outcome : null;
    const status = outcome?.status;
    if (isRecord(status) && status.Failure !== undefined) {
      const code = extractProbarionCode(status.Failure);
      if (code !== null) return code;
    }
  }
  return null;
}

function failedOutcome(raw: Record<string, unknown>, failure: unknown): TxOutcome {
  const txHash = txHashOf(raw);
  const panic = extractProbarionCode(failure);
  if (panic !== null) {
    return { txHash, ok: false, value: null, code: panic, failure: stringify(failure), raw };
  }
  if (mentionsLackBalance(failure)) {
    return {
      txHash,
      ok: false,
      value: null,
      code: LACK_BALANCE_CODE,
      failure: OUT_OF_NEAR_DETAIL,
      raw,
    };
  }
  return {
    txHash,
    ok: false,
    value: null,
    code: codeFromReceipts(raw.receipts_outcome),
    failure: stringify(failure),
    raw,
  };
}

const NOT_FINAL_STATUSES: ReadonlySet<string> = new Set(["NotStarted", "Started"]);

/**
 * Map a near-api-js / RPC transaction result to a `TxOutcome`.
 *
 * A contract panic (`PROBARION:<Code>`) gives `code`; the chain's storage-balance refusal gives
 * `LackBalanceForState` and a readable `failure` (R15). Any other failure keeps `code: null` and the
 * raw failure as text. A status that is not final yet is reported as not ok and says so: it is never
 * taken for a success.
 */
export function parseTxOutcome(raw: unknown): TxOutcome {
  if (!isRecord(raw)) throw new ProbarionError("transaction result is not an object", "TxFailed");
  const status = raw.status;
  if (isRecord(status) && typeof status.SuccessValue === "string") {
    return {
      txHash: txHashOf(raw),
      ok: true,
      value: decodeSuccessValue(status.SuccessValue),
      code: null,
      failure: null,
      raw,
    };
  }
  if (isRecord(status) && status.Failure !== undefined) return failedOutcome(raw, status.Failure);
  const notFinal =
    (typeof status === "string" && NOT_FINAL_STATUSES.has(status)) ||
    (isRecord(status) && status.SuccessReceiptId !== undefined);
  let failure: string;
  if (notFinal) failure = `transaction outcome is not final: ${stringify(status)}`;
  else if (status === undefined) failure = "transaction result has no status";
  else failure = stringify(status);
  return { txHash: txHashOf(raw), ok: false, value: null, code: null, failure, raw };
}

/** An RPC URL may carry an API key in its path, query or userinfo: error text keeps the origin only. */
function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return "<url>";
    }
  });
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TransactionTimeoutError" || /timed? ?out/i.test(error.message);
}

export interface NearApiJsSenderOptions {
  accountId: string;
  secretKey: string;
  rpcUrl: string | (() => string);
  /** Builds the provider for one RPC URL. Tests inject a fake; the default is near-api-js's `JsonRpcProvider`. */
  createProvider?: (url: string) => Provider;
}

/**
 * Signs with a function-call key through near-api-js 7 and waits for FINAL.
 *
 * `accountId` is the account the key lives on. The agent and ledger keys are function-call keys on
 * the vault itself, so both senders use the vault as `accountId`.
 */
export class NearApiJsSender implements TxSender {
  readonly accountId: string;
  readonly publicKey: string;
  // A #private field: it never shows up in JSON.stringify, console.log or util.inspect.
  readonly #signer: KeyPairSigner;
  readonly #rpcUrl: string | (() => string);
  readonly #createProvider: (url: string) => Provider;

  constructor(opts: NearApiJsSenderOptions) {
    this.accountId = opts.accountId;
    try {
      this.publicKey = publicKeyFromSecret(opts.secretKey);
    } catch (error) {
      if (error instanceof KeyFormatError) {
        // KeyFormatError names the kind of value and its length, never its content.
        throw new ConfigError(`invalid secret key for ${opts.accountId}: ${error.message}`);
      }
      throw error;
    }
    this.#signer = KeyPairSigner.fromSecretKey(opts.secretKey as KeyPairString);
    this.#rpcUrl = opts.rpcUrl;
    this.#createProvider = opts.createProvider ?? ((url) => new JsonRpcProvider({ url }));
  }

  async functionCall(tx: FunctionCallTx): Promise<TxOutcome> {
    const url = typeof this.#rpcUrl === "function" ? this.#rpcUrl() : this.#rpcUrl;
    const account = new Account(this.accountId, this.#createProvider(url), this.#signer);
    let raw: unknown;
    try {
      raw = await account.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions: [actions.functionCall(tx.methodName, tx.args, tx.gas, tx.deposit)],
        waitUntil: "FINAL",
        throwOnFailure: false,
      });
    } catch (error) {
      return this.fromThrown(tx, error);
    }
    return parseTxOutcome(raw);
  }

  /** The node refused or lost the transaction. A contract panic or a storage refusal is an outcome; the rest is not. */
  private fromThrown(tx: FunctionCallTx, error: unknown): TxOutcome {
    const detail = redactUrls(error instanceof Error ? error.message : String(error));
    const txHash = isRecord(error) ? nonEmptyString(error.txHash) : null;
    if (mentionsLackBalance(error)) {
      return {
        txHash,
        ok: false,
        value: null,
        code: LACK_BALANCE_CODE,
        failure: OUT_OF_NEAR_DETAIL,
        raw: null,
      };
    }
    const code = extractProbarionCode(error);
    if (code !== null) return { txHash, ok: false, value: null, code, failure: detail, raw: null };
    const hint = isTimeout(error)
      ? " (the transaction may still be included on chain; check the explorer before sending it again)"
      : "";
    throw new ProbarionError(
      `${tx.methodName} transaction could not be sent: ${detail}${hint}`,
      "TxSendFailed",
      { cause: error },
    );
  }
}
