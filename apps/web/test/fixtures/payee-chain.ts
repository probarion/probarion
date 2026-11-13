// A scripted JSON-RPC fetch for the /check tests (a TEST DOUBLE, R20: no socket is opened): NEAR's final and archival
// reads, a vault's mandates and spends, and Base's two calls, answered by method the way the public nodes answer. It
// ignores the URL, so the page's real default hosts show in what the page records.

const NO_CODE = "11111111111111111111111111111111";
export const CODE_A = "55E7imniT2uuYrECn17qJAk9fLcwQW4ftNSwmCJL5Di";

// Two headers 100,000 blocks apart at 0.6 s a block: 7 days back is 1,008,000 blocks below the top.
export const TOP = 300_000_000;
const TOP_NS = 1_794_000_000_000_000_000n;
const SAMPLE = TOP - 100_000;
const SAMPLE_NS = TOP_NS - 100_000n * 600_000_000n;
export const WEEK_AGO = TOP - 1_008_000;

export interface Call {
  url: string;
  method: string;
  params: Record<string, unknown> & unknown[];
}

export interface ChainScript {
  /** NEAR accounts at the final block: id to code hash (absent: no account). */
  accounts?: Record<string, string>;
  /** NEAR accounts at the block about 7 days back; defaults to `accounts`. */
  weekAgo?: Record<string, string>;
  mandates?: unknown[];
  spends?: unknown[];
  /** Base: address (lowercase) to code and nonce. */
  base?: Record<string, { code: string; nonce: string }>;
}

const rpcError = (cause: string, data = "") => ({
  error: {
    name: "HANDLER_ERROR",
    cause: { name: cause, info: {} },
    code: -32000,
    message: "Server error",
    data,
  },
});

function answer(script: ChainScript, { method, params }: Call): unknown {
  if (method === "block") {
    if (params.finality === "final")
      return { result: { header: { height: TOP, timestamp_nanosec: TOP_NS.toString() } } };
    if (params.block_id === SAMPLE) {
      return { result: { header: { height: SAMPLE, timestamp_nanosec: SAMPLE_NS.toString() } } };
    }
    return rpcError("UNKNOWN_BLOCK");
  }
  if (method === "query" && params.request_type === "view_account") {
    const id = String(params.account_id);
    const book =
      typeof params.block_id === "number" ? (script.weekAgo ?? script.accounts) : script.accounts;
    const code = book?.[id];
    if (code === undefined)
      return rpcError("UNKNOWN_ACCOUNT", `account ${id} does not exist while viewing`);
    return { result: { amount: "1", locked: "0", code_hash: code, storage_usage: 182 } };
  }
  if (method === "query" && params.request_type === "call_function") {
    const rows = params.method_name === "list_mandates" ? script.mandates : script.spends;
    const bytes = [...new TextEncoder().encode(JSON.stringify(rows ?? []))];
    return { result: { result: bytes, logs: [], block_height: TOP } };
  }
  const address = String(params[0]).toLowerCase();
  const base = script.base?.[address] ?? { code: "0x", nonce: "0x0" };
  if (method === "eth_getCode") return { result: base.code };
  if (method === "eth_getTransactionCount") return { result: base.nonce };
  return { error: { code: -32601, message: "method not found" } };
}

/** A fetch that answers from `script`, and the calls it was sent. */
export function scriptedChain(script: ChainScript = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: string;
      method: string;
      params: Call["params"];
    };
    const call = { url: String(input), method: body.method, params: body.params };
    calls.push(call);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(answer(script, call) as object) }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A fetch whose every request fails before an answer, as a blocked or unreachable node does. */
export const unreachable = (async () => {
  throw new TypeError("Failed to fetch");
}) as typeof globalThis.fetch;

/** A fetch that every node answers with HTTP 429, as a rate-limited public node does. */
export const rateLimited = (async () =>
  new Response("slow down", { status: 429 })) as typeof globalThis.fetch;

/**
 * Shaped like v0.probarion.near in a live read on 2026-11-13: mandate 1 pays a NEAR account and mandates 2 and 3 a
 * Base address; one spend was paid to the first and two were burned to the second. The spend ids are made up.
 */
export const MAINNET_HISTORY = {
  mandates: [
    { id: 1, payee: { type: "near", account_id: "probarion-duong.near" } },
    {
      id: 2,
      payee: {
        type: "intents",
        chain: "base",
        address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
      },
    },
    {
      id: 3,
      payee: {
        type: "intents",
        chain: "base",
        address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
      },
    },
  ],
  spends: [
    { id: 0, status: "paid", destination: { type: "near", account_id: "probarion-duong.near" } },
    {
      id: 1,
      status: "burned",
      destination: {
        type: "intents",
        chain: "base",
        address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
      },
    },
    {
      id: 2,
      status: "burned",
      destination: {
        type: "intents",
        chain: "base",
        address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
      },
    },
  ],
} satisfies Pick<ChainScript, "mandates" | "spends">;

export { NO_CODE };
