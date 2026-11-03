import { RpcClient, type RpcClientOptions } from "../../src/rpc.js";

export type Handler = (
  url: string,
  body: { method: string; params: Record<string, unknown> },
) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function bytesOf(value: unknown): number[] {
  return [...Buffer.from(JSON.stringify(value))];
}

/** A fetch that answers from a script: call n gets handler n, the last handler repeats. */
export function scripted(handlers: Handler[]) {
  const calls: { url: string; method: string; params: Record<string, unknown> }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    calls.push({ url, method: body.method, params: body.params });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (handler === undefined) throw new Error("no handler");
    return handler(url, body);
  };
  return { fetchFn, calls };
}

export function client(
  urls: string[],
  handlers: Handler[],
  sleeps: number[] = [],
  overrides: Partial<RpcClientOptions> = {},
) {
  const s = scripted(handlers);
  const rpc = new RpcClient({
    urls,
    fetch: s.fetchFn,
    maxRounds: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { rpc, calls: s.calls, sleeps };
}

export const ok =
  (result: unknown): Handler =>
  () =>
    json({ jsonrpc: "2.0", id: "1", result });
