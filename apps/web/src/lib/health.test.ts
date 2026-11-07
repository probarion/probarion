import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedProbe,
  clearHealthCache,
  type FetchLike,
  HEALTH_CACHE_MS,
  judgeStatus,
  MAX_BLOCK_LAG_S,
  NEARAI_PROBE_NAME,
  type Probe,
  parseProvider,
  probeNearAi,
  probeNearRpc,
  providerName,
} from "./health";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const now = () => NOW;
const status = (sync: Record<string, unknown> = {}, chain = "testnet") => ({
  jsonrpc: "2.0",
  id: "health",
  result: {
    chain_id: chain,
    sync_info: {
      latest_block_height: 123,
      latest_block_time: "2026-11-07T11:59:57.123456789Z",
      syncing: false,
      ...sync,
    },
  },
});
const answering =
  (body: unknown, code = 200): FetchLike =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code });

beforeEach(() => clearHealthCache());

describe("judgeStatus", () => {
  it("passes a node of the right chain whose last block is fresh", () => {
    expect(judgeStatus("testnet", status(), NOW)).toEqual({
      ok: true,
      detail: "block 123, 3 s behind",
    });
  });

  it("fails a node of the other chain, and never repeats what it answered", () => {
    expect(judgeStatus("testnet", status({}, "<b>evil</b>"), NOW)).toEqual({
      ok: false,
      detail: "wrong chain",
    });
    expect(judgeStatus("mainnet", status(), NOW).detail).toBe("wrong chain");
  });

  it("fails a syncing node and a stale one, and accepts a lag of exactly the limit", () => {
    expect(judgeStatus("testnet", status({ syncing: true }), NOW)).toEqual({
      ok: false,
      detail: "syncing: block 123",
    });
    expect(
      judgeStatus("testnet", status({ latest_block_time: "2026-11-07T11:56:40.000Z" }), NOW),
    ).toEqual({ ok: false, detail: "stale: block 123, 200 s behind" });
    const edge = new Date(NOW - MAX_BLOCK_LAG_S * 1000).toISOString();
    expect(judgeStatus("testnet", status({ latest_block_time: edge }), NOW).ok).toBe(true);
  });

  it("names a malformed answer with a fixed string", () => {
    expect(judgeStatus("testnet", "nope", NOW).detail).toBe("malformed status answer");
    expect(judgeStatus("testnet", { result: {} }, NOW).detail).toBe("malformed status answer");
    expect(judgeStatus("testnet", { error: { message: "https://key@rpc" } }, NOW).detail).toBe(
      "rpc error",
    );
    expect(judgeStatus("testnet", { result: { chain_id: "testnet" } }, NOW).detail).toBe(
      "no sync_info in the status response",
    );
  });
});

describe("probeNearRpc", () => {
  it("sends one JSON-RPC status call, uncached, and reports the block", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(status()));
    };
    const probe = await probeNearRpc("testnet", "https://rpc.testnet.fastnear.com", "n", {
      fetch,
      now,
    });
    expect(probe).toEqual({ name: "n", ok: true, latency_ms: 0, detail: "block 123, 3 s behind" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.method).toBe("POST");
    expect(calls[0]?.[1]?.cache).toBe("no-store");
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      jsonrpc: "2.0",
      id: "health",
      method: "status",
      params: [],
    });
  });

  it("reports an HTTP error by its code, and a body that is not JSON as malformed", async () => {
    expect(
      (await probeNearRpc("testnet", "u", "n", { fetch: answering("x", 502), now })).detail,
    ).toBe("HTTP 502");
    expect(
      (await probeNearRpc("testnet", "u", "n", { fetch: answering("<html>"), now })).detail,
    ).toBe("malformed status answer");
  });

  it("reports a network failure without its message", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND key-123.rpc.example");
    };
    const probe = await probeNearRpc("testnet", "u", "n", { fetch, now });
    expect(probe).toMatchObject({ ok: false, detail: "network error" });
    expect(JSON.stringify(probe)).not.toContain("key-123");
  });

  it("gives up after the timeout", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const probe = await probeNearRpc("testnet", "u", "n", { fetch, timeoutMs: 10 });
    expect(probe).toMatchObject({ ok: false, detail: "timeout after 10 ms" });
  });
});

describe("probeNearAi", () => {
  const CATALOG = {
    models: [
      {
        modelId: "a",
        metadata: {
          providerType: "vllm",
          attestationSupported: true,
          verifiable: true,
          supportedFeatures: ["structured_outputs"],
        },
      },
      { modelId: "b", metadata: {} },
    ],
    total: 2,
  };

  it("reads one page of the public list, sends no key, and counts the attested models", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(CATALOG));
    };
    const probe = await probeNearAi("https://cloud-api.near.ai/v1/", { fetch, now });
    expect(probe).toEqual({
      name: NEARAI_PROBE_NAME,
      ok: true,
      latency_ms: 0,
      detail: "2 model(s) listed, 1 with attestation and structured output",
    });
    expect(calls[0]?.[0]).toBe("https://cloud-api.near.ai/v1/model/list?limit=100&offset=0");
    expect(JSON.stringify(calls[0]?.[1]?.headers ?? {})).not.toMatch(/authorization/i);
  });

  it("fails when nothing is listed or the answer is not a catalog", async () => {
    expect((await probeNearAi("https://x", { fetch: answering({ models: [] }), now })).detail).toBe(
      "no models listed",
    );
    expect((await probeNearAi("https://x", { fetch: answering({ data: [] }), now })).detail).toBe(
      "malformed catalog answer",
    );
  });
});

describe("providerName", () => {
  it("shows the host of a built-in URL, and only the variable and place of any other", () => {
    expect(providerName("mainnet", "https://rpc.intea.rs", 1, "NEAR_RPC_URLS_MAINNET")).toBe(
      "rpc.intea.rs",
    );
    expect(
      providerName("testnet", "https://my-key.rpc.example.com/v1", 1, "NEAR_RPC_URLS_TESTNET"),
    ).toBe("NEAR_RPC_URLS_TESTNET entry 2");
    // A mainnet built-in URL is not a built-in of testnet.
    expect(
      providerName("testnet", "https://rpc.mainnet.fastnear.com", 0, "NEAR_RPC_URLS_TESTNET"),
    ).toBe("NEAR_RPC_URLS_TESTNET entry 1");
  });
});

describe("parseProvider", () => {
  it("reads 0 when missing, one or two digits as an index, and anything else as -1", () => {
    expect(parseProvider(null)).toBe(0);
    expect(parseProvider("1")).toBe(1);
    expect(parseProvider("42")).toBe(42);
    for (const bad of ["", "abc", "-1", "100", "1.5", " 1"])
      expect(parseProvider(bad), bad).toBe(-1);
  });
});

describe("cachedProbe", () => {
  const down: Probe = { name: "n", ok: false, latency_ms: 1, detail: "network error" };

  it("runs once per key within the window, failures included, and again after it", async () => {
    let t = 0;
    const run = vi.fn(async () => down);
    const opts = { now: () => t };
    await cachedProbe("k", "n", run, opts);
    t = HEALTH_CACHE_MS - 1;
    expect(await cachedProbe("k", "n", run, opts)).toEqual(down);
    expect(run).toHaveBeenCalledTimes(1);
    t = HEALTH_CACHE_MS;
    await cachedProbe("k", "n", run, opts);
    expect(run).toHaveBeenCalledTimes(2);
    await cachedProbe("other", "n", run, opts);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("turns a probe that throws into a fixed failure", async () => {
    const out = await cachedProbe("t", NEARAI_PROBE_NAME, async () => {
      throw new Error("secret detail");
    });
    expect(out).toEqual({
      name: NEARAI_PROBE_NAME,
      ok: false,
      latency_ms: 0,
      detail: "probe failed",
    });
  });
});
