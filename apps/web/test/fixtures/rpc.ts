// Test doubles for the console's chain reads. Two layers, both built on @probarion/sdk:
//
//  - Scripted: `fakeFetch` answers the SDK RpcClient's requests from a list of canned responses
//    (`rpcOk`, `rpcErr`, `httpStatus`, `viewBytes`). Use it for failover, retries and error mapping,
//    where the exact sequence of HTTP answers is the thing under test.
//  - Chain-backed: `startChainRpc` runs the SDK's fake JSON-RPC server (`@probarion/sdk/testing`) on
//    127.0.0.1 over a FakeChain, so reads see the response shapes of a real node.
//
// Nothing here leaves the machine: the scripted layer never opens a socket, the server layer only
// listens on loopback (the no-network setup, R20, lets loopback through).
import { RpcClient, type RpcClientOptions, RpcError, ViewError } from "@probarion/sdk";
import {
  createScenarioChain,
  type FakeChain,
  type FakeRpcServer,
  startFakeRpcServer,
} from "@probarion/sdk/testing";

export interface RpcBody {
  method: string;
  params: Record<string, unknown>;
}

export type Handler = (url: string, body: RpcBody) => Response | Promise<Response>;

export interface FakeFetch {
  f: typeof fetch;
  calls: { url: string; body: RpcBody }[];
  /** Handlers not used yet: a test that expects every scripted answer to be consumed asserts `remaining() === 0`. */
  remaining(): number;
}

/** A fetch that answers request n with handler n. A request beyond the script throws, and is still recorded. */
export function fakeFetch(handlers: Handler[]): FakeFetch {
  const queue = [...handlers];
  const calls: FakeFetch["calls"] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body)) as RpcBody;
    calls.push({ url, body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected RPC call: ${JSON.stringify(body)}`);
    return next(url, body);
  }) as typeof fetch;
  return { f, calls, remaining: () => queue.length };
}

export const rpcOk =
  (result: unknown): Handler =>
  () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "pb", result }), { status: 200 });

/** A JSON-RPC error answer: `name` is the top-level error name, `cause` the specific cause (nearcore's shape). */
export const rpcErr =
  (cause: string, name = "HANDLER_ERROR"): Handler =>
  () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "pb",
        error: { name, cause: { name: cause, info: {} }, code: -32000, message: "Server error" },
      }),
      { status: 200 },
    );

export const httpStatus =
  (status: number, headers: Record<string, string> = {}): Handler =>
  () =>
    new Response("busy", { status, headers });

/** The result of a `call_function` query that returned `value` as JSON. */
export const viewBytes = (value: unknown) => ({
  result: [...Buffer.from(JSON.stringify(value))],
  logs: [],
  block_height: 1,
  block_hash: "h",
});

/** A `view_account` result in the shape of a node; override fields to test malformed answers. */
export const accountResult = (overrides: Record<string, unknown> = {}) => ({
  amount: "10000000000000000000000000",
  locked: "0",
  code_hash: "11111111111111111111111111111111",
  storage_usage: 2048,
  storage_paid_at: 0,
  block_height: 1,
  block_hash: "h",
  ...overrides,
});

/** An SDK RpcClient wired to a scripted fetch, with no real sleeping. `sleeps` records each backoff. */
export function scriptedRpc(
  handlers: Handler[],
  urls: string[] = ["https://a.example", "https://b.example"],
  opts: Partial<RpcClientOptions> = {},
) {
  const ff = fakeFetch(handlers);
  const sleeps: number[] = [];
  const rpc = new RpcClient({
    urls,
    fetch: ff.f,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts,
  });
  return { rpc, calls: ff.calls, sleeps, remaining: ff.remaining };
}

export interface ChainRpc {
  rpc: RpcClient;
  server: FakeRpcServer;
  chain: FakeChain;
  close(): Promise<void>;
}

/**
 * The SDK's fake JSON-RPC server over a FakeChain (the testnet scenario vault by default), and an
 * RpcClient pointed at it. Always `await close()` (afterEach/afterAll) so the loopback port is freed.
 */
export async function startChainRpc(
  chain: FakeChain = createScenarioChain(),
  opts: Partial<RpcClientOptions> = {},
): Promise<ChainRpc> {
  const server = await startFakeRpcServer(chain);
  const rpc = new RpcClient({ urls: [server.url], sleep: async () => {}, ...opts });
  return { rpc, server, chain, close: () => server.close() };
}

/**
 * The error the reader raises when the chain gives a definite answer about the target (a missing
 * account, no contract code, a missing method). Same class and fields a real read produces.
 */
export function contractError(cause = "UNKNOWN_ACCOUNT", contractId = "v.near"): ViewError {
  return new ViewError(contractId, "get_config", `HANDLER_ERROR: ${cause}`, {
    rpcError: { name: "HANDLER_ERROR", cause: { name: cause, info: {} }, code: -32000 },
  });
}

/** The error the reader raises when no provider answered. */
export function transportError(): RpcError {
  return new RpcError(
    "query: all 2 RPC endpoint(s) failed after 4 attempts (tried https://a.example, https://b.example); last error: HTTP 503",
    [{ url: "https://b.example", error: "HTTP 503" }],
  );
}
