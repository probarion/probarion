import { describe, expect, it } from "vitest";
import { NearFormatError } from "../src/errors.js";
import { httpJsonRpc, NearRpcError } from "../src/rpc.js";

interface SeenRequest {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
}

/** A fetch that answers from `reply` and records every request (no network). */
function fakeFetch(reply: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url: String(input), init, body });
    return reply(body);
  }) as typeof fetch;
  return { fetchFn, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An RPC URL with an API key in its path and query, as some providers issue them. */
const KEYED_URL = "https://rpc.example.test/v1/k3y-in-path?apikey=s3cr3t";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("httpJsonRpc", () => {
  it("POSTs one JSON-RPC 2.0 request and resolves to the result", async () => {
    const { fetchFn, seen } = fakeFetch((body) =>
      json({ jsonrpc: "2.0", id: body.id, result: { header: { height: 7 } } }),
    );
    const rpc = httpJsonRpc("https://rpc.example.test", { fetch: fetchFn });
    expect(await rpc.call("block", { finality: "final" })).toEqual({ header: { height: 7 } });
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.url).toBe("https://rpc.example.test");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.body).toEqual({
      jsonrpc: "2.0",
      id: expect.any(String),
      method: "block",
      params: { finality: "final" },
    });
  });

  it("gives every request its own id", async () => {
    const { fetchFn, seen } = fakeFetch((body) => json({ jsonrpc: "2.0", id: body.id, result: 1 }));
    const rpc = httpJsonRpc("https://rpc.example.test", { fetch: fetchFn });
    await rpc.call("status", []);
    await rpc.call("status", []);
    expect(new Set(seen.map((r) => r.body.id)).size).toBe(2);
  });

  it("sends to the full URL but names only its origin in errors", async () => {
    const { fetchFn, seen } = fakeFetch(() =>
      json({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", message: "boom" } }),
    );
    const rpc = httpJsonRpc(KEYED_URL, { fetch: fetchFn });
    const error = await rejection(rpc.call("tx", {}));
    expect(seen[0]?.url).toBe(KEYED_URL);
    expect(error).toBeInstanceOf(NearRpcError);
    const message = (error as Error).message;
    expect(message).toContain("https://rpc.example.test");
    expect(message).not.toContain("k3y-in-path");
    expect(message).not.toContain("s3cr3t");
  });

  it("throws NearRpcError with the raw error for a JSON-RPC error answer", async () => {
    const rpcError = {
      name: "HANDLER_ERROR",
      cause: { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: "abc" } },
      code: -32000,
      message: "Server error",
      data: "Transaction abc doesn't exist",
    };
    const { fetchFn } = fakeFetch(() => json({ jsonrpc: "2.0", id: "x", error: rpcError }));
    const error = await rejection(
      httpJsonRpc("https://rpc.example.test", { fetch: fetchFn }).call("tx", {}),
    );
    expect(error).toBeInstanceOf(NearRpcError);
    const e = error as NearRpcError;
    expect(e.name).toBe("NearRpcError");
    expect(e.method).toBe("tx");
    expect(e.rpcError).toEqual(rpcError);
    expect(e.message).toBe(
      "tx: HANDLER_ERROR: UNKNOWN_TRANSACTION: Server error: Transaction abc doesn't exist (https://rpc.example.test)",
    );
  });

  it("throws NearRpcError for nearcore's legacy HTTP 200 result.error, keeping the whole result", async () => {
    const result = {
      error: "access key ed25519:abc does not exist while viewing",
      logs: [],
      block_height: 10,
      block_hash: "h",
    };
    const { fetchFn } = fakeFetch(() => json({ jsonrpc: "2.0", id: "x", result }));
    const error = await rejection(
      httpJsonRpc("https://rpc.example.test", { fetch: fetchFn }).call("query", {}),
    );
    expect(error).toBeInstanceOf(NearRpcError);
    expect((error as NearRpcError).rpcError).toEqual(result);
    expect((error as Error).message).toContain("does not exist while viewing");
  });

  it("throws NearRpcError for an HTTP status other than 2xx, with the body's JSON-RPC error when it has one", async () => {
    const timeout = { name: "TIMEOUT_ERROR", message: "Timeout" };
    const cases: Array<[Response, unknown, RegExp]> = [
      [json({ jsonrpc: "2.0", id: "x", error: timeout }, 408), timeout, /HTTP 408: TIMEOUT_ERROR/],
      [new Response("<html>bad gateway</html>", { status: 502 }), null, /^block: HTTP 502 \(/],
      [json({}, 429), null, /HTTP 429/],
    ];
    for (const [response, rpcError, message] of cases) {
      const { fetchFn } = fakeFetch(() => response);
      const error = await rejection(
        httpJsonRpc("https://rpc.example.test", { fetch: fetchFn }).call("block", {}),
      );
      expect(error).toBeInstanceOf(NearRpcError);
      expect((error as NearRpcError).rpcError).toEqual(rpcError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain("bad gateway");
    }
  });

  it("throws NearRpcError with the cause for a network failure, and names a timeout", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const failing = (async () => {
      throw refused;
    }) as typeof fetch;
    const error = await rejection(
      httpJsonRpc(KEYED_URL, { fetch: failing }).call("block", { finality: "final" }),
    );
    expect(error).toBeInstanceOf(NearRpcError);
    expect((error as NearRpcError).rpcError).toBeNull();
    expect((error as Error).cause).toBe(refused);
    expect((error as Error).message).toBe(
      "block: network error: fetch failed (ECONNREFUSED) (https://rpc.example.test)",
    );

    // A fetch that waits for the abort signal, so the timeout is what ends it.
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason));
      })) as typeof fetch;
    const timedOut = await rejection(
      httpJsonRpc("https://rpc.example.test", { fetch: hanging, timeoutMs: 20 }).call("block", {}),
    );
    expect(timedOut).toBeInstanceOf(NearRpcError);
    expect((timedOut as Error).message).toBe(
      "block: network error: timed out after 20ms (https://rpc.example.test)",
    );
  });

  it("throws NearFormatError for a body that is not JSON, not an object, or has no result", async () => {
    const bodies: Array<[Response, RegExp]> = [
      [new Response("<html>ok</html>", { status: 200 }), /is not JSON/],
      [json([1, 2]), /not a JSON-RPC response with a result/],
      [json({ jsonrpc: "2.0", id: "x" }), /not a JSON-RPC response with a result/],
      [json("result"), /not a JSON-RPC response with a result/],
    ];
    for (const [response, message] of bodies) {
      const { fetchFn } = fakeFetch(() => response);
      const error = await rejection(httpJsonRpc(KEYED_URL, { fetch: fetchFn }).call("block", {}));
      expect(error).toBeInstanceOf(NearFormatError);
      expect((error as NearFormatError).what).toBe("response");
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain("s3cr3t");
    }
  });

  it("resolves a null result and a result that holds a non-string error field", async () => {
    for (const result of [null, { error: { nested: true } }, []]) {
      const { fetchFn } = fakeFetch(() => json({ jsonrpc: "2.0", id: "x", result }));
      expect(
        await httpJsonRpc("https://rpc.example.test", { fetch: fetchFn }).call("x", {}),
      ).toEqual(result);
    }
  });

  it("uses the global fetch by default, which the unit-test guard refuses", async () => {
    const error = await rejection(
      httpJsonRpc("https://rpc.mainnet.fastnear.com").call("block", {}),
    );
    expect(error).toBeInstanceOf(NearRpcError);
    expect((error as Error).message).toMatch(/network access is disabled in unit tests/);
  });

  it("refuses a URL that is not http(s), and a timeout that is not a positive integer, without echoing the URL", () => {
    expect(() => httpJsonRpc("not a url ?apikey=s3cr3t")).toThrow(TypeError);
    expect(() => httpJsonRpc("not a url ?apikey=s3cr3t")).not.toThrow(/s3cr3t/);
    expect(() => httpJsonRpc("ftp://rpc.example.test")).toThrow(/http or https/);
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => httpJsonRpc("https://rpc.example.test", { timeoutMs })).toThrow(TypeError);
    }
  });
});
