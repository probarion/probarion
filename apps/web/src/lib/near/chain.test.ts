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

// W-NET-R4, R5, R6: the two paths that create lasting state, sign-in and Register, first check that the network's RPC
// serves the network's chain. The RPC client fails over from URL to URL, so the check asks EVERY URL of the list, each on
// its own. A request goes on when at least one URL has answered with the right chain and none has answered with another;
// a URL that has not answered is asked again on each later check, and the network is remembered as passed only once every
// URL has answered right. The nodes are a fetch that answers per URL; nothing leaves the machine.
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
/** The network's list as the settings give it: the URLs, and the variable that supplied them. */
const list = (urls: readonly string[], rpcUrlsVariable = "NEAR_RPC_URLS_MAINNET") => ({
  rpcUrls: urls,
  rpcUrlsVariable,
});

beforeEach(() => {
  forgetVerifiedChains();
  logged.length = 0;
});

describe("ensureChain, one URL", () => {
  it.each(["mainnet", "testnet"] as const)(
    "passes when the %s RPC answers for its own chain, asking JSON-RPC status with no params",
    async (network) => {
      const n = nodes({ [A]: chain(network) });
      await expect(ensureChain(network, list([A]), n.opts)).resolves.toBeUndefined();
      expect(n.asked).toEqual([A]);
      expect(n.bodies).toEqual([{ method: "status", params: [] }]);
    },
  );

  it.each([
    ["mainnet", "testnet"],
    ["testnet", "mainnet"],
  ] as const)("throws WrongChainError when the %s RPC answers for %s", async (network, answers) => {
    const n = nodes({ [A]: chain(answers) });
    const error = await ensureChain(network, list([A]), n.opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WrongChainError);
    expect((error as WrongChainError).network).toBe(network);
  });

  it("compares the chain id exactly: Mainnet, a trailing space or a longer name is another chain", async () => {
    for (const id of ["Mainnet", "MAINNET", "mainnet ", "mainnet-2", "mainnet\u0000", "testnet"]) {
      const n = nodes({ [A]: chain(id) });
      await expect(ensureChain("mainnet", list([A]), n.opts), id).rejects.toBeInstanceOf(
        WrongChainError,
      );
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
      const error = await ensureChain("mainnet", list([A]), n.opts).catch((e: unknown) => e);
      expect(error, JSON.stringify(bad)).toBeInstanceOf(RpcMalformedError);
      expect(error).not.toBeInstanceOf(WrongChainError);
    }
    // Nothing was remembered by any of them.
    const ok = nodes({ [A]: chain("mainnet") });
    await ensureChain("mainnet", list([A]), ok.opts);
    expect(ok.asked).toEqual([A]);
  });

  it("is not a pass when there is no URL to ask", async () => {
    const n = nodes({});
    await expect(ensureChain("mainnet", list([]), n.opts)).rejects.toThrow(/no RPC URL/);
  });

  it("is `unavailable`, the RPC's own error, when the only URL does not answer, and asks it again next time", async () => {
    const n = nodes({ [A]: "down" });
    const first = await ensureChain("mainnet", list([A]), n.opts).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBeInstanceOf(WrongChainError);
    n.answers[A] = chain("mainnet");
    n.asked.length = 0;
    await ensureChain("mainnet", list([A]), n.opts);
    expect(n.asked).toEqual([A]);
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
      const error = await ensureChain("mainnet", list(urls), n.opts).catch((e: unknown) => e);
      expect(error, urls.join()).toBeInstanceOf(WrongChainError);
      // Every URL was asked, each on its own.
      expect([...n.asked].sort()).toEqual([...urls].sort());
    }
  });

  it("passes when every URL answers for the network, then asks nobody again", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: chain("mainnet"), [C]: chain("mainnet") });
    await ensureChain("mainnet", list([A, B, C]), n.opts);
    expect([...n.asked].sort()).toEqual([A, B, C].sort());
    n.asked.length = 0;
    await ensureChain("mainnet", list([A, B, C]), n.opts);
    await ensureChain("mainnet", list([A, B, C]), n.opts);
    expect(n.asked).toEqual([]);
  });

  it("asks a URL that is listed twice once", async () => {
    const n = nodes({ [A]: chain("testnet") });
    await ensureChain("testnet", list([A, A, A]), n.opts);
    expect(n.asked).toEqual([A]);
  });

  it("fails as a wrong chain, not as a transient failure, when one URL is the other chain and another is down", async () => {
    const n = nodes({ [A]: "down", [B]: chain("testnet") });
    const error = await ensureChain("mainnet", list([A, B]), n.opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WrongChainError);
  });

  it("keeps what the right URLs answered when another is the wrong chain, and picks up a corrected setting", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: chain("testnet") });
    await expect(ensureChain("mainnet", list([A, B]), n.opts)).rejects.toBeInstanceOf(
      WrongChainError,
    );
    n.asked.length = 0;
    await expect(ensureChain("mainnet", list([A, B]), n.opts)).rejects.toBeInstanceOf(
      WrongChainError,
    );
    expect(n.asked).toEqual([B]);
    // The list is corrected (B now serves mainnet): the next check passes.
    n.answers[B] = chain("mainnet");
    n.asked.length = 0;
    await ensureChain("mainnet", list([A, B]), n.opts);
    expect(n.asked).toEqual([B]);
  });

  it("keeps the networks apart: a pass for testnet says nothing about mainnet", async () => {
    const t = nodes({ [A]: chain("testnet") });
    await ensureChain("testnet", list([A], "NEAR_RPC_URLS_TESTNET"), t.opts);
    const m = nodes({ [A]: chain("testnet") });
    await expect(ensureChain("mainnet", list([A]), m.opts)).rejects.toBeInstanceOf(WrongChainError);
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
    const error = await ensureChain("testnet", list([A], "NEAR_RPC_URLS_TESTNET"), {
      fetch: f,
      maxRounds: 1,
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WrongChainError);
  });
});

// W-NET-R6: once a provider retires a backup URL, sign-in and Register keep working. The request goes on when at least one URL
// has answered right and none has answered wrong; the URL that has not answered is asked again on every later check, so the
// round-2 attack stays closed, and the network is remembered as passed only when every URL has answered right.
describe("ensureChain, a URL that does not answer (W-NET-R6)", () => {
  it("lets the request go on when one URL is down and one is right, and does not remember the network as passed", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: "down" });
    await expect(ensureChain("mainnet", list([A, B]), n.opts)).resolves.toBeUndefined();
    expect([...n.asked].sort()).toEqual([A, B].sort());
    // Not cached: the next check asks the silent URL again (and only it), and still lets the request go on.
    for (let i = 0; i < 3; i++) {
      n.asked.length = 0;
      await expect(ensureChain("mainnet", list([A, B]), n.opts)).resolves.toBeUndefined();
      expect(n.asked, `check ${i + 2}`).toEqual([B]);
    }
    expect(logged).toEqual([]);
  });

  it("refuses the next request when the URL that was down comes up on the other chain", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: "down" });
    await ensureChain("mainnet", list([A, B]), n.opts);
    n.answers[B] = chain("testnet");
    n.asked.length = 0;
    await expect(ensureChain("mainnet", list([A, B]), n.opts)).rejects.toBeInstanceOf(
      WrongChainError,
    );
    expect(n.asked).toEqual([B]);
    // And it keeps refusing while it stays wrong.
    n.asked.length = 0;
    await expect(ensureChain("mainnet", list([A, B]), n.opts)).rejects.toBeInstanceOf(
      WrongChainError,
    );
    expect(n.asked).toEqual([B]);
  });

  it("remembers the network as passed once the URL that was down comes up on the right chain", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: "down", [C]: "down" });
    await ensureChain("mainnet", list([A, B, C]), n.opts);
    n.answers[B] = chain("mainnet");
    n.asked.length = 0;
    await ensureChain("mainnet", list([A, B, C]), n.opts);
    expect([...n.asked].sort()).toEqual([B, C].sort()); // C is still down: not yet remembered
    n.answers[C] = chain("mainnet");
    n.asked.length = 0;
    await ensureChain("mainnet", list([A, B, C]), n.opts);
    expect(n.asked).toEqual([C]);
    n.asked.length = 0;
    await ensureChain("mainnet", list([A, B, C]), n.opts);
    expect(n.asked).toEqual([]); // every URL has answered right: cached
  });

  it("answers `unavailable`, the RPC's own error, when no URL answers at all", async () => {
    const n = nodes({ [A]: "down", [B]: "down" });
    const error = await ensureChain("mainnet", list([A, B]), n.opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WrongChainError);
    expect(logged).toEqual([]);
    // Both are asked again, and once one answers right the request goes on.
    n.answers[A] = chain("mainnet");
    n.asked.length = 0;
    await expect(ensureChain("mainnet", list([A, B]), n.opts)).resolves.toBeUndefined();
    expect([...n.asked].sort()).toEqual([A, B].sort());
  });

  it("counts a URL that answered right in an earlier check, so a later check with the others silent still goes on", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: chain("mainnet") });
    await ensureChain("mainnet", list([A]), n.opts); // an earlier check, of a shorter list: A is on record
    n.answers[A] = "down"; // never asked again: it has answered right
    n.answers[B] = "down";
    n.asked.length = 0;
    await expect(ensureChain("mainnet", list([A, B]), n.opts)).resolves.toBeUndefined();
    expect(n.asked).toEqual([B]);
  });

  it("goes on with a URL that answers unreadably next to a right one, and asks it again", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: { chain_id: null } });
    await expect(ensureChain("mainnet", list([A, B]), n.opts)).resolves.toBeUndefined();
    n.asked.length = 0;
    await ensureChain("mainnet", list([A, B]), n.opts);
    expect(n.asked).toEqual([B]);
  });

  it("does not log a URL that did not answer as wrong", async () => {
    const n = nodes({ [A]: chain("testnet"), [B]: "down" });
    await ensureChain("mainnet", list([A, B]), n.opts).catch(() => {});
    // Only A, which answered for the other chain, is logged, by position: never B, and never a URL.
    expect(logged).toEqual([
      {
        msg: "chain.wrong",
        fields: { network: "mainnet", variable: "NEAR_RPC_URLS_MAINNET", entry: 1 },
      },
    ]);
  });
});

// W-NET-R6: the log names the variable that supplied the list, as the settings report it.
describe("ensureChain, the log of a wrong chain", () => {
  it("names the network, the variable and the position, and never a URL", async () => {
    const n = nodes({ [A]: chain("mainnet"), [B]: chain("testnet") });
    await ensureChain("mainnet", list([A, B]), n.opts).catch(() => {});
    expect(logged).toEqual([
      {
        msg: "chain.wrong",
        fields: { network: "mainnet", variable: "NEAR_RPC_URLS_MAINNET", entry: 2 },
      },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/secret-key|abc123|rpc\.b\.example|rpc\.a\.example/);
  });

  it.each([
    ["NEAR_RPC_URLS_TESTNET", "the suffixed variable supplied the list"],
    ["NEAR_RPC_URLS", "the unsuffixed variable supplied the default network's list"],
  ])("names %s when %s", async (variable) => {
    const n = nodes({ [A]: chain("mainnet") });
    await ensureChain("testnet", list([A], variable), n.opts).catch(() => {});
    expect(logged).toEqual([
      { msg: "chain.wrong", fields: { network: "testnet", variable, entry: 1 } },
    ]);
  });
});
