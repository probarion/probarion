import { type AccessKeyInfo, NETWORKS } from "@probarion/core";
import { envValue } from "./env.js";
import { ConfigError, type RpcAttempt, RpcError, ViewError } from "./errors.js";

export interface RpcClientOptions {
  urls: readonly string[];
  fetch?: typeof fetch;
  maxRounds?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
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
  | { kind: "retry"; message: string; retryAfterMs: number | null }
  | { kind: "fatal"; message: string; error: unknown };

const EMPTY: Record<string, unknown> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function isTransientRpcError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const cause = isRecord(error.cause) ? error.cause : EMPTY;
  return (
    error.name === "TIMEOUT_ERROR" ||
    cause.name === "TIMEOUT_ERROR" ||
    cause.name === "NO_SYNCED_BLOCKS"
  );
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
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

export function toAccessKeyInfo(raw: unknown): AccessKeyInfo {
  if (!isRecord(raw) || typeof raw.public_key !== "string" || !isRecord(raw.access_key)) {
    throw new RpcError("malformed access key in view_access_key_list");
  }
  const permission = raw.access_key.permission;
  if (isRecord(permission) && isRecord(permission.FunctionCall)) {
    const fc = permission.FunctionCall;
    return {
      public_key: raw.public_key,
      permission: {
        receiver_id: String(fc.receiver_id),
        method_names: Array.isArray(fc.method_names) ? fc.method_names.map(String) : [],
        allowance:
          fc.allowance === null || fc.allowance === undefined ? null : String(fc.allowance),
      },
    };
  }
  // "FullAccess", and any permission kind this client does not know, count as full access (fail-safe for check f).
  return { public_key: raw.public_key, permission: "FullAccess" };
}

function toOutcome(raw: unknown): ExecutionOutcomeView {
  const rec = isRecord(raw) ? raw : EMPTY;
  const inner = isRecord(rec.outcome) ? rec.outcome : EMPTY;
  return {
    id: String(rec.id ?? ""),
    outcome: {
      logs: Array.isArray(inner.logs) ? inner.logs.map(String) : [],
      receipt_ids: Array.isArray(inner.receipt_ids) ? inner.receipt_ids.map(String) : [],
      executor_id: String(inner.executor_id ?? ""),
      status: inner.status ?? null,
    },
  };
}

export function toTxStatusResult(raw: unknown): TxStatusResult {
  if (!isRecord(raw)) throw new RpcError("malformed transaction status");
  const tx = isRecord(raw.transaction) ? raw.transaction : EMPTY;
  return {
    status: raw.status ?? null,
    transaction: {
      hash: String(tx.hash ?? ""),
      signer_id: String(tx.signer_id ?? ""),
      receiver_id: String(tx.receiver_id ?? ""),
    },
    transaction_outcome: toOutcome(raw.transaction_outcome),
    receipts_outcome: Array.isArray(raw.receipts_outcome)
      ? raw.receipts_outcome.map(toOutcome)
      : [],
  };
}

export class RpcClient {
  private readonly opts: RpcClientOptions;
  private readonly urls: readonly string[];
  private preferred = 0;
  private nextId = 0;

  constructor(opts: RpcClientOptions) {
    if (opts.urls.length === 0) throw new ConfigError("at least one NEAR RPC URL is required");
    this.opts = opts;
    this.urls = [...opts.urls];
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

  private async attempt(url: string, method: string, params: unknown): Promise<Attempt> {
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    const id = `probarion-${this.nextId}`;
    this.nextId += 1;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (error) {
      return {
        kind: "retry",
        message: `network error: ${error instanceof Error ? error.message : String(error)}`,
        retryAfterMs: null,
      };
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return {
        kind: "retry",
        message: `HTTP ${response.status}`,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        kind: "fatal",
        message: `HTTP ${response.status}: ${text.slice(0, 200)}`,
        error: text,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "retry", message: `non-JSON response from ${url}`, retryAfterMs: null };
    }
    if (!isRecord(parsed)) {
      return { kind: "retry", message: `unexpected response from ${url}`, retryAfterMs: null };
    }
    if (parsed.error !== undefined && parsed.error !== null) {
      const message = describeRpcError(parsed.error);
      return isTransientRpcError(parsed.error)
        ? { kind: "retry", message, retryAfterMs: null }
        : { kind: "fatal", message, error: parsed.error };
    }
    if (!("result" in parsed)) {
      return { kind: "retry", message: `response without result from ${url}`, retryAfterMs: null };
    }
    return { kind: "ok", result: parsed.result };
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const attempts: RpcAttempt[] = [];
    const total = (this.opts.maxRounds ?? 3) * this.urls.length;
    for (let n = 0; n < total; n++) {
      const index = (this.preferred + n) % this.urls.length;
      const url = this.urls[index];
      if (url === undefined) continue;
      const outcome = await this.attempt(url, method, params);
      if (outcome.kind === "ok") {
        this.preferred = index;
        return outcome.result as T;
      }
      if (outcome.kind === "fatal") {
        throw new RpcError(`${method}: ${outcome.message}`, attempts, outcome.error);
      }
      attempts.push({ url, error: outcome.message });
      if (n < total - 1) await this.sleep(this.delay(n, outcome.retryAfterMs));
    }
    throw new RpcError(
      `${method}: all ${this.urls.length} RPC endpoint(s) failed after ${attempts.length} attempts`,
      attempts,
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
      if (error instanceof RpcError && error.rpcError !== null) {
        throw new ViewError(contractId, methodName, describeRpcError(error.rpcError));
      }
      throw error;
    }
    if (!isRecord(result)) throw new ViewError(contractId, methodName, "malformed query result");
    if (typeof result.error === "string") throw new ViewError(contractId, methodName, result.error);
    const bytes = result.result;
    if (!Array.isArray(bytes))
      throw new ViewError(contractId, methodName, "query result has no bytes");
    const text = Buffer.from(bytes.map(Number)).toString("utf8");
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
    if (!isRecord(result) || !Array.isArray(result.keys)) {
      throw new RpcError(`view_access_key_list ${accountId}: malformed result`);
    }
    return result.keys.map((key: unknown) => toAccessKeyInfo(key));
  }

  async viewAccount(accountId: string): Promise<ViewAccountResult> {
    const result = await this.call<unknown>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    if (!isRecord(result) || typeof result.code_hash !== "string") {
      throw new RpcError(`view_account ${accountId}: malformed result`);
    }
    // R6 (NEP-591): RPC omits global_contract_hash for an account that deploys its own code.
    const globalHash = result.global_contract_hash;
    if (globalHash !== undefined && globalHash !== null && typeof globalHash !== "string") {
      throw new RpcError(`view_account ${accountId}: malformed global_contract_hash`);
    }
    return {
      amount: String(result.amount),
      locked: String(result.locked),
      code_hash: result.code_hash,
      global_contract_hash: globalHash ?? null,
      storage_usage: Number(result.storage_usage),
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
