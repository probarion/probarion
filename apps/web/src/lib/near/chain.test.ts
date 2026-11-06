import type { RpcClient } from "@probarion/sdk";
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

import { forgetVerifiedChains, verifiedChain, verifiedRpc, WrongChainError } from "./chain";

// W-NET-R4 to R7: sign-in, Register and the approvers re-sync talk to the network's nodes only through a client built from
// the URLs that have answered JSON-RPC `status` with the network's own chain. Every URL is asked on its own. A URL that
// answers with another chain is wrong for the life of the process, and a later right answer does not clear it. A URL that
// does not answer (or answers in a way that says nothing) is unknown: it is asked again on each later check, and no
// request can reach it until it has answered right. The nodes below are a fetch that answers per URL; nothing leaves the
// machine.
const A = "https://rpc.a.example";
const B = "https://secret-key@rpc.b.example/abc123";
const C = "https://rpc.c.example";

/** How a URL answers `status`: a chain id, or one of the ways of not saying. */
type Status = string | "down" | "http400" | "rpcerror" | "nochain" | "429";

/**
 * A fetch answering per URL. `status` decides what `status` says; `queryDown` URLs answer a query with 429; any other query is
 * answered with `{ from: <url> }`, so a test can see which URL a call reached.
 */
function nodes(status: Record<string, Status>) {
  const seen: { url: string; method: string }[] = [];
  const queryDown = new Set<string>();
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown };
    seen.push({ url, method: body.method });
    if (!(url in status)) throw new Error(`unexpected url ${url}`);
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    if (body.method !== "status") {
      if (queryDown.has(url)) return new Response("busy", { status: 429 });
      return ok({ from: url });
    }
    const s = status[url];
    if (s === "down" || s === "429") {
      return new Response("busy", { status: s === "429" ? 429 : 503 });
    }
    if (s === "http400") return new Response("bad request", { status: 400 });
    if (s === "rpcerror") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            name: "REQUEST_VALIDATION_ERROR",
            cause: { name: "METHOD_NOT_FOUND", info: {} },
            code: -32601,
            message: "Method not found",
          },
        }),
      );
    }
    if (s === "nochain") return ok({ version: {} });
    return ok({ chain_id: s, protocol_version: 73 });
  }) as typeof fetch;
  // One try per URL and no sleeping: a URL that is down fails at once.
  const opts = { fetch: f, maxRounds: 1, sleep: async () => {} };
  const asked = (method?: string) =>
    seen.filter((s) => method === undefined || s.method === method).map((s) => s.url);
  return {
    status,
    queryDown,
    opts,
    seen,
    asked,
    forget: () => {
      seen.length = 0;
    },
  };
}
type Nodes = ReturnType<typeof nodes>;

/** The network's list as the settings give it: the URLs, and the variable that supplied them. */
const list = (urls: readonly string[], rpcUrlsVariable = "NEAR_RPC_URLS_MAINNET") => ({
  rpcUrls: urls,
  rpcUrlsVariable,
});
/** The URL a query through `rpc` reached, or why it failed. */
const reaches = async (rpc: RpcClient) => {
  try {
    return ((await rpc.call("query", {})) as { from: string }).from;
  } catch (e) {
    return `failed (${(e as Error).name})`;
  }
};
const check = (n: Nodes, urls: readonly string[], network: "mainnet" | "testnet" = "mainnet") =>
  verifiedRpc(network, list(urls), n.opts);

beforeEach(() => {
  forgetVerifiedChains();
  logged.length = 0;
});

describe("verifiedRpc, one URL", () => {
  it.each(["mainnet", "testnet"] as const)(
    "gives a client for the %s RPC when it answers for its own chain, asking JSON-RPC status with no params",
    async (network) => {
      const n = nodes({ [A]: network });
      const rpc = await check(n, [A], network);
      expect(n.asked()).toEqual([A]);
      expect(await reaches(rpc)).toBe(A);
    },
  );

  it.each([
    ["mainnet", "testnet"],
    ["testnet", "mainnet"],
  ] as const)("throws WrongChainError when the %s RPC answers for %s", async (network, answers) => {
    const n = nodes({ [A]: answers });
    const error = await check(n, [A], network).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WrongChainError);
    expect((error as WrongChainError).network).toBe(network);
  });

  it("compares the chain id exactly: Mainnet, a trailing space or a longer name is another chain", async () => {
    for (const id of ["Mainnet", "MAINNET", "mainnet ", "mainnet-2", "mainnet\u0000", "testnet"]) {
      forgetVerifiedChains();
      const n = nodes({ [A]: id });
      await expect(check(n, [A]), id).rejects.toBeInstanceOf(WrongChainError);
    }
  });

  it("is `unavailable`, never a client and never a wrong chain, when the URL answers in a way that says nothing", async () => {
    for (const s of ["down", "429", "http400", "rpcerror", "nochain"] as const) {
      forgetVerifiedChains();
      const n = nodes({ [A]: s });
      const error = await check(n, [A]).catch((e: unknown) => e);
      expect(error, s).toBeInstanceOf(Error);
      expect(error, s).not.toBeInstanceOf(WrongChainError);
      expect(logged, s).toEqual([]);
    }
  });

  it("treats an answer with no readable chain_id as a failure of the RPC (RpcMalformedError)", async () => {
    const n = nodes({ [A]: "nochain" });
    await expect(check(n, [A])).rejects.toBeInstanceOf(RpcMalformedError);
  });

  it("is not a client when there is no URL to ask", async () => {
    const n = nodes({});
    await expect(check(n, [])).rejects.toThrow(/no RPC URL/);
  });

  it("asks the URL again next time when it did not answer, and then gives the client", async () => {
    const n = nodes({ [A]: "down" });
    await expect(check(n, [A])).rejects.toBeInstanceOf(Error);
    n.status[A] = "mainnet";
    n.forget();
    const rpc = await check(n, [A]);
    expect(n.asked()).toEqual([A]);
    expect(await reaches(rpc)).toBe(A);
  });
});

describe("verifiedRpc, every URL of the list (RR1-CHAIN-1)", () => {
  it("fails a mixed list on the first check, whichever position the wrong URL has", async () => {
    // The client fails over from URL to URL, so a list whose first URL is the right chain is served by the other chain
    // after one 429 from it. Every URL is asked: a mixed list never gives a client.
    for (const urls of [
      [A, B],
      [B, A],
      [A, C, B],
      [A, B, C],
      [B, A, C],
      [C, A, B],
    ]) {
      forgetVerifiedChains();
      const n = nodes({ [A]: "mainnet", [B]: "testnet", [C]: "mainnet" });
      const error = await check(n, urls).catch((e: unknown) => e);
      expect(error, urls.join()).toBeInstanceOf(WrongChainError);
      expect([...n.asked()].sort(), urls.join()).toEqual([...urls].sort());
    }
  });

  it("gives a client that holds the whole list once every URL has answered right, then asks nobody again", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "mainnet", [C]: "mainnet" });
    const rpc = await check(n, [A, B, C]);
    expect([...n.asked("status")].sort()).toEqual([A, B, C].sort());
    // The whole list, in its order: A first; when A is busy the next is B, then C.
    n.forget();
    n.queryDown.add(A);
    n.queryDown.add(B);
    n.queryDown.add(C);
    expect(await reaches(rpc)).toBe("failed (RpcError)"); // maxRounds 1 in this test: one try per URL...
    expect(n.asked("query")).toEqual([A, B, C]); // ...and it tried them all, in order
    n.forget();
    await check(n, [A, B, C]);
    await check(n, [A, B, C]);
    expect(n.asked()).toEqual([]);
  });

  it("asks a URL that is listed twice once", async () => {
    const n = nodes({ [A]: "testnet" });
    await check(n, [A, A, A], "testnet");
    expect(n.asked()).toEqual([A]);
  });

  it("builds the client from the right URLs in their order in the list, whatever order they answered in", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "mainnet", [C]: "mainnet" });
    const rpc = await check(n, [C, A, B]);
    n.queryDown.add(C);
    n.queryDown.add(A);
    n.queryDown.add(B);
    n.forget();
    expect(await reaches(rpc)).toBe("failed (RpcError)");
    expect(n.asked("query")).toEqual([C, A, B]);
  });

  it("keeps the networks apart: a right answer for testnet says nothing about mainnet", async () => {
    const t = nodes({ [A]: "testnet" });
    await check(t, [A], "testnet");
    const m = nodes({ [A]: "testnet" });
    await expect(check(m, [A], "mainnet")).rejects.toBeInstanceOf(WrongChainError);
    expect(m.asked()).toEqual([A]);
  });

  it("keeps one URL from vouching for another: only its own answer counts", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "down" });
    await check(n, [A, B]);
    n.status[B] = "testnet";
    n.forget();
    await expect(check(n, [A, B])).rejects.toBeInstanceOf(WrongChainError);
    expect(n.asked()).toEqual([B]);
  });
});

// W-NET-R7. "A backup URL that is down does not stop sign-in" and "no URL that has not answered right can answer a request"
// are both kept by one rule: the request is served by a client built only from the URLs that have answered right.
describe("verifiedRpc, a URL that has not answered right (W-NET-R7)", () => {
  it("one URL down and one right: the client is built from the right one alone, and the down URL is asked again next time", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "down" });
    const first = await check(n, [A, B]);
    expect([...n.asked("status")].sort()).toEqual([A, B].sort());
    expect(await reaches(first)).toBe(A);
    // Never B: even with A busy the client has nowhere else to go.
    n.queryDown.add(A);
    n.forget();
    expect(await reaches(first)).toBe("failed (RpcError)");
    expect(n.asked("query")).toEqual([A]);

    // The next check asks only B, and the client is still A alone.
    n.queryDown.clear();
    n.forget();
    const second = await check(n, [A, B]);
    expect(n.asked()).toEqual([B]);
    expect(await reaches(second)).toBe(A);
    expect(logged).toEqual([]);
  });

  it("the down URL comes up right: the next client holds both, in list order, and then nobody is asked", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "down", [C]: "down" });
    await check(n, [A, B, C]);
    n.status[B] = "mainnet";
    n.forget();
    const two = await check(n, [A, B, C]);
    expect([...n.asked()].sort()).toEqual([B, C].sort()); // C is still down
    n.queryDown.add(A);
    n.queryDown.add(B);
    n.forget();
    await reaches(two);
    expect(n.asked("query")).toEqual([A, B]); // A then B, and never C
    n.queryDown.clear();
    n.status[C] = "mainnet";
    n.forget();
    const three = await check(n, [A, B, C]);
    expect(n.asked()).toEqual([C]);
    n.forget();
    await check(n, [A, B, C]);
    expect(n.asked()).toEqual([]); // every URL right: nobody is asked
    n.queryDown.add(A);
    n.queryDown.add(B);
    n.queryDown.add(C);
    n.forget();
    await reaches(three);
    expect(n.asked("query")).toEqual([A, B, C]);
  });

  it("no URL has answered right: `unavailable`, the RPC's own error, nothing logged, and every URL is asked again", async () => {
    const n = nodes({ [A]: "down", [B]: "down" });
    const error = await check(n, [A, B]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WrongChainError);
    expect(logged).toEqual([]);
    n.status[A] = "mainnet";
    n.forget();
    const rpc = await check(n, [A, B]);
    expect([...n.asked()].sort()).toEqual([A, B].sort());
    expect(await reaches(rpc)).toBe(A);
  });

  // RR2-CHAIN-3: B serves queries (and has the other chain's keys) but never says what chain it is. It is never in the client.
  it.each(["rpcerror", "http400", "nochain", "429"] as const)(
    "RR2-CHAIN-3: a URL whose status is %s but that serves queries is never reached, even after the first URL fails",
    async (mode) => {
      const n = nodes({ [A]: "mainnet", [B]: mode });
      for (let request = 1; request <= 3; request++) {
        const rpc = await check(n, [A, B]);
        n.forget();
        // A is busy in request 1 only; B would answer a query if it were reached.
        if (request === 1) n.queryDown.add(A);
        else n.queryDown.delete(A);
        const reached = await reaches(rpc);
        expect(reached, `request ${request}`).not.toBe(B);
        expect(n.asked("query"), `request ${request}`).not.toContain(B);
        expect(reached, `request ${request}`).toBe(request === 1 ? "failed (RpcError)" : A);
        n.forget();
      }
    },
  );
});

// W-NET-R7: a wrong answer is remembered until the process restarts.
describe("verifiedRpc, a URL that answered with another chain stays wrong", () => {
  // RR2-CHAIN-2: B is silent at the first check, then answers testnet, then is silent again (a free endpoint under load).
  it("RR2-CHAIN-2: wrong once means wrong for good: the check after it is a wrong chain even when the URL is silent again", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "429" });
    await check(n, [A, B]); // B silent: goes on, with A alone
    n.status[B] = "testnet";
    await expect(check(n, [A, B])).rejects.toBeInstanceOf(WrongChainError);
    n.status[B] = "429";
    n.forget();
    // Silent again, and still refused: nobody asks B, and B is never in a client.
    for (let i = 0; i < 3; i++) {
      await expect(check(n, [A, B]), `check ${i + 3}`).rejects.toBeInstanceOf(WrongChainError);
    }
    expect(n.asked()).not.toContain(B);
  });

  // RR2-CHAIN-2b: a pool with one stray backend, B answers testnet once and mainnet once.
  it("RR2-CHAIN-2b: wrong, then right stays wrong: a later right answer does not clear it", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "testnet" });
    await expect(check(n, [A, B])).rejects.toBeInstanceOf(WrongChainError);
    n.status[B] = "mainnet";
    n.forget();
    for (let i = 0; i < 3; i++) {
      await expect(check(n, [A, B]), `check ${i + 2}`).rejects.toBeInstanceOf(WrongChainError);
    }
    expect(n.asked()).not.toContain(B); // not even asked: it is wrong until the process restarts
  });

  it("is wrong for every request while another URL is right: a right URL never outvotes a wrong one", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "mainnet", [C]: "testnet" });
    for (let i = 0; i < 3; i++) {
      await expect(check(n, [A, B, C]), `check ${i + 1}`).rejects.toBeInstanceOf(WrongChainError);
    }
  });

  it("is remembered per network: a URL that is wrong for testnet does not make mainnet wrong", async () => {
    const t = nodes({ [A]: "mainnet" });
    await expect(check(t, [A], "testnet")).rejects.toBeInstanceOf(WrongChainError);
    const m = nodes({ [A]: "mainnet" });
    await expect(check(m, [A], "mainnet")).resolves.toBeDefined();
  });

  it("is forgotten when the process restarts (forgetVerifiedChains stands for that here)", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "testnet" });
    await expect(check(n, [A, B])).rejects.toBeInstanceOf(WrongChainError);
    forgetVerifiedChains();
    n.status[B] = "mainnet";
    n.forget();
    await expect(check(n, [A, B])).resolves.toBeDefined();
    expect([...n.asked()].sort()).toEqual([A, B].sort());
  });
});

describe("verifiedRpc, the log of a wrong chain", () => {
  it("names the network, the variable and the position, and never a URL", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "testnet" });
    await check(n, [A, B]).catch(() => {});
    expect(logged).toEqual([
      {
        msg: "chain.wrong",
        fields: { network: "mainnet", variable: "NEAR_RPC_URLS_MAINNET", entry: 2 },
      },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/secret-key|abc123|rpc\.b\.example|rpc\.a\.example/);
  });

  it("names the position in the variable as it is written, not in the list without duplicates", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "testnet", [C]: "mainnet" });
    await check(n, [A, A, B, C]).catch(() => {});
    expect(logged).toEqual([
      {
        msg: "chain.wrong",
        fields: { network: "mainnet", variable: "NEAR_RPC_URLS_MAINNET", entry: 3 },
      },
    ]);
    logged.length = 0;
    // And again at the next request, from what is remembered: the same position.
    await check(n, [A, A, B, C]).catch(() => {});
    expect(logged).toEqual([
      {
        msg: "chain.wrong",
        fields: { network: "mainnet", variable: "NEAR_RPC_URLS_MAINNET", entry: 3 },
      },
    ]);
  });

  it.each([
    ["NEAR_RPC_URLS_TESTNET", "the suffixed variable supplied the list"],
    ["NEAR_RPC_URLS", "the unsuffixed variable supplied the default network's list"],
  ])("names %s when %s", async (variable) => {
    const n = nodes({ [A]: "mainnet" });
    await verifiedRpc("testnet", list([A], variable), n.opts).catch(() => {});
    expect(logged).toEqual([
      { msg: "chain.wrong", fields: { network: "testnet", variable, entry: 1 } },
    ]);
  });
});

describe("verifiedChain: the reader and the client are built from the same checked URLs", () => {
  it("gives a reader whose every read goes through the client of the right URLs, and to no other", async () => {
    const n = nodes({ [A]: "mainnet", [B]: "429" });
    const { rpc, reader } = await verifiedChain("mainnet", list([A, B]), n.opts);
    n.forget();
    n.queryDown.add(A);
    // The reader reads through `rpc`: A is busy, and B (which never said what chain it is) is not tried.
    await reader.getConfig("v.near").catch(() => {});
    await rpc.call("query", {}).catch(() => {});
    expect(n.asked("query").length).toBeGreaterThan(0);
    expect(new Set(n.asked("query"))).toEqual(new Set([A]));
  });

  it("refuses with the same errors as the client: a wrong chain, and `unavailable` when no URL has answered right", async () => {
    await expect(
      verifiedChain("mainnet", list([A, B]), nodes({ [A]: "mainnet", [B]: "testnet" }).opts),
    ).rejects.toBeInstanceOf(WrongChainError);
    forgetVerifiedChains();
    const down = await verifiedChain("mainnet", list([A]), nodes({ [A]: "down" }).opts).catch(
      (e: unknown) => e,
    );
    expect(down).toBeInstanceOf(Error);
    expect(down).not.toBeInstanceOf(WrongChainError);
  });
});
