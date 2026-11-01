import type {
  AccessKeyInfo,
  AgentView,
  AnchorView,
  FactoryConfig,
  MandateView,
  SpendView,
  VaultConfig,
} from "@probarion/core";
import {
  FactoryClient,
  IntentsClient,
  type RpcClient,
  RpcError,
  toAccessKeyInfo,
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

export interface AccessKeyState {
  exists: boolean;
  fullAccess: boolean;
  allowance: string | null; // yoctoNEAR; null = unlimited
  receiverId: string | null;
  methodNames: string[];
}

export interface VaultReader {
  getConfig(vault: string): Promise<VaultConfig>;
  listMandates(vault: string, from: number, limit: number): Promise<MandateView[]>;
  listSpends(vault: string, from: number, limit: number): Promise<SpendView[]>;
  listAnchors(vault: string, from: number, limit: number): Promise<AnchorView[]>;
  listAgents(vault: string): Promise<AgentView[]>;
  /** NEP-141 `ft_balance_of`, as a canonical decimal string of base units. */
  ftBalance(token: string, account: string): Promise<string>;
  /** `mt_balance_of(account, "nep141:<tokenAccount>")` on the Intents contract, as a decimal string. */
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
 *  - `rpc`: a node answered with an error or a result that is not about the target (an internal
 *    error, an unreadable result). It says nothing about the vault, so it must never read as "not found".
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

/** What older nodes put in `result.error` (HTTP 200, no JSON-RPC error) for a view that failed in the contract. */
const LEGACY_CONTRACT_ERROR =
  /wasm execution failed|Smart contract panicked|PROBARION:|has not been deployed|does not exist while viewing|MethodNotFound|CompilationError/;

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

/** `kind` for an SDK `RpcError` (a `ViewError` is one), or null for anything else (a bad argument, a bug). */
export function chainErrorKind(error: unknown): ChainErrorKind | null {
  if (!(error instanceof RpcError)) return null;
  if (error.rpcError !== null) {
    const cause = rpcCauseName(error.rpcError);
    return cause !== null && CONTRACT_CAUSES.has(cause) ? "contract" : "rpc";
  }
  if (error instanceof ViewError) {
    // No JSON-RPC error: either the contract's panic text came back in `result.error`, or the
    // result was unusable (not bytes, not JSON, not a list).
    return error.probarionCode !== null || LEGACY_CONTRACT_ERROR.test(error.message)
      ? "contract"
      : "rpc";
  }
  return "transport";
}

export const isContractError = (error: unknown): boolean => chainErrorKind(error) === "contract";

const hasCause = (error: unknown, causes: readonly string[]): boolean =>
  error instanceof RpcError &&
  error.rpcError !== null &&
  causes.includes(rpcCauseName(error.rpcError) ?? "");

// ---- reads -------------------------------------------------------------------------------------

const NO_KEY: AccessKeyState = {
  exists: false,
  fullAccess: false,
  allowance: null,
  receiverId: null,
  methodNames: [],
};

/**
 * `toAccessKeyInfo` (SDK) reads a permission fail-safe: FullAccess, and any kind it does not know
 * (a gas key, for example), count as full access, so the console never understates what a key can do.
 */
function toAccessKeyState(info: AccessKeyInfo): AccessKeyState {
  if (info.permission === "FullAccess") {
    return { exists: true, fullAccess: true, allowance: null, receiverId: null, methodNames: [] };
  }
  const { allowance, receiver_id: receiverId, method_names: methodNames } = info.permission;
  return { exists: true, fullAccess: false, allowance, receiverId, methodNames: [...methodNames] };
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
      return (await new IntentsClient(intents, rpc).poaBalance(account, tokenAccount)).toString();
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
        if (hasCause(error, ["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"])) return { ...NO_KEY };
        throw error;
      }
      const permission = isRecord(result) ? result.permission : undefined;
      if (typeof permission !== "string" && !isRecord(permission)) {
        // Without this, toAccessKeyInfo would read a missing permission as FullAccess.
        throw new RpcError(`view_access_key ${account}: malformed result`);
      }
      return toAccessKeyState(
        toAccessKeyInfo({ public_key: publicKey, access_key: { permission } }),
      );
    },
    factoryConfig: (factory) => new FactoryClient(factory, rpc).getConfig(),
    async accountExists(account) {
      try {
        await rpc.viewAccount(account);
        return true;
      } catch (error) {
        if (hasCause(error, ["UNKNOWN_ACCOUNT"])) return false;
        throw error;
      }
    },
  };
}
