// The JSON-RPC seam (S0, integrator-owned). Every online helper of this package takes a NearRpc, so a caller
// picks the transport: the SDK's RpcClient (failover, retries), a near-api-js provider, or httpJsonRpc below.
import { isRecord } from "./encoding.js";
import { NearFormatError } from "./errors.js";

/**
 * Any JSON-RPC client. @probarion/sdk's RpcClient fits as is; near-api-js:
 * `{ call: (method, params) => provider.sendJsonRpc(method, params) }`. `call` resolves to the answer's `result`
 * and rejects on a JSON-RPC error.
 */
export interface NearRpc {
  call<T = unknown>(method: string, params: unknown): Promise<T>;
}

/**
 * A request that did not come back with a result: the node answered with a JSON-RPC `error` (in `rpcError`, the
 * raw error object), with a legacy HTTP 200 `result.error` string (in `rpcError`, the whole `result`, which keeps
 * `block_height` and `block_hash`), with an HTTP status other than 2xx (`rpcError` is the body's JSON-RPC error
 * when it has one, else null), or not at all (a network failure or a timeout: `rpcError` is null and `cause` holds
 * the underlying error). Messages name the endpoint by its origin only.
 */
export class NearRpcError extends Error {
  override readonly name = "NearRpcError";
  constructor(
    readonly method: string,
    readonly rpcError: unknown,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Bounds the node's error text kept in a message; the full error stays in `rpcError`. */
const MAX_DETAIL = 300;

/** `name: cause.name: message: data` of a JSON-RPC error object (the parts that are present), or the error text. */
function describeRpcError(error: unknown): string {
  let text: string;
  if (isRecord(error)) {
    const cause = isRecord(error.cause) ? error.cause : {};
    const data =
      typeof error.data === "string"
        ? error.data
        : JSON.stringify(error.data ?? cause.info ?? null);
    text = [error.name, cause.name, error.message, data]
      .filter(
        (part): part is string => typeof part === "string" && part.length > 0 && part !== "null",
      )
      .join(": ");
  } else {
    text = typeof error === "string" ? error : String(JSON.stringify(error));
  }
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;
}

function describeNetworkError(error: unknown, timeoutMs: number): string {
  if (!(error instanceof Error)) return `network error: ${String(error)}`;
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return `network error: timed out after ${timeoutMs}ms`;
  }
  // undici hides the code of a refused connection, a DNS failure or a TLS failure in `cause`.
  const cause: unknown = error.cause;
  const detail = isRecord(cause)
    ? typeof cause.code === "string" && cause.code.length > 0
      ? cause.code
      : typeof cause.message === "string" && cause.message.length > 0
        ? cause.message
        : undefined
    : undefined;
  return detail === undefined || detail === error.message
    ? `network error: ${error.message}`
    : `network error: ${error.message} (${detail})`;
}

/**
 * A minimal fetch client: one URL, no retries (use the SDK's RpcClient for failover). Signs nothing. Each call is
 * one POST of `{ jsonrpc: "2.0", id, method, params }`, cut off after `timeoutMs` (default 15000). It resolves to
 * `result`; it throws NearRpcError for a JSON-RPC error, a legacy `result.error` string, an HTTP status other than
 * 2xx, a network failure or a timeout, and NearFormatError for a body that is not a JSON object with a `result`.
 * Throws TypeError at once for a URL that is not http(s) or a timeout that is not a positive integer.
 */
export function httpJsonRpc(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): NearRpc {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    // The URL is not repeated: it may carry an API key.
    throw new TypeError("httpJsonRpc: the RPC url is not a valid URL");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new TypeError(`httpJsonRpc: the RPC url must be http or https, got ${endpoint.protocol}`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`httpJsonRpc: timeoutMs must be a positive integer, got ${timeoutMs}`);
  }
  // Origin only in messages: an RPC URL may carry an API key in its path, query or userinfo.
  const shown = endpoint.origin;
  let nextId = 1;

  return {
    async call<T = unknown>(method: string, params: unknown): Promise<T> {
      // Looked up per call, so a fetch installed after the client was made (a test guard, a polyfill) is used.
      const doFetch = opts.fetch ?? globalThis.fetch;
      const id = `probarion-near-${nextId}`;
      nextId += 1;
      let response: Response;
      let text: string;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        throw new NearRpcError(
          method,
          null,
          `${method}: ${describeNetworkError(error, timeoutMs)} (${shown})`,
          { cause: error },
        );
      }
      let parsed: unknown;
      let isJson = true;
      try {
        parsed = JSON.parse(text);
      } catch {
        isJson = false;
      }
      const rpcError =
        isJson && isRecord(parsed) && parsed.error !== undefined && parsed.error !== null
          ? parsed.error
          : null;
      if (!response.ok) {
        const detail = rpcError === null ? "" : `: ${describeRpcError(rpcError)}`;
        throw new NearRpcError(
          method,
          rpcError,
          `${method}: HTTP ${response.status}${detail} (${shown})`,
        );
      }
      if (rpcError !== null) {
        throw new NearRpcError(
          method,
          rpcError,
          `${method}: ${describeRpcError(rpcError)} (${shown})`,
        );
      }
      if (!isJson) {
        throw new NearFormatError("response", `${method}: the answer from ${shown} is not JSON`);
      }
      if (!isRecord(parsed) || !("result" in parsed)) {
        throw new NearFormatError(
          "response",
          `${method}: the answer from ${shown} is not a JSON-RPC response with a result`,
        );
      }
      const result = parsed.result;
      // nearcore's legacy `query` failure: HTTP 200, `result: { error: "...", logs, block_height, block_hash }`.
      if (isRecord(result) && typeof result.error === "string") {
        throw new NearRpcError(
          method,
          result,
          `${method}: ${describeRpcError(result.error)} (${shown})`,
        );
      }
      return result as T;
    },
  };
}
