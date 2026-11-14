// The NEAR JSON-RPC client and the output helpers that `account audit` (commands/account.ts) and `tx prove`
// (commands/tx.ts) share. Both run the NEAR builder primitives of @probarion/near, read over JSON-RPC and sign nothing.
import { type NearRpc, NearRpcError } from "@probarion/near";
import { RpcClient } from "@probarion/sdk";
import { UsageError } from "./errors.js";
import type { CliIo } from "./io.js";
import { NEAR_ACCOUNT_RE } from "./payee.js";

/** Bounds the node's `result.error` text kept in a message; the whole answer stays in `rpcError`. */
const MAX_DETAIL = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The SDK's RpcClient (failover across `urls`, retries) as a NearRpc. RpcClient hands a legacy `query` failure
 * (HTTP 200 with a `result.error` text, which older nodes send for a missing account) back as a result; here it
 * throws a NearRpcError, as `httpJsonRpc` does, so such an answer does not pass for a view.
 */
export function nearRpc(urls: readonly string[], io: CliIo): NearRpc {
  const fetchImpl = io.nearDeps?.fetch;
  const client = new RpcClient({ urls, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
  return {
    async call<T = unknown>(method: string, params: unknown): Promise<T> {
      const result = await client.call<unknown>(method, params);
      if (isRecord(result) && typeof result.error === "string") {
        const text =
          result.error.length > MAX_DETAIL
            ? `${result.error.slice(0, MAX_DETAIL)}...`
            : result.error;
        throw new NearRpcError(method, result, `${method}: ${text}`);
      }
      return result as T;
    },
  };
}

/** JSON with every bigint as its decimal string and every byte array as base64 (a success value). */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
      return v;
    },
    2,
  );
}

export function checkedAccount(value: string, what: string): string {
  if (!NEAR_ACCOUNT_RE.test(value))
    throw new UsageError(`${what} ${value} is not a valid NEAR account id`);
  return value;
}
