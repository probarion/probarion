import { RpcMalformedError } from "@probarion/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as { msg: string; fields: Record<string, unknown> }[]);
vi.mock("@/lib/log", async (orig) => ({
  ...(await orig<typeof import("@/lib/log")>()),
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields: Record<string, unknown>) => logged.push({ msg, fields }),
  },
}));

import { ensureChain, forgetVerifiedChains, WrongChainError } from "./chain";

// W-NET-R4, W-NET-R5: the two paths that create lasting state, sign-in and Register, first check that the network's RPC
// serves the network's chain. The RPC client fails over from URL to URL, so the check asks EVERY URL of the list, each on
// its own. The nodes are a fetch that answers per URL; nothing leaves the machine.
const A = "https://rpc.a.example";
const B = "https://secret-key@rpc.b.example/abc123";
const C = "https://rpc.c.example";

type Answer = "down" | unknown;

/** A fetch answering `status` per URL. `down` is a 503; any other value is the `result` of the call. */
function nodes(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const bodies: { method: string; params: unknown }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown };
    asked.push(url);
    bodies.push({ method: body.method, params: body.params });
    if (!(url in answers)) throw new Error(`unexpected url ${url}`);
    const a = answers[url];
    if (a === "down") return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: a }), {
      status: 200,
    });
  }) as typeof fetch;
  // One try per URL and no sleeping: a URL that is down fails at once.
  return { answers, asked, bodies, opts: { fetch: f, maxRounds: 1, sleep: async () => {} } };
}
const chain = (chain_id: unknown) => ({ chain_id, protocol_version: 73 });

beforeEach(() => {
  forgetVerifiedChains();
  logged.length = 0;
});

describe("ensureChain, one URL", () => {
  it.each(["mainnet", "testnet"] as const)(
    "passes when the %s RPC answers for its own chain, asking JSON-RPC status with no params",
    async (network) => {
      const n = nodes({ [A]: chain(network) });
      await expect(ensureChain(network, [A], n.opts)).resolves.toBeUndefined();
      expect(n.asked).toEqual([A]);
      expect(n.bodies).toEqual([{ method: "status", params: [] }]);
    },
  );

  it.each([
    ["mainnet", "testnet"],
    ["testnet", "mainnet"],
  ] as const)("throws WrongChainError when the %s RPC answers for %s", async (network, answers) => {
    const n = nodes({ [A]: chain(answers) });
    const error = await ensureChain(network, [A], n.opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WrongChainError);
    expect((error as WrongChainError).network).toBe(network);
  });

  it("compares the chain id exactly: Mainnet, a trailing space or a longer name is another chain", async () => {
    for (const id of ["Mainnet", "MAINNET", "mainnet ", "mainnet-2", "mainnet\u0000", "testnet"]) {
      const n = nodes({ [A]: chain(id) });
      await expect(ensureChain("mainnet", [A], n.opts), id).rejects.toBeInstanceOf(WrongChainError);
    }
  });

  it("treats an answer it cannot read as a failure of the RPC, never a pass and never a wrong chain", async () => {
    for (const bad of [
      null,
      {},
      { chain_id: 1 },
      { chain_id: "" },
      { chain_id: null },
      "mainnet",
      ["mainnet"],
    ]) {
      const n = nodes({ [A]: bad });
      const error = await ensureChain("mainnet", [A], n.opts).catch((e: unknown) => e);
      expect(error, JSON.stringify(bad)).toBeInstanceOf(RpcMalformedError);
      expect(error).not.toBeInstanceOf(WrongChainError);
    }
    // Nothing was remembered by any of them.
    const ok = nodes({ [A]: chain("mainnet") });
    await ensureChain("mainnet", [A], ok.opts);
    expect(ok.asked).toEqual([A]);
  });

  it("is not a pass when there is no URL to ask", async () => {
    const n = nodes({});
    await expect(ensureChain("mainnet", [], n.opts)).rejects.toThrow(/no RPC URL/);
  });
});

describe("ensureChain, every URL of the list (RR1-CHAIN-1)", () => {
  it("fails a mixed list on the first check, whichever position the wrong URL has", async () => {
    // The client fails over from URL to URL, so a list whose first URL is the right chain is served by the other chain
    // after one 429 from it. The check asks every URL: a mixed list never passes.
    for (const urls of [
      [A, B],
      [B, A],
      [A, B, C],
    ]) {
      forgetVerifiedChains();
      const n = nodes({ [A]: chain("mainnet"), [B]: chain("testnet"), [C]: chain("mainnet") });
      const error = await ensureChain("mainnet", urls, n.opts).catch((e: unknown) => e);
      expect(error, urls.join()).toBeInstanceOf(WrongChainError);
      // Every URL was asked, each on its own.
      expect([...n.asked].sort()).toEqual([...urls].sort());
    }
  });

  it("names the network, the variable and the position in the log, and never a URL", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: chain("testnet") });
    await ensureChain("mainnet", [A, B], n.opts).catch(() => {});
    expect(logged).toEqual([
      {
        msg: "chain.wrong",
        fields: { network: "mainnet", variable: "NEAR_RPC_URLS_MAINNET", entry: 2 },
      },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/secret-key|abc123|rpc\.b\.example|rpc\.a\.example/);
  });

  it("passes when every URL answers for the network, then asks nobody again", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: chain("mainnet"), [C]: chain("mainnet") });
    await ensureChain("mainnet", [A, B, C], n.opts);
    expect([...n.asked].sort()).toEqual([A, B, C].sort());
    n.asked.length = 0;
    await ensureChain("mainnet", [A, B, C], n.opts);
    await ensureChain("mainnet", [A, B, C], n.opts);
    expect(n.asked).toEqual([]);
  });

  it("asks a URL that is listed twice once", async () => {
    const n = nodes({ [A]: chain("testnet") });
    await ensureChain("testnet", [A, A, A], n.opts);
    expect(n.asked).toEqual([A]);
  });

  it("is not a pass while a URL has not answered, and then asks only the URLs that have not answered yet", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: "down", [C]: chain("mainnet") });
    const first = await ensureChain("mainnet", [A, B, C], n.opts).catch((e: unknown) => e);
    // A failure to check, the RPC's own: never a WrongChainError, and nothing is logged as wrong.
    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBeInstanceOf(WrongChainError);
    expect(logged).toEqual([]);
    expect([...n.asked].sort()).toEqual([A, B, C].sort());

    // B is still down: only B is asked again (A and C answered correctly once), and it is still no pass.
    n.asked.length = 0;
    await expect(ensureChain("mainnet", [A, B, C], n.opts)).rejects.toBeInstanceOf(Error);
    expect(n.asked).toEqual([B]);

    // B comes up: only B is asked, and now the network passes and is remembered.
    n.answers[B] = chain("mainnet");
    n.asked.length = 0;
    await ensureChain("mainnet", [A, B, C], n.opts);
    expect(n.asked).toEqual([B]);
    n.asked.length = 0;
    await ensureChain("mainnet", [A, B, C], n.opts);
    expect(n.asked).toEqual([]);
  });

  it("fails as a wrong chain, not as a transient failure, when one URL is the other chain and another is down", async () => {
    const n = nodes({ [A]: "down", [B]: chain("testnet") });
    const error = await ensureChain("mainnet", [A, B], n.opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WrongChainError);
  });

  it("keeps what the right URLs answered when another is the wrong chain, and picks up a corrected setting", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: chain("testnet") });
    await expect(ensureChain("mainnet", [A, B], n.opts)).rejects.toBeInstanceOf(WrongChainError);
    n.asked.length = 0;
    await expect(ensureChain("mainnet", [A, B], n.opts)).rejects.toBeInstanceOf(WrongChainError);
    expect(n.asked).toEqual([B]);
    // The list is corrected (B now serves mainnet): the next check passes.
    n.answers[B] = chain("mainnet");
    n.asked.length = 0;
    await ensureChain("mainnet", [A, B], n.opts);
    expect(n.asked).toEqual([B]);
  });

  it("keeps the networks apart: a pass for testnet says nothing about mainnet", async () => {
    const t = nodes({ [A]: chain("testnet") });
    await ensureChain("testnet", [A], t.opts);
    const m = nodes({ [A]: chain("testnet") });
    await expect(ensureChain("mainnet", [A], m.opts)).rejects.toBeInstanceOf(WrongChainError);
    expect(m.asked).toEqual([A]);
  });

  it("does not take a node's error answer for a chain", async () => {
    // A JSON-RPC error (not a transport failure) from the URL: the network is not verified.
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            name: "HANDLER_ERROR",
            cause: { name: "UNKNOWN_BLOCK", info: {} },
            code: -32000,
            message: "x",
          },
        }),
      );
    }) as typeof fetch;
    const error = await ensureChain("testnet", [A], {
      fetch: f,
      maxRounds: 1,
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WrongChainError);
  });
});
