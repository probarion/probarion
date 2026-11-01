import { createHash } from "node:crypto";
import { KeyFormatError, publicKeyFromSecret, type VaultErrorCode } from "@probarion/core";
import {
  Account,
  actions,
  baseEncode,
  encodeTransaction,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPairString,
  type Provider,
  type SignedTransaction,
} from "near-api-js";
import {
  AccessKeyNotEnoughAllowanceActionError,
  AccessKeyNotFoundActionError,
  InvalidNonceError,
  InvalidTransactionError,
  SignerDoesNotExistError,
  TransactionExecutionError,
} from "near-api-js/rpc-errors";
import {
  ConfigError,
  extractProbarionCode,
  ProbarionError,
  TxOutcomeUnknownError,
  TxRejectedError,
} from "./errors.js";

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

/**
 * The sibling of `LackBalanceForState`: the vault cannot even prepay the gas of the call (the chain
 * refuses the transaction before it runs). It is a separate code because the cause and the text
 * differ; the remedy, a plain transfer to the vault, is the same. Use `isOutOfNearCode` to treat
 * both the same way.
 */
export const NOT_ENOUGH_BALANCE_CODE = "NotEnoughBalance";

/** Every code a failed transaction can carry: a vault panic, or one of the chain's balance refusals. */
export type TxFailureCode =
  | VaultErrorCode
  | typeof LACK_BALANCE_CODE
  | typeof NOT_ENOUGH_BALANCE_CODE;

export const OUT_OF_NEAR_DETAIL =
  "vault is out of free NEAR; top up with a plain transfer (each paid spend keeps about 0.0048 NEAR of storage)";

export const OUT_OF_GAS_NEAR_DETAIL =
  "vault holds less NEAR than a spend must prepay for gas (about 0.02 NEAR at 200 Tgas); top up with a plain transfer";

/** True for `LackBalanceForState` and `NotEnoughBalance`: the vault needs a plain NEAR transfer. */
export function isOutOfNearCode(
  code: unknown,
): code is typeof LACK_BALANCE_CODE | typeof NOT_ENOUGH_BALANCE_CODE {
  return code === LACK_BALANCE_CODE || code === NOT_ENOUGH_BALANCE_CODE;
}

export interface TxOutcome {
  txHash: string | null;
  ok: boolean;
  value: unknown;
  code: TxFailureCode | null;
  failure: string | null;
  raw: unknown;
}

/**
 * Signs and sends one function call as `accountId` and waits for its final outcome.
 *
 * `functionCall` settles one of five ways, and the difference is money-critical:
 *
 * - It returns an outcome with `ok: true` or `ok: false`: the chain answered and ran the call (a
 *   contract panic is `ok: false` with its `code`), or refused it because the vault is out of
 *   NEAR (`LackBalanceForState` or `NotEnoughBalance`, see `isOutOfNearCode`).
 * - It throws `TxRejectedError`: the node refused the signed transaction before running it (no
 *   allowance, a removed key, a bad signature, a nonce it would not accept). Nothing changed.
 * - It throws `TxSendFailed` (a `ProbarionError`): the transaction could not even be built and
 *   signed. Nothing was sent, so sending again is safe.
 * - It throws `ConfigError`: the sender is not set up for this call.
 * - It throws `TxOutcomeUnknownError`: the transaction WAS sent and its outcome is not known. It
 *   may have run. The caller (the payment flow) must record the error's `txHash` and `signerId`
 *   (for the ledger: as an unconfirmed payment) and must NEVER send the call again, least of all
 *   with a fresh `ref`. Resolve it with `lookup(txHash)`.
 */
export interface TxSender {
  readonly accountId: string;
  readonly publicKey: string;
  functionCall(tx: FunctionCallTx): Promise<TxOutcome>;
  /** Read the final outcome of a transaction this sender signed. Throws `TxOutcomeUnknownError` if it cannot. */
  lookup?(txHash: string): Promise<TxOutcome>;
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
// InvalidTxError.NotEnoughBalance (a key, or the `reason` of NotEnoughBalanceForDeposit),
// near-api-js's NotEnoughBalanceError (its name, and "Not enough balance for <account> (...)").
// Anchored: `NotEnoughBalanceForDeposit` and free text do not match.
const NOT_ENOUGH_BALANCE_RE = /^NotEnoughBalance(?:Error)?$|^Not enough balance for /;
const WALK_MAX_DEPTH = 16;

/** Look through keys, strings, errors and causes; cycles and deep nesting are cut off. */
function mentions(re: RegExp, value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (typeof value === "string") return re.test(value);
  if (typeof value !== "object" || value === null || depth > WALK_MAX_DEPTH || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof Error) {
    if (re.test(value.name) || re.test(value.message)) return true;
    if (mentions(re, value.cause, seen, depth + 1)) return true;
  }
  for (const [key, item] of Object.entries(value)) {
    if (re.test(key) || mentions(re, item, seen, depth + 1)) return true;
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

/**
 * Did the FIRST receipt of a finished transaction succeed? For a call whose signer is its receiver
 * (every vault call) that receipt is the function call itself, so the answer separates two very
 * different failures:
 *
 * - `false`: the call itself failed (a panic, a refusal). It changed nothing.
 * - `true`: the call ran and spawned further receipts, and one of those failed. For `spend` that is
 *   a failed callback after the payout may have gone out.
 * - `null`: the result carries no receipts to tell.
 */
export function firstReceiptSucceeded(raw: unknown): boolean | null {
  if (!isRecord(raw) || !Array.isArray(raw.receipts_outcome)) return null;
  const root =
    isRecord(raw.transaction_outcome) && isRecord(raw.transaction_outcome.outcome)
      ? raw.transaction_outcome.outcome
      : null;
  const firstId = Array.isArray(root?.receipt_ids) ? root.receipt_ids[0] : undefined;
  const first =
    raw.receipts_outcome.find((r: unknown) => isRecord(r) && r.id === firstId) ??
    raw.receipts_outcome[0];
  const status = isRecord(first) && isRecord(first.outcome) ? first.outcome.status : undefined;
  if (!isRecord(status)) return null;
  if (status.Failure !== undefined) return false;
  if (status.SuccessReceiptId !== undefined || status.SuccessValue !== undefined) return true;
  return null;
}

function failedOutcome(raw: Record<string, unknown>, failure: unknown): TxOutcome {
  const txHash = txHashOf(raw);
  const panic = extractProbarionCode(failure);
  if (panic !== null) {
    return { txHash, ok: false, value: null, code: panic, failure: stringify(failure), raw };
  }
  if (mentions(LACK_BALANCE_RE, failure)) {
    return {
      txHash,
      ok: false,
      value: null,
      code: LACK_BALANCE_CODE,
      failure: OUT_OF_NEAR_DETAIL,
      raw,
    };
  }
  if (mentions(NOT_ENOUGH_BALANCE_RE, failure)) {
    return {
      txHash,
      ok: false,
      value: null,
      code: NOT_ENOUGH_BALANCE_CODE,
      failure: OUT_OF_GAS_NEAR_DETAIL,
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

/** A finished transaction has a `SuccessValue` or a `Failure`; anything else is still in flight. */
function isFinalResult(raw: unknown): raw is Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.status)) return false;
  return typeof raw.status.SuccessValue === "string" || raw.status.Failure !== undefined;
}

/**
 * Map a near-api-js / RPC transaction result to a `TxOutcome`.
 *
 * A contract panic (`PROBARION:<Code>`) gives `code`; the chain's balance refusals give
 * `LackBalanceForState` (R15) or `NotEnoughBalance` and a readable `failure`. Any other failure keeps
 * `code: null` and the raw failure as text. A status that is not final yet is reported as not ok and
 * says so: it is never taken for a success.
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

const COPY_MAX_DEPTH = 4;

/**
 * A copy of an error for use as `cause`: same name, message and stack, with every URL cut to its
 * origin, so `console.error(err)` and a logged cause chain never print an RPC URL with its key.
 */
function redactedCopy(error: unknown, depth = 0): unknown {
  if (error instanceof Error) {
    const cause =
      depth < COPY_MAX_DEPTH && error.cause !== undefined
        ? { cause: redactedCopy(error.cause, depth + 1) }
        : undefined;
    const copy = new Error(redactUrls(error.message), cause);
    copy.name = error.name;
    if (error.stack !== undefined) copy.stack = redactUrls(error.stack);
    return copy;
  }
  if (typeof error === "string") return redactUrls(error);
  if (typeof error === "number" || typeof error === "boolean" || error == null) return error;
  return redactUrls(stringify(error));
}

function messageOf(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error));
}

class DeadlineError extends Error {
  override name = "DeadlineExceeded";
}

/** Reject after `ms`. The work itself cannot be cancelled; its late result or error is ignored. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The transaction hash: base58 of sha256 of the borsh-encoded transaction (what the node reports, and what was signed). */
function hashOfSigned(signed: SignedTransaction): string {
  return baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
}

// The access key's nonce can be taken by another transaction between the read and the send; the node
// then refuses ours before running it, and a fresh signature with a fresh nonce is safe.
const NONCE_RETRIES = 10;
const DEFAULT_SEND_TIMEOUT_MS = 90_000;

function keyRole(methodName: string): string {
  if (methodName === "spend") return "agent key";
  if (methodName === "anchor") return "ledger key";
  return "function-call key";
}

function allowanceRemedy(methodName: string): string {
  if (methodName === "spend") return " (remove_agent, then add_agent)";
  if (methodName === "anchor") return " (set_ledger_key, with a key that is not the current one)";
  return "";
}

/** The node answered the send with a typed refusal of the transaction itself (it ran nothing). */
function isTypedRefusal(error: unknown): error is Error {
  return error instanceof TransactionExecutionError || error instanceof InvalidTransactionError;
}

/**
 * A typed refusal that means "the vault is out of NEAR" is an outcome (R15), not an error: the
 * caller records it and tells the owner to top up. Returns `null` for any other refusal.
 */
function balanceRefusal(error: Error): TxOutcome | null {
  const refused = (code: TxFailureCode, failure: string): TxOutcome => ({
    txHash: null,
    ok: false,
    value: null,
    code,
    failure,
    raw: null,
  });
  if (mentions(LACK_BALANCE_RE, error)) return refused(LACK_BALANCE_CODE, OUT_OF_NEAR_DETAIL);
  if (mentions(NOT_ENOUGH_BALANCE_RE, error)) {
    return refused(NOT_ENOUGH_BALANCE_CODE, OUT_OF_GAS_NEAR_DETAIL);
  }
  return null;
}

/** Any other typed refusal: the node looked at the signed transaction and refused it before running anything. */
function rejectionOf(tx: FunctionCallTx, error: Error): TxRejectedError {
  const detail = messageOf(error);
  let kind = error.name.replace(/(?:ActionError|Error)$/, "") || error.name;
  let text = detail;
  if (error instanceof AccessKeyNotEnoughAllowanceActionError) {
    kind = "NotEnoughAllowance";
    text = `the ${keyRole(tx.methodName)}'s allowance is used up; the owner must re-add the key with a new allowance${allowanceRemedy(tx.methodName)}. (${detail})`;
  } else if (
    error instanceof AccessKeyNotFoundActionError ||
    error instanceof SignerDoesNotExistError
  ) {
    kind = "AccessKeyNotFound";
    text = `the ${keyRole(tx.methodName)} is not on the vault account (removed, or never added). (${detail})`;
  } else if (error instanceof InvalidNonceError) {
    kind = "InvalidNonce";
    text = `the node kept refusing the key's nonce after ${NONCE_RETRIES} fresh signatures. (${detail})`;
  }
  return new TxRejectedError(
    `${tx.methodName} transaction refused by the node before it ran (nothing changed): ${kind}: ${text}`,
    kind,
    { cause: redactedCopy(error) },
  );
}

export interface NearApiJsSenderOptions {
  accountId: string;
  secretKey: string;
  rpcUrl: string | (() => string);
  /** Builds the provider for one RPC URL. Tests inject a fake; the default is near-api-js's `JsonRpcProvider`. */
  createProvider?: (url: string) => Provider;
  /**
   * How long to wait for each step (signing, then the send, then a lookup) before giving up:
   * milliseconds, default 90 000. A send that runs out of time throws `TxOutcomeUnknownError`.
   */
  sendTimeoutMs?: number;
}

/**
 * Signs with a function-call key through near-api-js 7 and waits for FINAL.
 *
 * `accountId` is the account the key lives on. The agent and ledger keys are function-call keys on
 * the vault itself, so both senders use the vault as `accountId`.
 *
 * The transaction is signed first and its hash computed before anything leaves the process, so the
 * hash is known even when the answer never arrives. A failure before the send is `TxSendFailed`
 * (nothing was sent). A refusal by the node is a `TxRejectedError` (or, for a vault out of NEAR,
 * an `ok: false` outcome). Anything else after the send is `TxOutcomeUnknownError`: the payment flow (Task 13) must record it with its `txHash` and must
 * never retry the call, least of all with a fresh `ref`; it reads the result with `lookup`.
 */
export class NearApiJsSender implements TxSender {
  readonly accountId: string;
  readonly publicKey: string;
  // #private fields never show up in JSON.stringify, console.log or util.inspect.
  readonly #signer: KeyPairSigner;
  readonly #rpcUrl: string | (() => string);
  readonly #createProvider: (url: string) => Provider;
  readonly #sendTimeoutMs: number;

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
    const timeout = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new ConfigError("sendTimeoutMs must be a positive number of milliseconds");
    }
    this.#signer = KeyPairSigner.fromSecretKey(opts.secretKey as KeyPairString);
    this.#rpcUrl = opts.rpcUrl;
    this.#createProvider = opts.createProvider ?? ((url) => new JsonRpcProvider({ url }));
    this.#sendTimeoutMs = timeout;
  }

  #provider(): Provider {
    return this.#createProvider(typeof this.#rpcUrl === "function" ? this.#rpcUrl() : this.#rpcUrl);
  }

  async functionCall(tx: FunctionCallTx): Promise<TxOutcome> {
    for (let attempt = 0; ; attempt++) {
      const provider = this.#provider();
      const signed = await this.sign(provider, tx);
      const txHash = hashOfSigned(signed);
      let raw: unknown;
      try {
        raw = await withDeadline(
          provider.sendTransactionUntil(signed, "FINAL"),
          this.#sendTimeoutMs,
          `${tx.methodName} transaction ${txHash}`,
        );
      } catch (error) {
        if (error instanceof InvalidNonceError && attempt < NONCE_RETRIES) continue;
        if (isTypedRefusal(error)) {
          const balance = balanceRefusal(error);
          if (balance !== null) return balance;
          throw rejectionOf(tx, error);
        }
        throw this.unknown(`${tx.methodName} transaction`, txHash, error);
      }
      return this.finish(`${tx.methodName} transaction`, txHash, raw);
    }
  }

  /** Read the final outcome of a transaction this sender signed (`txHash` from a `TxOutcomeUnknownError`). */
  async lookup(txHash: string): Promise<TxOutcome> {
    let raw: unknown;
    try {
      raw = await withDeadline(
        this.#provider().viewTransactionStatus({
          txHash,
          accountId: this.accountId,
          waitUntil: "FINAL",
        }),
        this.#sendTimeoutMs,
        `lookup of transaction ${txHash}`,
      );
    } catch (error) {
      throw this.unknown("transaction", txHash, error);
    }
    return this.finish("transaction", txHash, raw);
  }

  /** Build and sign. Nothing leaves the process here, so any failure is definite: `TxSendFailed`. */
  private async sign(provider: Provider, tx: FunctionCallTx): Promise<SignedTransaction> {
    try {
      const account = new Account(this.accountId, provider, this.#signer);
      return await withDeadline(
        account.createSignedTransaction({
          receiverId: tx.receiverId,
          actions: [actions.functionCall(tx.methodName, tx.args, tx.gas, tx.deposit)],
          signer: this.#signer,
        }),
        this.#sendTimeoutMs,
        `signing the ${tx.methodName} transaction`,
      );
    } catch (error) {
      throw new ProbarionError(
        `${tx.methodName} transaction could not be sent (nothing was sent): ${messageOf(error)}`,
        "TxSendFailed",
        { cause: redactedCopy(error) },
      );
    }
  }

  private finish(label: string, txHash: string, raw: unknown): TxOutcome {
    if (!isFinalResult(raw)) {
      throw this.unknown(
        label,
        txHash,
        new Error(
          `the node answered before the transaction was final: ${stringify(raw).slice(0, 200)}`,
        ),
      );
    }
    const outcome = parseTxOutcome(raw);
    return outcome.txHash === null ? { ...outcome, txHash } : outcome;
  }

  private unknown(label: string, txHash: string, error: unknown): TxOutcomeUnknownError {
    return new TxOutcomeUnknownError(
      `the outcome of ${label} ${txHash} (signed by ${this.accountId}) is unknown: ${messageOf(error)}. It may have run. Do not send it again; read its outcome with lookup(${JSON.stringify(txHash)}).`,
      txHash,
      this.accountId,
      { cause: redactedCopy(error) },
    );
  }
}
