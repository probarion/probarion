import type {
  AgentView,
  AnchorView,
  FactoryConfig,
  MandateView,
  SpendView,
  VaultConfig,
} from "@probarion/core";
import {
  FactoryClient,
  type RpcClient,
  RpcError,
  RpcMalformedError,
  VaultClient,
  ViewError,
} from "@probarion/sdk";

// The console's chain reads, as thin adapters over @probarion/sdk (R9). RPC failover, retry/backoff,
// URL redaction and strict response parsing all live in the SDK's `RpcClient`; this file only gives
// the console a small, easy-to-fake interface and a three-way error classification.

/** Paging for a `list_*(from_index, limit)` view: re-exported from the SDK, which throws instead of truncating. */
export { pageAll as listAll } from "@probarion/sdk";

/** The factory's `get_config` view (interfaces v2 §5). The SDK's `FactoryClient.getConfig` returns this shape. */
export type FactoryConfigView = FactoryConfig;

/** The four permission variants of a NEAR access key (`AccessKeyPermissionView`). */
export type AccessKeyKind =
  | "FullAccess"
  | "FunctionCall"
  | "GasKeyFullAccess"
  | "GasKeyFunctionCall";

export interface AccessKeyState {
  exists: boolean;
  /**
   * The permission variant the node reported, or null when the key does not exist. A vault's agent
   * and ledger keys must be a plain `FunctionCall`: a caller that needs a scoped key checks
   * `kind === "FunctionCall"`, not just `!fullAccess`.
   */
  kind: AccessKeyKind | null;
  /** True for `FullAccess` and `GasKeyFullAccess`. Never true for a shape the reader could not read. */
  fullAccess: boolean;
  allowance: string | null; // yoctoNEAR; null = unlimited
  receiverId: string | null;
  methodNames: string[];
}

export interface VaultReader {
  getConfig(vault: string): Promise<VaultConfig>;
  /** `get_mandate`: null when the vault has no mandate with this id. */
  getMandate(vault: string, mandateId: number): Promise<MandateView | null>;
  /** `get_spend`: null when the vault has no spend with this id. */
  getSpend(vault: string, spendId: number): Promise<SpendView | null>;
  listMandates(vault: string, from: number, limit: number): Promise<MandateView[]>;
  listSpends(vault: string, from: number, limit: number): Promise<SpendView[]>;
  listAnchors(vault: string, from: number, limit: number): Promise<AnchorView[]>;
  listAgents(vault: string): Promise<AgentView[]>;
  /** NEP-141 `ft_balance_of`, as a canonical decimal string of base units. Throws on any other answer. */
  ftBalance(token: string, account: string): Promise<string>;
  /**
   * `mt_balance_of(account, "nep141:<tokenAccount>")` on the Intents contract, as a canonical decimal
   * string. Throws on any other answer, `null` included: a zero must be the contract's own "0".
   */
  intentsBalance(intents: string, account: string, tokenAccount: string): Promise<string>;
  accessKey(account: string, publicKey: string): Promise<AccessKeyState>;
  factoryConfig(factory: string): Promise<FactoryConfigView>;
  accountExists(account: string): Promise<boolean>;
}

// ---- error classification ----------------------------------------------------------------------

/**
 * How a failed read is told to the user:
 *  - `transport`: no provider answered (network, HTTP status, every endpoint failed). Retrying later may work.
 *  - `contract`: the chain answered, definitively, about the target: the account, key or contract
 *    is not there, has no code, lacks the method, or the view panicked. Another provider says the same.
 *  - `rpc`: a node answered, but with an error that is not about the target (an internal error, an
 *    overloaded node) or with an answer the reader could not read (a malformed or unknown shape).
 *    It says nothing about the vault, so it must never read as "not found".
 */
export type ChainErrorKind = "transport" | "rpc" | "contract";

/** JSON-RPC error causes that describe the queried account, key or contract (nearcore `query` errors). */
const CONTRACT_CAUSES: ReadonlySet<string> = new Set([
  "UNKNOWN_ACCOUNT",
  "UNKNOWN_ACCESS_KEY",
  "NO_CONTRACT_CODE",
  "CONTRACT_EXECUTION_ERROR",
  "INVALID_ACCOUNT",
]);

/** What nodes put in `result.error` (HTTP 200, no JSON-RPC error) for a view that failed in the contract. */
const LEGACY_CONTRACT_ERROR =
  /wasm execution failed|Smart contract panicked|PROBARION:|has not been deployed|does not exist while viewing|MethodNotFound|CompilationError/;

/** nearcore's `result.error` for a view_access_key / view_account whose target is not there. */
const MISSING_KEY = /^access key (.*?) does not exist while viewing$/;
const MISSING_ACCOUNT = /^account (.*?) does not exist while viewing$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The specific cause of a raw JSON-RPC error object (`cause.name`, else `name`), or null. */
export function rpcCauseName(rpcError: unknown): string | null {
  if (!isRecord(rpcError)) return null;
  const cause = rpcError.cause;
  if (isRecord(cause) && typeof cause.name === "string") return cause.name;
  return typeof rpcError.name === "string" ? rpcError.name : null;
}

/** The `result.error` text of a legacy answer (HTTP 200 with `{ error: "...", logs, ... }`), or null. */
function legacyResultText(raw: unknown): string | null {
  return isRecord(raw) && typeof raw.error === "string" ? raw.error : null;
}

/**
 * An answer the SDK could not read: the SDK marks every such answer with `RpcMalformedError` (a node did
 * answer, so it is never an outage). A failover that gave up is a plain `RpcError`; when its last answers were
 * node errors (INTERNAL_ERROR, UNAVAILABLE_SHARD, NOT_SYNCED_YET) it carries one in `rpcError` and is "rpc".
 */
function isUnreadableAnswer(error: RpcError): boolean {
  return error instanceof RpcMalformedError;
}

/** `kind` for an SDK `RpcError` (a `ViewError` is one), or null for anything else (a bad argument, a bug). */
export function chainErrorKind(error: unknown): ChainErrorKind | null {
  if (!(error instanceof RpcError)) return null;
  if (error.rpcError !== null) {
    const cause = rpcCauseName(error.rpcError);
    if (cause !== null) return CONTRACT_CAUSES.has(cause) ? "contract" : "rpc";
    // No cause: the raw answer is a legacy `{ error: "..." }` result. The same direction as for a
    // view: it is a definite answer about the target only when its text is a recognised target
    // phrase. Anything else (an empty text, a gateway's "Unauthorized: invalid API key") says
    // nothing about the target and stays "rpc".
    const text = legacyResultText(error.rpcError);
    return text !== null && LEGACY_CONTRACT_ERROR.test(text) ? "contract" : "rpc";
  }
  if (error instanceof ViewError) {
    // No JSON-RPC error: either the contract's panic text came back in `result.error`, or the
    // result was unusable (not bytes, not JSON, not a list, not a decimal).
    return error.probarionCode !== null || LEGACY_CONTRACT_ERROR.test(error.message)
      ? "contract"
      : "rpc";
  }
  return isUnreadableAnswer(error) ? "rpc" : "transport";
}

export const isContractError = (error: unknown): boolean => chainErrorKind(error) === "contract";

const hasCause = (error: unknown, causes: readonly string[]): boolean =>
  error instanceof RpcError &&
  error.rpcError !== null &&
  causes.includes(rpcCauseName(error.rpcError) ?? "");

// ---- reads -------------------------------------------------------------------------------------

const noKey = (): AccessKeyState => ({
  exists: false,
  kind: null,
  fullAccess: false,
  allowance: null,
  receiverId: null,
  methodNames: [],
});

const fullAccess = (kind: "FullAccess" | "GasKeyFullAccess"): AccessKeyState => ({
  exists: true,
  kind,
  fullAccess: true,
  allowance: null,
  receiverId: null,
  methodNames: [],
});

/** `{ allowance?, method_names, receiver_id, ... }` of a FunctionCall or GasKeyFunctionCall permission. */
function scopedKey(
  kind: "FunctionCall" | "GasKeyFunctionCall",
  body: Record<string, unknown>,
): AccessKeyState | null {
  const { receiver_id: receiverId, method_names: methodNames, allowance } = body;
  if (typeof receiverId !== "string" || receiverId === "") return null;
  if (!Array.isArray(methodNames) || !methodNames.every((m) => typeof m === "string")) return null;
  // null or absent = unlimited; otherwise yoctoNEAR as a decimal string.
  if (allowance !== undefined && allowance !== null) {
    if (typeof allowance !== "string" || !/^\d+$/.test(allowance)) return null;
  }
  return {
    exists: true,
    kind,
    fullAccess: false,
    allowance: allowance ?? null,
    receiverId,
    methodNames: [...(methodNames as string[])],
  };
}

/** The fields a gas key adds: `balance` (yoctoNEAR, decimal string) and `num_nonces` (a count). */
function hasGasKeyFields(body: Record<string, unknown>): boolean {
  const { balance, num_nonces: numNonces } = body;
  return (
    typeof balance === "string" &&
    /^\d+$/.test(balance) &&
    typeof numNonces === "number" &&
    Number.isSafeInteger(numNonces) &&
    numNonces >= 0
  );
}

/**
 * Reads `AccessKeyPermissionView`, which has exactly four variants (near-api-js 7.4), matched by
 * exact, case-sensitive name. Every field of every variant is checked against the type; anything
 * else, and any variant whose fields are not what the type says, is null: the caller fails closed,
 * so an unknown shape is never reported as full access (or as scoped).
 */
function parsePermission(permission: unknown): AccessKeyState | null {
  if (permission === "FullAccess") return fullAccess("FullAccess");
  if (!isRecord(permission)) return null;
  const keys = Object.keys(permission);
  const kind = keys[0];
  if (keys.length !== 1 || kind === undefined) return null;
  const body = permission[kind];
  if (!isRecord(body)) return null;
  switch (kind) {
    case "GasKeyFullAccess":
      return hasGasKeyFields(body) ? fullAccess("GasKeyFullAccess") : null;
    case "FunctionCall":
      return scopedKey(kind, body);
    case "GasKeyFunctionCall":
      return hasGasKeyFields(body) ? scopedKey(kind, body) : null;
    default:
      return null;
  }
}

/** A balance view must answer a decimal string; anything else is an error, never a silent zero. */
function toDecimal(contractId: string, method: string, value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ViewError(contractId, method, "the answer is not a decimal balance");
  }
  return BigInt(value).toString();
}

export function createVaultReader(rpc: RpcClient): VaultReader {
  const vaultAt = (vault: string) => new VaultClient(vault, rpc);
  return {
    getConfig: (vault) => vaultAt(vault).getConfig(),
    getMandate: (vault, mandateId) => vaultAt(vault).getMandate(mandateId),
    getSpend: (vault, spendId) => vaultAt(vault).getSpend(spendId),
    listMandates: (vault, from, limit) => vaultAt(vault).listMandates(from, limit),
    listSpends: (vault, from, limit) => vaultAt(vault).listSpends(from, limit),
    listAnchors: (vault, from, limit) => vaultAt(vault).listAnchors(from, limit),
    listAgents: (vault) => vaultAt(vault).listAgents(),
    async ftBalance(token, account) {
      const balance = await rpc.viewFunction<unknown>(token, "ft_balance_of", {
        account_id: account,
      });
      return toDecimal(token, "ft_balance_of", balance);
    },
    async intentsBalance(intents, account, tokenAccount) {
      const balance = await rpc.viewFunction<unknown>(intents, "mt_balance_of", {
        account_id: account,
        token_id: `nep141:${tokenAccount}`,
      });
      return toDecimal(intents, "mt_balance_of", balance);
    },
    async accessKey(account, publicKey) {
      let result: unknown;
      try {
        result = await rpc.call<unknown>("query", {
          request_type: "view_access_key",
          finality: "final",
          account_id: account,
          public_key: publicKey,
        });
      } catch (error) {
        // A missing key, or an account that is not there, means the key does not exist.
        if (hasCause(error, ["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"])) return noKey();
        throw error;
      }
      // Nodes answer a missing key with HTTP 200 and `result.error`, not a JSON-RPC error.
      const text = legacyResultText(result);
      if (text !== null) {
        if (MISSING_KEY.test(text) || MISSING_ACCOUNT.test(text)) return noKey();
        // The raw answer rides along so chainErrorKind can tell a target error from a node problem.
        throw new ViewError(account, "view_access_key", text, { rpcError: result });
      }
      const state = isRecord(result) ? parsePermission(result.permission) : null;
      if (state === null) {
        throw new ViewError(account, "view_access_key", "malformed or unknown permission");
      }
      return state;
    },
    factoryConfig: (factory) => new FactoryClient(factory, rpc).getConfig(),
    async accountExists(account) {
      try {
        await rpc.viewAccount(account);
        return true;
      } catch (error) {
        // The SDK reads both answers for a missing account (the structured UNKNOWN_ACCOUNT error and the
        // legacy HTTP 200 "account … does not exist while viewing", Task 14) as UNKNOWN_ACCOUNT. Any other
        // failure is an error, never "the account is not there".
        if (hasCause(error, ["UNKNOWN_ACCOUNT"])) return false;
        throw error;
      }
    },
  };
}
