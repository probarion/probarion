import { type AccessKeyInfo, NETWORKS } from "@probarion/core";
import { envValue } from "./env.js";
import { ConfigError, type RpcAttempt, RpcError, RpcMalformedError, ViewError } from "./errors.js";
import { isRecord } from "./guards.js";

export interface RpcClientOptions {
  urls: readonly string[];
  fetch?: typeof fetch;
  /** Rounds over the whole URL list before giving up: an integer from 1 to 10 (default 3). */
  maxRounds?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Milliseconds the caller has left for its whole job (default: no overall limit). It is read before every try and
   * every back-off: a try gets the smaller of `timeoutMs` and what is left, a back-off is cut to what is left, and
   * when nothing is left the call stops with an `RpcError` instead of trying the next endpoint. For a caller that
   * answers inside a platform's time limit.
   */
  remainingMs?: () => number;
}

export interface ViewAccountResult {
  amount: string;
  locked: string;
  code_hash: string;
  /**
   * NEP-591: the hash of the global contract this account uses, `null` when it runs its own
   * deployed code (RPC omits the field then). A factory vault in global mode has an all-zero
   * `code_hash` and its real code identity here.
   */
  global_contract_hash: string | null;
  storage_usage: number;
}

export interface ExecutionOutcomeView {
  id: string;
  outcome: { logs: string[]; receipt_ids: string[]; executor_id: string; status: unknown };
}

export interface TxStatusResult {
  status: unknown;
  transaction: { hash: string; signer_id: string; receiver_id: string };
  transaction_outcome: ExecutionOutcomeView;
  receipts_outcome: ExecutionOutcomeView[];
}

type Attempt =
  | { kind: "ok"; result: unknown }
  | {
      kind: "retry";
      message: string;
      retryAfterMs: number | null;
      cause?: unknown;
      /** The node's JSON-RPC error, when a node answered with one that another endpoint may not repeat. */
      rpcError?: unknown;
    }
  // `error` is the raw JSON-RPC error object, or `null` for an HTTP-level failure that is not
  // worth a failover (so it never turns into a ViewError).
  | { kind: "fatal"; message: string; error: unknown };

const MAX_ROUNDS_LIMIT = 10;
const EMPTY: Record<string, unknown> = {};

function describeRpcError(error: unknown): string {
  if (!isRecord(error)) return String(error);
  const cause = isRecord(error.cause) ? error.cause : EMPTY;
  const data =
    typeof error.data === "string" ? error.data : JSON.stringify(error.data ?? cause.info ?? null);
  return [error.name, cause.name, error.message, data]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0 && part !== "null",
    )
    .join(": ");
}

/** Transaction sends: their errors keep the strict rule, so a signed transaction is never sent twice. */
const SEND_METHODS: ReadonlySet<string> = new Set([
  "send_tx",
  "broadcast_tx_commit",
  "broadcast_tx_async",
]);

/**
 * Node-side failures that say nothing about the queried target: another endpoint may answer (Task 14 fix 4).
 * Only for reads (`query`, `tx` lookups, views): resending a read is harmless.
 */
const READ_TRANSIENT_NAMES: ReadonlySet<string> = new Set([
  "INTERNAL_ERROR",
  "UNAVAILABLE_SHARD",
  "NOT_SYNCED_YET",
]);

/** A node answered INTERNAL_ERROR, UNAVAILABLE_SHARD or NOT_SYNCED_YET: worth a failover for a read, but an answer. */
function isReadTransientAnswer(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const cause = isRecord(error.cause) ? error.cause : EMPTY;
  return (
    (typeof error.name === "string" && READ_TRANSIENT_NAMES.has(error.name)) ||
    (typeof cause.name === "string" && READ_TRANSIENT_NAMES.has(cause.name))
  );
}

function isTransientRpcError(error: unknown, method: string): boolean {
  if (!isRecord(error)) return false;
  const cause = isRecord(error.cause) ? error.cause : EMPTY;
  if (
    error.name === "TIMEOUT_ERROR" ||
    cause.name === "TIMEOUT_ERROR" ||
    cause.name === "NO_SYNCED_BLOCKS"
  ) {
    return true;
  }
  if (SEND_METHODS.has(method)) return false;
  return (
    (typeof error.name === "string" && READ_TRANSIENT_NAMES.has(error.name)) ||
    (typeof cause.name === "string" && READ_TRANSIENT_NAMES.has(cause.name))
  );
}

/**
 * Retry-After is delay-seconds or an HTTP-date. An empty, invalid, zero or already-past value is
 * treated as absent, so the caller falls back to its own backoff and never to a zero-wait retry.
 */
function parseRetryAfter(value: string | null): number | null {
  const text = value?.trim();
  if (text === undefined || text.length === 0) return null;
  const ms = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Origin only: an RPC URL may carry an API key in its path, query or userinfo. */
function redactUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<invalid url>";
  }
}

/** Tell a refused connection, a DNS failure and a TLS failure apart: undici hides the code in `cause`. */
function describeNetworkError(error: unknown, timeoutMs: number): string {
  if (!(error instanceof Error)) return `network error: ${String(error)}`;
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return `network error: timed out after ${timeoutMs}ms`;
  }
  const cause: unknown = error.cause;
  let detail: string | undefined;
  if (isRecord(cause)) {
    if (typeof cause.code === "string" && cause.code.length > 0) detail = cause.code;
    else if (typeof cause.message === "string" && cause.message.length > 0) detail = cause.message;
  }
  return detail === undefined || detail === error.message
    ? `network error: ${error.message}`
    : `network error: ${error.message} (${detail})`;
}

/** Cancel an unread body so its socket is released straight away. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // nothing to release
  }
}

export function resolveRpcUrls(
  network: "mainnet" | "testnet",
  explicit?: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  if (explicit !== undefined && explicit.length > 0) return [...explicit];
  const fromEnv = (envValue(env, "NEAR_RPC_URLS") ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (fromEnv.length > 0) return fromEnv;
  return [...NETWORKS[network].rpcUrls];
}

const DECIMAL_RE = /^\d+$/;

type Permission = AccessKeyInfo["permission"];
/** A permission, or what is wrong with it. */
type Parsed = { ok: true; permission: Permission } | { ok: false; problem: string };
const bad = (problem: string): Parsed => ({ ok: false, problem });

/** `{ allowance?, receiver_id, method_names }` of a FunctionCall or GasKeyFunctionCall permission. */
function scopedPermission(kind: string, body: Record<string, unknown>): Parsed {
  const { receiver_id: receiverId, method_names: methodNames, allowance } = body;
  if (typeof receiverId !== "string") return bad(`${kind}.receiver_id is not a string`);
  // An empty list means "all methods" on NEAR, so a missing or garbled list must never become [].
  if (!Array.isArray(methodNames) || !methodNames.every((m) => typeof m === "string")) {
    return bad(`${kind}.method_names is not a list of method names`);
  }
  if (allowance !== undefined && allowance !== null) {
    if (typeof allowance !== "string" || !DECIMAL_RE.test(allowance)) {
      return bad(`${kind}.allowance is not a decimal string or null`);
    }
  }
  return {
    ok: true,
    permission: {
      receiver_id: receiverId,
      method_names: [...methodNames],
      allowance: allowance ?? null,
    },
  };
}

/** The fields a gas key adds: `balance` (yoctoNEAR, a decimal string) and `num_nonces` (a count). */
function gasKeyProblem(kind: string, body: Record<string, unknown>): string | null {
  const { balance, num_nonces: numNonces } = body;
  if (typeof balance !== "string" || !DECIMAL_RE.test(balance)) {
    return `${kind}.balance is not a decimal string`;
  }
  if (typeof numNonces !== "number" || !Number.isSafeInteger(numNonces) || numNonces < 0) {
    return `${kind}.num_nonces is not a count`;
  }
  return null;
}

/**
 * `AccessKeyPermissionView` has exactly four variants (near-api-js 7.4), matched by exact name (Task 14 fix 1):
 * `FullAccess`, `FunctionCall`, `GasKeyFunctionCall` and `GasKeyFullAccess`. A gas key reads as its plain
 * counterpart, so check f trusts a gas key exactly as it would the plain key: a scoped gas key is never
 * FullAccess, and a gas full-access key is a full-access key. Any other shape, or a variant whose fields are not
 * what the type says, is a problem: the caller fails closed.
 */
function parsePermission(permission: unknown): Parsed {
  if (permission === "FullAccess") return { ok: true, permission: "FullAccess" };
  if (!isRecord(permission)) return bad("the permission is neither FullAccess nor an object");
  const keys = Object.keys(permission);
  const kind = keys[0];
  if (keys.length !== 1 || kind === undefined) {
    return bad("the permission is not exactly one variant");
  }
  const body = permission[kind];
  if (!isRecord(body)) return bad(`${kind} is not an object`);
  switch (kind) {
    case "FunctionCall":
      return scopedPermission(kind, body);
    case "GasKeyFunctionCall": {
      const problem = gasKeyProblem(kind, body);
      return problem === null ? scopedPermission(kind, body) : bad(problem);
    }
    case "GasKeyFullAccess": {
      const problem = gasKeyProblem(kind, body);
      return problem === null ? { ok: true, permission: "FullAccess" } : bad(problem);
    }
    default:
      return bad(`${kind} is not a permission variant this client knows`);
  }
}

/** One key of a `view_access_key_list` answer. An unknown or malformed permission throws (fail closed). */
export function toAccessKeyInfo(raw: unknown): AccessKeyInfo {
  if (!isRecord(raw) || typeof raw.public_key !== "string" || !isRecord(raw.access_key)) {
    throw new RpcMalformedError("malformed access key in view_access_key_list");
  }
  const parsed = parsePermission(raw.access_key.permission);
  if (!parsed.ok) {
    throw new RpcMalformedError(
      `malformed access key ${raw.public_key}: ${parsed.problem} (permission)`,
    );
  }
  return { public_key: raw.public_key, permission: parsed.permission };
}

/** nearcore's `result.error` (HTTP 200) for a `view_access_key` / `view_account` whose target is not there. */
const MISSING_KEY_RE = /^access key (.*?) does not exist while viewing$/;
const MISSING_ACCOUNT_RE = /^account (.*?) does not exist while viewing$/;

/** The `result.error` text of a legacy answer (HTTP 200, `{ error, logs?, block_height, block_hash }`), or null. */
function legacyErrorText(result: unknown): string | null {
  return isRecord(result) && typeof result.error === "string" ? result.error : null;
}

/**
 * A legacy "account … does not exist while viewing" answer as the structured `UNKNOWN_ACCOUNT` error that
 * newer nodes send, so callers test one shape (`rpcError.cause.name`). The raw answer rides along in `legacy`.
 */
function unknownAccountError(request: string, accountId: string, result: unknown): RpcError {
  return new RpcError(`${request} ${accountId}: account ${accountId} does not exist`, [], {
    name: "HANDLER_ERROR",
    cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: accountId } },
    legacy: result,
  });
}

/** True when `error` is the node's structured answer that the account or key is not there. */
function isMissingTarget(error: unknown, causes: readonly string[]): boolean {
  if (!(error instanceof RpcError) || !isRecord(error.rpcError)) return false;
  const cause = error.rpcError.cause;
  return isRecord(cause) && typeof cause.name === "string" && causes.includes(cause.name);
}

/** R6 (NEP-591): an account's code identity is its global contract hash when it has one, else its code hash. */
export function codeIdentity(
  account: Pick<ViewAccountResult, "code_hash" | "global_contract_hash">,
): string {
  return account.global_contract_hash ?? account.code_hash;
}

function malformedTx(detail: string): RpcMalformedError {
  return new RpcMalformedError(`malformed tx result: ${detail}`);
}

function toOutcome(raw: unknown, label: string): ExecutionOutcomeView {
  if (!isRecord(raw)) throw malformedTx(`${label} is not an object`);
  if (typeof raw.id !== "string") throw malformedTx(`${label}.id is not a string`);
  const inner = raw.outcome;
  if (!isRecord(inner)) throw malformedTx(`${label}.outcome is not an object`);
  if (typeof inner.executor_id !== "string") {
    throw malformedTx(`${label}.outcome.executor_id is not a string`);
  }
  return {
    id: raw.id,
    outcome: {
      logs: Array.isArray(inner.logs) ? inner.logs.map(String) : [],
      receipt_ids: Array.isArray(inner.receipt_ids) ? inner.receipt_ids.map(String) : [],
      executor_id: inner.executor_id,
      status: inner.status ?? null,
    },
  };
}

/** Map a `tx` RPC result. A garbled 200 throws; it must never look like a valid, empty result. */
export function toTxStatusResult(raw: unknown): TxStatusResult {
  if (!isRecord(raw)) throw malformedTx("not an object");
  if (raw.status === undefined || raw.status === null) throw malformedTx("status is missing");
  const tx = raw.transaction;
  if (!isRecord(tx)) throw malformedTx("transaction is not an object");
  if (typeof tx.hash !== "string") throw malformedTx("transaction.hash is not a string");
  if (!Array.isArray(raw.receipts_outcome)) throw malformedTx("receipts_outcome is not an array");
  return {
    status: raw.status,
    transaction: {
      hash: tx.hash,
      signer_id: String(tx.signer_id ?? ""),
      receiver_id: String(tx.receiver_id ?? ""),
    },
    transaction_outcome: toOutcome(raw.transaction_outcome, "transaction_outcome"),
    receipts_outcome: raw.receipts_outcome.map((item: unknown, i: number) =>
      toOutcome(item, `receipts_outcome[${i}]`),
    ),
  };
}

export class RpcClient {
  private readonly opts: RpcClientOptions;
  private readonly urls: readonly string[];
  private readonly maxRounds: number;
  private preferred = 0;
  private nextId = 0;

  constructor(opts: RpcClientOptions) {
    if (opts.urls.length === 0) throw new ConfigError("at least one NEAR RPC URL is required");
    const maxRounds = opts.maxRounds ?? 3;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS_LIMIT) {
      throw new ConfigError(`maxRounds must be an integer from 1 to ${MAX_ROUNDS_LIMIT}`);
    }
    this.opts = opts;
    this.urls = [...opts.urls];
    this.maxRounds = maxRounds;
  }

  get currentUrl(): string {
    return this.urls[this.preferred] ?? this.urls[0] ?? "";
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep !== undefined) return this.opts.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private delay(attempt: number, retryAfterMs: number | null): number {
    const max = this.opts.maxDelayMs ?? 4000;
    if (retryAfterMs !== null) return Math.min(max, retryAfterMs);
    return Math.min(max, (this.opts.baseDelayMs ?? 250) * 2 ** attempt);
  }

  private async attempt(
    url: string,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<Attempt> {
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    const id = `probarion-${this.nextId}`;
    this.nextId += 1;
    const shown = redactUrl(url);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        kind: "retry",
        message: describeNetworkError(error, timeoutMs),
        retryAfterMs: null,
        cause: error,
      };
    }
    // This endpoint is struggling (408/429/5xx) or refuses us (401/403/404, for example a revoked
    // API key or a wrong path): another endpoint may still answer, so fail over.
    const { status } = response;
    if (
      status === 408 ||
      status === 429 ||
      status >= 500 ||
      status === 401 ||
      status === 403 ||
      status === 404
    ) {
      await discardBody(response);
      return {
        kind: "retry",
        message: `HTTP ${status}`,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      // Any other HTTP failure (for example 400) would repeat on every endpoint. It is a transport
      // error, not a JSON-RPC answer, so `error` stays null and no ViewError is made from it.
      return { kind: "fatal", message: `HTTP ${status}: ${text.slice(0, 200)}`, error: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "retry", message: `non-JSON response from ${shown}`, retryAfterMs: null };
    }
    if (!isRecord(parsed)) {
      return { kind: "retry", message: `unexpected response from ${shown}`, retryAfterMs: null };
    }
    if (parsed.error !== undefined && parsed.error !== null) {
      const message = describeRpcError(parsed.error);
      if (!isTransientRpcError(parsed.error, method)) {
        return { kind: "fatal", message, error: parsed.error };
      }
      return isReadTransientAnswer(parsed.error)
        ? { kind: "retry", message, retryAfterMs: null, rpcError: parsed.error }
        : { kind: "retry", message, retryAfterMs: null };
    }
    if (!("result" in parsed)) {
      return {
        kind: "retry",
        message: `response without result from ${shown}`,
        retryAfterMs: null,
      };
    }
    return { kind: "ok", result: parsed.result };
  }

  /**
   * Send one JSON-RPC request, failing over across the configured endpoints with backoff.
   *
   * Safe only for read-only queries or pre-signed payloads: every retry and every failover resends
   * identical params, so a request that is not idempotent (or whose first try did reach the node)
   * could take effect twice. A JSON-RPC error that is not a timeout is final and thrown at once
   * with the raw error in `rpcError`; transport failures end in an `RpcError` with `rpcError`
   * `null`, the attempt log and the last underlying error as `cause`. A read that failed over on a node's
   * INTERNAL_ERROR, UNAVAILABLE_SHARD or NOT_SYNCED_YET keeps the last such error in `rpcError` (a node
   * answered: it is not an outage). An answer this client cannot read is an `RpcMalformedError`.
   */
  async call<T>(method: string, params: unknown): Promise<T> {
    const attempts: RpcAttempt[] = [];
    let lastCause: unknown;
    // A read that failed over on INTERNAL_ERROR, UNAVAILABLE_SHARD or NOT_SYNCED_YET ends with that node error:
    // a node did answer, so it is never reported as an outage (rpcError stays null only for transport failures).
    let nodeError: unknown = null;
    const total = this.maxRounds * this.urls.length;
    for (let n = 0; n < total; n++) {
      const index = (this.preferred + n) % this.urls.length;
      const url = this.urls[index];
      if (url === undefined) continue;
      // The time the caller has left, if it said (read before every try): no try starts without any.
      const left = this.opts.remainingMs?.();
      if (left !== undefined && !(left > 0)) {
        throw new RpcError(
          `${method}: the time left for this job ran out after ${attempts.length} attempt(s)`,
          attempts,
          nodeError,
          lastCause === undefined ? undefined : { cause: lastCause },
        );
      }
      const base = this.opts.timeoutMs ?? 15_000;
      const outcome = await this.attempt(
        url,
        method,
        params,
        left === undefined ? base : Math.max(1, Math.min(base, Math.ceil(left))),
      );
      if (outcome.kind === "ok") {
        this.preferred = index;
        return outcome.result as T;
      }
      if (outcome.kind === "fatal") {
        throw new RpcError(`${method}: ${outcome.message}`, attempts, outcome.error);
      }
      attempts.push({ url: redactUrl(url), error: outcome.message });
      if (outcome.rpcError !== undefined) nodeError = outcome.rpcError;
      lastCause = outcome.cause ?? new Error(outcome.message);
      if (n < total - 1) {
        const wait = this.delay(n, outcome.retryAfterMs);
        const after = this.opts.remainingMs?.();
        await this.sleep(after === undefined ? wait : Math.max(0, Math.min(wait, after)));
      }
    }
    const tried = [...new Set(this.urls.map(redactUrl))].join(", ");
    const last = attempts.at(-1)?.error ?? "no attempt made";
    throw new RpcError(
      `${method}: all ${this.urls.length} RPC endpoint(s) failed after ${attempts.length} attempts (tried ${tried}); last error: ${last}`,
      attempts,
      nodeError,
      { cause: lastCause },
    );
  }

  async viewFunction<T>(
    contractId: string,
    methodName: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    let result: unknown;
    try {
      result = await this.call<unknown>("query", {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      });
    } catch (error) {
      // Only a JSON-RPC error answer (a contract panic, an unknown method) is a ViewError. It keeps
      // the attempt log and the raw error; transport failures stay plain RpcErrors.
      if (error instanceof RpcError && error.rpcError !== null) {
        throw new ViewError(contractId, methodName, describeRpcError(error.rpcError), {
          attempts: error.attempts,
          rpcError: error.rpcError,
          cause: error,
        });
      }
      throw error;
    }
    if (!isRecord(result)) throw new ViewError(contractId, methodName, "malformed query result");
    if (typeof result.error === "string") throw new ViewError(contractId, methodName, result.error);
    const bytes = result.result;
    if (!Array.isArray(bytes)) {
      throw new ViewError(contractId, methodName, "query result has no bytes");
    }
    if (!bytes.every((b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new ViewError(contractId, methodName, "query result is not a byte array");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes as number[]));
    } catch {
      throw new ViewError(contractId, methodName, "query result is not valid UTF-8");
    }
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new ViewError(contractId, methodName, `result is not JSON: ${text.slice(0, 100)}`);
    }
    return parsed as T;
  }

  async viewAccessKeyList(accountId: string): Promise<AccessKeyInfo[]> {
    const result = await this.call<unknown>("query", {
      request_type: "view_access_key_list",
      finality: "final",
      account_id: accountId,
    });
    if (MISSING_ACCOUNT_RE.test(legacyErrorText(result) ?? "")) {
      throw unknownAccountError("view_access_key_list", accountId, result);
    }
    if (!isRecord(result) || !Array.isArray(result.keys)) {
      throw new RpcMalformedError(`view_access_key_list ${accountId}: malformed result`);
    }
    return result.keys.map((key: unknown) => toAccessKeyInfo(key));
  }

  /**
   * One access key, or null when the node says the key (or its account) is not there, in either answer form:
   * the structured `UNKNOWN_ACCESS_KEY` / `UNKNOWN_ACCOUNT` error, or HTTP 200 with `result.error` "access key …
   * does not exist while viewing", which is how nodes answer a missing key (Task 14 fix 3). Any other
   * `result.error` is a `ViewError`, and an unknown permission throws: neither ever reads as a missing key.
   */
  async viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null> {
    let result: unknown;
    try {
      result = await this.call<unknown>("query", {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });
    } catch (error) {
      if (isMissingTarget(error, ["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"])) return null;
      throw error;
    }
    const text = legacyErrorText(result);
    if (text !== null) {
      if (MISSING_KEY_RE.test(text) || MISSING_ACCOUNT_RE.test(text)) return null;
      throw new ViewError(accountId, "view_access_key", text, { rpcError: result });
    }
    const parsed = isRecord(result)
      ? parsePermission(result.permission)
      : bad("the answer is not an object");
    if (!parsed.ok) {
      throw new RpcMalformedError(`view_access_key ${accountId}: ${parsed.problem} (permission)`);
    }
    return { public_key: publicKey, permission: parsed.permission };
  }

  async viewAccount(accountId: string): Promise<ViewAccountResult> {
    const result = await this.call<unknown>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    if (MISSING_ACCOUNT_RE.test(legacyErrorText(result) ?? "")) {
      throw unknownAccountError("view_account", accountId, result);
    }
    if (!isRecord(result) || typeof result.code_hash !== "string") {
      throw new RpcMalformedError(`view_account ${accountId}: malformed result`);
    }
    const { amount, locked, storage_usage: storage } = result;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
      throw new RpcMalformedError(`view_account ${accountId}: malformed amount`);
    }
    if (typeof locked !== "string" || !/^\d+$/.test(locked)) {
      throw new RpcMalformedError(`view_account ${accountId}: malformed locked`);
    }
    if (typeof storage !== "number" || !Number.isSafeInteger(storage) || storage < 0) {
      throw new RpcMalformedError(`view_account ${accountId}: malformed storage_usage`);
    }
    // R6 (NEP-591): RPC omits global_contract_hash for an account that deploys its own code.
    const globalHash = result.global_contract_hash;
    if (
      globalHash !== undefined &&
      globalHash !== null &&
      (typeof globalHash !== "string" || globalHash.length === 0)
    ) {
      throw new RpcMalformedError(`view_account ${accountId}: malformed global_contract_hash`);
    }
    return {
      amount,
      locked,
      code_hash: result.code_hash,
      global_contract_hash: globalHash ?? null,
      storage_usage: storage,
    };
  }

  async txStatus(txHash: string, senderAccountId: string): Promise<TxStatusResult> {
    return toTxStatusResult(
      await this.call<unknown>("tx", {
        tx_hash: txHash,
        sender_account_id: senderAccountId,
        wait_until: "FINAL",
      }),
    );
  }
}
